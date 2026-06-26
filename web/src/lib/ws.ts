import type { ControlSurfaceSettings } from "./api";
import type { ConnectionState, WsMessage } from "./types";

type WsSubscriber = (message: WsMessage) => void;
type ConnectionSubscriber = (state: ConnectionState) => void;
type SessionSubscription = { piSessionId: string; eventTypes?: string[] };

const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 10_000;

const BACKOFF_BASE = 1_000;
const BACKOFF_MAX = 30_000;
const BACKOFF_JITTER = 500;
const MAX_RECONNECT_ATTEMPTS = 10;

export class FlitterbotWsClient {
  private getSettings: () => ControlSurfaceSettings;
  private socket: WebSocket | null = null;
  private subscribers = new Set<WsSubscriber>();
  private connectionSubscribers = new Set<ConnectionSubscriber>();
  private activeSessionSubscription: SessionSubscription | null = null;
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

  private transition(to: ConnectionState) {
    const from = this._connectionState;
    if (from === to) return;
    console.debug(`[ws] ${from} → ${to}`);
    this._connectionState = to;
    for (const fn of this.connectionSubscribers) fn(to);
  }

  connect() {
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
      this.flushSessionSubscription();
    };

    this.socket.onmessage = (event) => {
      this.resetHeartbeatTimeout();
      try {
        const message = JSON.parse(event.data as string) as WsMessage;
        if ((message as { type: string }).type === "pong") return;
        for (const fn of this.subscribers) fn(message);
      } catch {}
    };

    this.socket.onclose = () => {
      this.socket = null;
      this.stopHeartbeat();
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

  disconnect() {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.unlistenVisibility();
    this.closeSocket();
    this.reconnectAttempt = 0;
    this.transition("disconnected");
  }

  reconnect() {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.unlistenVisibility();
    this.closeSocket();
    this.reconnectAttempt = 0;
    this._connectionState = "disconnected"; // force state so connect() guard passes
    this.connect();
  }

  private closeSocket() {
    const s = this.socket;
    if (!s) return;
    this.socket = null;
    // No-op handlers (not null) keep the browser dispatching close/error events so the close handshake completes; nulling them leaves sockets "Pending"
    s.onclose = () => {};
    s.onerror = () => {};
    s.onmessage = null;
    s.onopen = null;
    if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
      s.close();
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;

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
      this._connectionState = "disconnected"; // force state so connect() guard passes
      this.connect();
    }, delay);
  }

  // ponytail: visibility ping duplicates heartbeat timeout logic; collapse to one ping/watchdog helper.
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

  async sendMessage(
    text: string,
    deliveryMode: string,
    options?: {
      images?: Array<{ data: string; mimeType: string }>;
      targetPiSessionId?: string;
      clientMessageId?: string;
    },
  ): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    const payload: Record<string, unknown> = { type: "message", text, deliveryMode };
    if (options?.images?.length) payload.images = options.images;
    if (options?.targetPiSessionId) payload.targetPiSessionId = options.targetPiSessionId;
    if (options?.clientMessageId) payload.clientMessageId = options.clientMessageId;
    this.socket.send(JSON.stringify(payload));
  }

  setSessionSubscription(piSessionId: string, eventTypes?: string[]): void {
    const next: SessionSubscription = {
      piSessionId,
      eventTypes: normalizeEventTypes(eventTypes),
    };
    const previous = this.activeSessionSubscription;

    if (
      previous &&
      previous.piSessionId === next.piSessionId &&
      sameEventTypes(previous.eventTypes, next.eventTypes)
    ) {
      return;
    }

    this.activeSessionSubscription = next;

    if (previous && previous.piSessionId !== next.piSessionId) {
      this.sendUnsubscribe(previous.piSessionId);
    }
    this.sendSubscribe(next.piSessionId, next.eventTypes);
  }

  clearSessionSubscription(): void {
    const previous = this.activeSessionSubscription;
    if (!previous) return;
    this.activeSessionSubscription = null;
    this.sendUnsubscribe(previous.piSessionId);
  }

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

  private flushSessionSubscription() {
    if (!this.activeSessionSubscription) return;
    this.sendSubscribe(
      this.activeSessionSubscription.piSessionId,
      this.activeSessionSubscription.eventTypes,
    );
  }

  private sendSubscribe(piSessionId: string, eventTypes?: string[]) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, unknown> = { type: "subscribe", piSessionId };
    if (eventTypes && eventTypes.length > 0) payload.eventTypes = eventTypes;
    this.socket.send(JSON.stringify(payload));
  }

  private sendUnsubscribe(piSessionId: string) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "unsubscribe", piSessionId }));
  }
}

function normalizeEventTypes(eventTypes?: string[]): string[] | undefined {
  if (!eventTypes || eventTypes.length === 0) return undefined;
  return Array.from(new Set(eventTypes)).sort();
}

function sameEventTypes(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
