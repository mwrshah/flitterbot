import type { DeliveryMode } from "./control-surface-api.ts";
import type {
  ChatTimelineMessage,
  ChatTimelineTool,
  ImageAttachment,
  MessageSource,
} from "./timeline.ts";

export const CONTROL_SURFACE_WS_PATH = "/ws";

export interface WebSocketClientMessageEvent {
  type: "message";
  text: string;
  deliveryMode?: DeliveryMode;
  images?: ImageAttachment[];
  targetPiSessionId?: string;
  /** Per-message model override (id from `config.models[]`). */
  modelId?: string;
}

export interface WebSocketClientSubscribeEvent {
  type: "subscribe";
  piSessionId: string;
  /** If provided, only deliver events of these types for this subscription. Omit for all. */
  eventTypes?: string[];
}

export interface WebSocketClientUnsubscribeEvent {
  type: "unsubscribe";
  piSessionId: string;
}

export interface WebSocketClientPingEvent {
  type: "ping";
}

export type ControlSurfaceWebSocketClientEvent =
  | WebSocketClientMessageEvent
  | WebSocketClientSubscribeEvent
  | WebSocketClientUnsubscribeEvent
  | WebSocketClientPingEvent;

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
  piSessionId?: string;
  streamId?: string;
}

export interface QueueItemEndWebSocketEvent {
  type: "queue_item_end";
  itemId: string;
  error?: string;
  piSessionId?: string;
  streamId?: string;
}

export interface TextDeltaWebSocketEvent {
  type: "text_delta";
  piSessionId?: string;
  messageId: string;
  delta: string;
}

export interface MessageEndWebSocketEvent {
  type: "message_end";
  piSessionId?: string;
  message: ChatTimelineMessage;
  /** Tool calls extracted from the SDK message content array. */
  toolCalls?: Array<{ toolUseId: string; toolName: string; args?: unknown }>;
}

export interface ToolExecutionStartWebSocketEvent {
  type: "tool_execution_start";
  piSessionId?: string;
  tool?: string;
  toolUseId?: string;
  args?: unknown;
  timestamp?: string;
  event?: unknown;
}

export interface ToolExecutionEndWebSocketEvent {
  type: "tool_execution_end";
  piSessionId?: string;
  tool?: string;
  toolUseId?: string;
  result?: unknown;
  isError?: boolean;
  timestamp?: string;
  event?: unknown;
}

export interface ThinkingStartWebSocketEvent {
  type: "thinking_start";
  piSessionId?: string;
  messageId: string;
}

export interface ThinkingDeltaWebSocketEvent {
  type: "thinking_delta";
  piSessionId?: string;
  messageId: string;
  delta: string;
}

export interface ThinkingEndWebSocketEvent {
  type: "thinking_end";
  piSessionId?: string;
  messageId: string;
}

export interface ToolCallStartWebSocketEvent {
  type: "toolcall_start";
  piSessionId?: string;
  contentIndex: number;
  toolName?: string;
  toolUseId?: string;
}

export interface ToolExecutionUpdateWebSocketEvent {
  type: "tool_execution_update";
  piSessionId?: string;
  toolUseId?: string;
  partialResult?: unknown;
  timestamp?: string;
  event?: unknown;
}

export interface ToolResultWebSocketEvent {
  type: "tool_result";
  piSessionId?: string;
  item: ChatTimelineTool;
}

export interface TurnEndWebSocketEvent {
  type: "turn_end";
  piSessionId?: string;
  event?: unknown;
  timestamp?: string;
}

export interface StreamSurfacedWebSocketEvent {
  type: "stream_surfaced";
  message: ChatTimelineMessage;
  piSessionId?: string;
  streamId?: string;
  streamName?: string;
}

export interface StreamsChangedWebSocketEvent {
  type: "streams_changed";
  reason: "created" | "closed" | "reopened";
  streamId: string;
  streamName?: string;
}

export interface StatusChangedWebSocketEvent {
  type: "status_changed";
  /** Which subsystem changed — e.g. 'whatsapp', 'pi', 'blackboard' */
  subsystem: string;
  timestamp: string;
}

export interface PongWebSocketEvent {
  type: "pong";
}

export interface ErrorWebSocketEvent {
  type: "error";
  message: string;
}

export interface SessionsChangedWebSocketEvent {
  type: "sessions_changed";
  piSessionId: string;
  reason: "registered" | "ended" | "stopped";
}

export interface WorktreeChangedWebSocketEvent {
  type: "worktree_changed";
  piSessionId: string;
  streamId: string;
}

export interface MessageAckWebSocketEvent {
  type: "message_ack";
  serverMessageId: string;
  text: string;
  source: "web";
}

export interface ResourcesReloadedWebSocketEvent {
  type: "resources_reloaded";
}

export interface AgentStartWebSocketEvent {
  type: "agent_start";
  piSessionId?: string;
}

export interface AgentEndWebSocketEvent {
  type: "agent_end";
  piSessionId?: string;
  /** True when the agent run was aborted before message_end fired. */
  aborted?: boolean;
}

export interface TurnStartWebSocketEvent {
  type: "turn_start";
  piSessionId?: string;
}

export interface CompactionStartWebSocketEvent {
  type: "compaction_start";
  piSessionId?: string;
}

export interface CompactionEndWebSocketEvent {
  type: "compaction_end";
  piSessionId?: string;
}

export interface AutoRetryStartWebSocketEvent {
  type: "auto_retry_start";
  piSessionId?: string;
}

export interface AutoRetryEndWebSocketEvent {
  type: "auto_retry_end";
  piSessionId?: string;
}

/**
 * Emitted when server-side history is mutated non-append-only (e.g. a prune
 * operation that moves the session leaf backwards). Clients should invalidate
 * any cached history for the referenced piSessionId.
 */
export interface HistoryRewrittenWebSocketEvent {
  type: "history_rewritten";
  piSessionId: string;
  /** Reason for the rewrite. Currently only "prune" is emitted. */
  reason: "prune";
}

export type ControlSurfaceWebSocketServerEvent =
  | ConnectedWebSocketEvent
  | QueueItemStartWebSocketEvent
  | QueueItemEndWebSocketEvent
  | TextDeltaWebSocketEvent
  | ThinkingStartWebSocketEvent
  | ThinkingDeltaWebSocketEvent
  | ThinkingEndWebSocketEvent
  | ToolCallStartWebSocketEvent
  | MessageEndWebSocketEvent
  | ToolExecutionStartWebSocketEvent
  | ToolExecutionUpdateWebSocketEvent
  | ToolExecutionEndWebSocketEvent
  | ToolResultWebSocketEvent
  | TurnEndWebSocketEvent
  | TurnStartWebSocketEvent
  | AgentStartWebSocketEvent
  | AgentEndWebSocketEvent
  | CompactionStartWebSocketEvent
  | CompactionEndWebSocketEvent
  | AutoRetryStartWebSocketEvent
  | AutoRetryEndWebSocketEvent
  | HistoryRewrittenWebSocketEvent
  | StreamSurfacedWebSocketEvent
  | StreamsChangedWebSocketEvent
  | StatusChangedWebSocketEvent
  | SessionsChangedWebSocketEvent
  | WorktreeChangedWebSocketEvent
  | MessageAckWebSocketEvent
  | ResourcesReloadedWebSocketEvent
  | PongWebSocketEvent
  | ErrorWebSocketEvent;
