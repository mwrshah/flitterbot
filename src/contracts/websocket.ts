import type { DeliveryMode, MessageSource } from "./control-surface-api.ts";

export const CONTROL_SURFACE_WS_PATH = "/ws";

export interface ImageAttachment {
  data: string;
  mimeType: string;
}

export interface WebSocketClientMessageEvent {
  type: "message";
  text: string;
  deliveryMode?: DeliveryMode;
  images?: ImageAttachment[];
  targetSessionId?: string;
}

export interface WebSocketClientSubscribeEvent {
  type: "subscribe";
  sessionId: string;
}

export interface WebSocketClientUnsubscribeEvent {
  type: "unsubscribe";
  sessionId: string;
}

export type ControlSurfaceWebSocketClientEvent =
  | WebSocketClientMessageEvent
  | WebSocketClientSubscribeEvent
  | WebSocketClientUnsubscribeEvent;

export interface ConnectedWebSocketEvent {
  type: "connected";
  clientId: string;
}

type QueuedTurnSummary = {
  id: string;
  source: MessageSource;
  text: string;
  metadata?: Record<string, unknown>;
  receivedAt: string;
  webClientId?: string;
  deliveryMode?: DeliveryMode;
};

export interface QueueItemStartWebSocketEvent {
  type: "queue_item_start";
  item: QueuedTurnSummary;
  sessionId?: string;
  workstreamId?: string;
}

export interface QueueItemEndWebSocketEvent {
  type: "queue_item_end";
  itemId: string;
  error?: string;
  sessionId?: string;
  workstreamId?: string;
}

export interface MessageQueuedWebSocketEvent {
  type: "message_queued";
  itemId: string;
  queueDepth: number;
  sessionId?: string;
}

export interface TextDeltaWebSocketEvent {
  type: "text_delta";
  sessionId?: string;
  delta: string;
}

export interface MessageEndWebSocketEvent {
  type: "message_end";
  sessionId?: string;
  role: "user" | "assistant";
  content: string;
  source?: string;
  timestamp?: string;
}

export interface ToolExecutionStartWebSocketEvent {
  type: "tool_execution_start";
  sessionId?: string;
  tool?: string;
  toolUseId?: string;
  args?: unknown;
  timestamp?: string;
  event?: unknown;
}

export interface ToolExecutionEndWebSocketEvent {
  type: "tool_execution_end";
  sessionId?: string;
  tool?: string;
  toolUseId?: string;
  result?: unknown;
  isError?: boolean;
  timestamp?: string;
  event?: unknown;
}

export interface TurnEndWebSocketEvent {
  type: "turn_end";
  sessionId?: string;
  event?: unknown;
  timestamp?: string;
}

export interface PiSurfacedWebSocketEvent {
  type: "pi_surfaced";
  content: string;
  timestamp?: string;
  sessionId?: string;
  workstreamId?: string;
}

export type ControlSurfaceWebSocketServerEvent =
  | ConnectedWebSocketEvent
  | QueueItemStartWebSocketEvent
  | QueueItemEndWebSocketEvent
  | MessageQueuedWebSocketEvent
  | TextDeltaWebSocketEvent
  | MessageEndWebSocketEvent
  | ToolExecutionStartWebSocketEvent
  | ToolExecutionEndWebSocketEvent
  | TurnEndWebSocketEvent
  | PiSurfacedWebSocketEvent;
