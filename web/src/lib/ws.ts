import type {
  ControlSurfaceWebSocketServerEvent,
  ConversationEventPosition,
  WebSocketClientMessageEvent,
  WebSocketClientPingEvent,
  WebSocketClientSubscribeEvent,
  WebSocketClientUnsubscribeEvent,
} from "../../../src/contracts/websocket.ts";
import type { ControlSurfaceSettings } from "./api";
import type { ConnectionState } from "./types";

type WsSubscriber = (message: ControlSurfaceWebSocketServerEvent) => void;
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
  private resumePositionFor?: (piSessionId: string) => ConversationEventPosition | undefined;
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
        const message = JSON.parse(event.data as string) as ControlSurfaceWebSocketServerEvent;
        if (message.type === "pong") return;
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

    this.socket.onerror = () => {}; // onclose handles the transition
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
    const keepDispatchingUntilCloseHandshakeCompletes = () => {};
    s.onclose = keepDispatchingUntilCloseHandshakeCompletes;
    s.onerror = keepDispatchingUntilCloseHandshakeCompletes;
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

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        const ping: WebSocketClientPingEvent = { type: "ping" };
        this.socket.send(JSON.stringify(ping));
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
          const ping: WebSocketClientPingEvent = { type: "ping" };
          this.socket.send(JSON.stringify(ping));
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
    options?: Pick<WebSocketClientMessageEvent, "images" | "targetPiSessionId" | "clientMessageId">,
  ): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    const payload: WebSocketClientMessageEvent = {
      type: "message",
      text,
      ...options,
    };
    this.socket.send(JSON.stringify(payload));
  }

  setResumePositionProvider(
    provider: ((piSessionId: string) => ConversationEventPosition | undefined) | undefined,
  ): void {
    this.resumePositionFor = provider;
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

  resumeSessionSubscription(): void {
    this.flushSessionSubscription();
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
    const after = piSessionId === "*" ? undefined : this.resumePositionFor?.(piSessionId);
    const payload: WebSocketClientSubscribeEvent = {
      type: "subscribe",
      piSessionId,
      ...(eventTypes?.length ? { eventTypes } : {}),
      ...(after ? { after } : {}),
    };
    this.socket.send(JSON.stringify(payload));
  }

  private sendUnsubscribe(piSessionId: string) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const payload: WebSocketClientUnsubscribeEvent = { type: "unsubscribe", piSessionId };
    this.socket.send(JSON.stringify(payload));
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
