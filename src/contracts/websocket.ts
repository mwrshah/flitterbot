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
  images?: ImageAttachment[];
  targetPiSessionId?: string;
  modelId?: string;
  clientMessageId?: string;
}

export interface ConversationEventPosition {
  incarnation: string;
  sequence: number;
}

export interface WebSocketClientSubscribeEvent {
  type: "subscribe";
  piSessionId: string;
  eventTypes?: string[];
  after?: ConversationEventPosition;
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
  toolCalls?: Array<{
    toolUseId: string;
    toolName: string;
    args?: unknown;
    displayArgs?: unknown;
  }>;
}

export interface ToolExecutionStartWebSocketEvent {
  type: "tool_execution_start";
  piSessionId: string;
  tool: string;
  toolUseId: string;
  args: unknown;
  displayArgs?: unknown;
  timestamp: string;
}

export interface ToolExecutionEndWebSocketEvent {
  type: "tool_execution_end";
  piSessionId: string;
  tool: string;
  toolUseId: string;
  result: unknown;
  isError: boolean;
  timestamp: string;
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

export interface ToolExecutionUpdateWebSocketEvent {
  type: "tool_execution_update";
  piSessionId: string;
  toolUseId: string;
  partialResult: unknown;
  timestamp: string;
}

export interface ToolResultWebSocketEvent {
  type: "tool_result";
  piSessionId?: string;
  item: ChatTimelineTool;
}

export interface TurnEndWebSocketEvent {
  type: "turn_end";
  piSessionId: string;
  timestamp: string;
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
  reason: "created" | "closed" | "reopened" | "pinned" | "renamed" | "cwd_changed";
  streamId: string;
  streamName?: string;
}

export interface StatusChangedWebSocketEvent {
  type: "status_changed";
  subsystem: string;
  timestamp: string;
}

export interface PongWebSocketEvent {
  type: "pong";
}

export interface ErrorWebSocketEvent {
  type: "error";
  message: string;
  piSessionId?: string;
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

export interface HistoryRewrittenWebSocketEvent {
  type: "history_rewritten";
  piSessionId: string;
  reason: "prune" | "compact";
}

export interface ConversationResetWebSocketEvent {
  type: "conversation_reset";
  piSessionId: string;
  position: ConversationEventPosition;
  reason: "incarnation_changed" | "replay_expired";
}

type ControlSurfaceWebSocketServerEventPayload =
  | ConnectedWebSocketEvent
  | QueueItemStartWebSocketEvent
  | QueueItemEndWebSocketEvent
  | TextDeltaWebSocketEvent
  | ThinkingStartWebSocketEvent
  | ThinkingDeltaWebSocketEvent
  | ThinkingEndWebSocketEvent
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
  | ConversationResetWebSocketEvent
  | StreamSurfacedWebSocketEvent
  | StreamsChangedWebSocketEvent
  | StatusChangedWebSocketEvent
  | SessionsChangedWebSocketEvent
  | WorktreeChangedWebSocketEvent
  | ResourcesReloadedWebSocketEvent
  | PongWebSocketEvent
  | ErrorWebSocketEvent;

export type ControlSurfaceWebSocketServerEvent = ControlSurfaceWebSocketServerEventPayload & {
  position?: ConversationEventPosition;
};
