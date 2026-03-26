import type { ControlSurfaceSettings } from "./api";
import type { ConnectionState, WsMessage } from "./types";

type WsSubscriber = (message: WsMessage) => void;
type ConnectionSubscriber = (state: ConnectionState) => void;

// ── Heartbeat config ──
const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 10_000;

// ── Reconnect config ──
const BACKOFF_BASE = 1_000;
const BACKOFF_MAX = 30_000;
const BACKOFF_JITTER = 500;
const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Valid state transitions:
 *   DISCONNECTED  → CONNECTING    (connect)
 *   CONNECTING    → CONNECTED     (socket open)
 *   CONNECTING    → DISCONNECTED  (socket error/close, or construction failure)
 *   CONNECTING    → STUB          (construction failure with stub fallback)
 *   CONNECTED     → RECONNECTING  (socket close, heartbeat timeout)
 *   RECONNECTING  → CONNECTING    (backoff timer fires)
 *   RECONNECTING  → DISCONNECTED  (circuit breaker, or manual disconnect)
 *   CONNECTED     → DISCONNECTED  (manual disconnect)
 *   *             → DISCONNECTED  (manual disconnect always allowed)
 */
export class AutonomaWsClient {
  private getSettings: () => ControlSurfaceSettings;
  private socket: WebSocket | null = null;
  private subscribers = new Set<WsSubscriber>();
  private connectionSubscribers = new Set<ConnectionSubscriber>();
  private _connectionState: ConnectionState = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private boundVisibilityHandler: (() => void) | null = null;

  constructor(getSettings: () => ControlSurfaceSettings) {
    this.getSettings = getSettings;
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  // ── State machine ──

  private transition(to: ConnectionState) {
    const from = this._connectionState;
    if (from === to) return;
    console.debug(`[ws] ${from} → ${to}`);
    this._connectionState = to;
    for (const fn of this.connectionSubscribers) fn(to);
  }

  // ── Public API: connect / disconnect / reconnect ──

  connect() {
    // Guard: no-op if already connecting or connected
    if (this._connectionState === "connecting" || this._connectionState === "connected") {
      return;
    }

    this.clearReconnectTimer();
    this.closeSocket();

    const { baseUrl, token, useStubFallback } = this.getSettings();
    const wsUrl = baseUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const params = token ? `?token=${encodeURIComponent(token)}` : "";

    this.transition("connecting");

    try {
      this.socket = new WebSocket(`${wsUrl}/ws${params}`);
    } catch {
      this.transition(useStubFallback ? "stub" : "disconnected");
      return;
    }

    this.socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.transition("connected");
      this.startHeartbeat();
      this.listenVisibility();
      // Subscribe to all sessions on connect — no per-component subscription management
      this.socket?.send(JSON.stringify({ type: "subscribe", sessionId: "*" }));
    };

    this.socket.onmessage = (event) => {
      this.resetHeartbeatTimeout();
      try {
        const message = JSON.parse(event.data as string) as WsMessage;
        if ((message as { type: string }).type === "pong") return;
        for (const fn of this.subscribers) fn(message);
      } catch {
        // Ignore malformed messages
      }
    };

    this.socket.onclose = () => {
      // Clear stale reference — this socket is now CLOSED
      this.socket = null;
      this.stopHeartbeat();
      // If we were CONNECTED, transition to RECONNECTING (not DISCONNECTED)
      // If we were CONNECTING (never made it to open), go to DISCONNECTED and schedule
      if (this._connectionState === "connected") {
        this.scheduleReconnect();
      } else {
        this.transition("disconnected");
        this.scheduleReconnect();
      }
    };

    this.socket.onerror = () => {
      // onclose fires after onerror — let onclose handle the transition
    };
  }

  /** Manual disconnect — goes to DISCONNECTED, no auto-reconnect. */
  disconnect() {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.unlistenVisibility();
    this.closeSocket();
    this.reconnectAttempt = 0;
    this.transition("disconnected");
  }

  /** Manual reconnect — resets backoff and immediately connects. */
  reconnect() {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.unlistenVisibility();
    this.closeSocket();
    this.reconnectAttempt = 0;
    // Force state to disconnected so connect() guard passes
    this._connectionState = "disconnected";
    this.connect();
  }

  // ── Socket cleanup ──

  private closeSocket() {
    const s = this.socket;
    if (!s) return;
    // Dereference immediately so nothing else uses the stale socket
    this.socket = null;
    // Use no-op handlers (not null) so the browser can still dispatch
    // close/error events and complete the WebSocket close handshake.
    // Nulling handlers prevents event dispatch, leaving sockets "Pending".
    s.onclose = () => {};
    s.onerror = () => {};
    s.onmessage = null;
    s.onopen = null;
    if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
      s.close();
    }
  }

  // ── Reconnect with exponential backoff + jitter ──

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;

    // Circuit breaker: stop trying after maxAttempts
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(
        `[ws] circuit breaker: ${MAX_RECONNECT_ATTEMPTS} attempts exhausted, staying disconnected`,
      );
      this.transition("disconnected");
      return;
    }

    this.transition("reconnecting");

    const jitter = Math.random() * BACKOFF_JITTER;
    const delay = Math.min(BACKOFF_BASE * 2 ** this.reconnectAttempt + jitter, BACKOFF_MAX);
    this.reconnectAttempt++;

    console.debug(
      `[ws] reconnect attempt ${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay)}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Force state so connect() guard passes
      this._connectionState = "disconnected";
      this.connect();
    }, delay);
  }

  // ── Heartbeat ──

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "ping" }));
        if (!this.heartbeatTimeout) {
          this.heartbeatTimeout = setTimeout(() => {
            this.heartbeatTimeout = null;
            this.closeSocket();
            this.scheduleReconnect();
          }, HEARTBEAT_TIMEOUT);
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  private resetHeartbeatTimeout() {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  // ── Visibility ──

  private listenVisibility() {
    if (typeof document === "undefined") return;
    this.unlistenVisibility();
    this.boundVisibilityHandler = () => {
      if (document.visibilityState === "visible") {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
          this.reconnect();
        } else {
          this.socket.send(JSON.stringify({ type: "ping" }));
          if (!this.heartbeatTimeout) {
            this.heartbeatTimeout = setTimeout(() => {
              this.heartbeatTimeout = null;
              this.closeSocket();
              this.scheduleReconnect();
            }, HEARTBEAT_TIMEOUT);
          }
        }
      }
    };
    document.addEventListener("visibilitychange", this.boundVisibilityHandler);
  }

  private unlistenVisibility() {
    if (this.boundVisibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
  }

  // ── Messaging ──

  async sendMessage(
    text: string,
    deliveryMode: string,
    images?: Array<{ data: string; mimeType: string }>,
    targetSessionId?: string,
  ): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    const payload: Record<string, unknown> = { type: "message", text, deliveryMode };
    if (images?.length) payload.images = images;
    if (targetSessionId) payload.targetSessionId = targetSessionId;
    this.socket.send(JSON.stringify(payload));
  }

  /** @deprecated No-op — subscriptions are managed globally on connect. */
  subscribeSession(_sessionId: string, _eventTypes?: string[]): void {}

  /** @deprecated No-op — subscriptions are managed globally on connect. */
  unsubscribeSession(_sessionId: string): void {}

  subscribe(fn: WsSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  subscribeConnection(fn: ConnectionSubscriber): () => void {
    this.connectionSubscribers.add(fn);
    return () => {
      this.connectionSubscribers.delete(fn);
    };
  }
}
