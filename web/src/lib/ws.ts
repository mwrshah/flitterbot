import type { ControlSurfaceSettings } from "./api";
import type { ConnectionState, WsMessage } from "./types";

type WsSubscriber = (message: WsMessage) => void;
type ConnectionSubscriber = (state: ConnectionState) => void;

export class AutonomaWsClient {
  private getSettings: () => ControlSurfaceSettings;
  private socket: WebSocket | null = null;
  private subscribers = new Set<WsSubscriber>();
  private connectionSubscribers = new Set<ConnectionSubscriber>();
  private _connectionState: ConnectionState = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 3000;
  private static readonly MAX_RECONNECT_DELAY = 30000;

  constructor(getSettings: () => ControlSurfaceSettings) {
    this.getSettings = getSettings;
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  private setConnectionState(state: ConnectionState) {
    this._connectionState = state;
    for (const fn of this.connectionSubscribers) fn(state);
  }

  connect() {
    const { baseUrl, token, useStubFallback } = this.getSettings();
    const wsUrl = baseUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const params = token ? `?token=${encodeURIComponent(token)}` : "";

    this.setConnectionState("connecting");

    try {
      this.socket = new WebSocket(`${wsUrl}/ws${params}`);
    } catch {
      if (useStubFallback) {
        this.setConnectionState("stub");
      } else {
        this.setConnectionState("disconnected");
      }
      return;
    }

    this.socket.onopen = () => {
      this.reconnectDelay = 3000;
      this.setConnectionState("connected");
    };

    this.socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as WsMessage;
        for (const fn of this.subscribers) fn(message);
      } catch {
        // Ignore malformed messages
      }
    };

    this.socket.onclose = () => {
      this.setConnectionState("disconnected");
      this.scheduleReconnect();
    };

    this.socket.onerror = () => {
      // onclose will fire after onerror
    };
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.setConnectionState("disconnected");
  }

  reconnect() {
    this.disconnect();
    this.reconnectDelay = 3000;
    this.connect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.setConnectionState("reconnecting");
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      AutonomaWsClient.MAX_RECONNECT_DELAY,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  async sendMessage(
    text: string,
    deliveryMode: string,
    images?: Array<{ data: string; mimeType: string }>,
    targetSessionId?: string,
  ): Promise<void> {
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      throw new Error("WebSocket not connected");
    }
    const payload: Record<string, unknown> = { type: "message", text, deliveryMode };
    if (images?.length) payload.images = images;
    if (targetSessionId) payload.targetSessionId = targetSessionId;
    this.socket.send(JSON.stringify(payload));
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
}
