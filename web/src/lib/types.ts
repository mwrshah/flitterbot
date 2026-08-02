import type { SkillListItem, StatusResponse } from "../../../src/contracts/control-surface-api.ts";
import type { ChatTimelineMessage, ChatTimelineTool } from "../../../src/contracts/timeline.ts";

export type { PiSessionStatus } from "../../../src/contracts/blackboard.ts";
export type {
  AuthFlowPrompt,
  AuthFlowSnapshot,
  AuthProvider,
  AuthProviderMethod,
  AuthProvidersResponse,
  DirectoryCompletionItem,
  DirectoryCompletionsResponse,
  DirectSessionMessageResponse,
  DownstreamSessionItem,
  ModelListItem,
  ModelsListResponse,
  ModelsMutationResponse,
  PiSessionModelInfo,
  RuntimeWhatsAppControlResponse,
  SessionDetailResponse,
  SessionsListResponse,
  ShortcutBindingsConfig,
  SkillsListResponse,
  StatusResponse,
  StreamSummary,
  StreamsHistoryResponse,
} from "../../../src/contracts/control-surface-api.ts";
export type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineTool,
  ImageAttachment,
  JsonValue,
  MessageSource,
} from "../../../src/contracts/timeline.ts";
export type { TranscriptPageResponse } from "../../../src/contracts/transcript.ts";

export type ConnectionState = "connected" | "connecting" | "reconnecting" | "stub" | "disconnected";

export type OfflineStatus = {
  source: "offline";
  ok?: never;
  pid?: never;
  uptime: 0;
  piAgent?: never;
  blackboard: "";
  whatsapp: {
    status: "disconnected";
    pid?: never;
    managedByControlSurface?: never;
    requiresManualAuth?: never;
  };
  streams: [];
  shortcuts: Record<never, never>;
};

export type StatusQueryData = StatusResponse | OfflineStatus;

export type SkillPickerItem = SkillListItem & {
  kind?: "skill" | "command";
};

export type WsMessage =
  | { type: "connected"; clientId: string }
  | { type: "queue_item_start"; item: { id: string; source: string }; piSessionId?: string }
  | { type: "queue_item_end"; itemId: string; error?: string; piSessionId?: string }
  | { type: "text_delta"; delta: string; piSessionId?: string; messageId: string }
  | { type: "message_start"; piSessionId?: string; messageId: string }
  | {
      type: "message_end";
      piSessionId?: string;
      message: ChatTimelineMessage;
      toolCalls?: Array<{
        toolUseId: string;
        toolName: string;
        args?: unknown;
        displayArgs?: unknown;
      }>;
      clientMessageId?: string;
    }
  | {
      type: "tool_execution_start" | "tool_execution_end";
      id?: string;
      tool?: string;
      toolUseId?: string;
      args?: unknown;
      displayArgs?: unknown;
      result?: unknown;
      isError?: boolean;
      event?: unknown;
      timestamp?: string;
      piSessionId?: string;
    }
  | { type: "thinking_start"; piSessionId?: string; messageId: string }
  | { type: "thinking_delta"; delta: string; piSessionId?: string; messageId: string }
  | { type: "thinking_end"; piSessionId?: string; messageId: string }
  | {
      type: "toolcall_start";
      contentIndex: number;
      toolName?: string;
      toolUseId?: string;
      piSessionId?: string;
    }
  | {
      type: "tool_execution_update";
      toolUseId?: string;
      partialResult?: unknown;
      piSessionId?: string;
    }
  | {
      type: "tool_result";
      item: ChatTimelineTool;
      piSessionId?: string;
    }
  | { type: "turn_end"; piSessionId?: string }
  | { type: "agent_end"; piSessionId?: string; aborted?: boolean }
  | {
      type: "stream_surfaced";
      message: ChatTimelineMessage;
      piSessionId?: string;
      streamId?: string;
      streamName?: string;
    }
  | {
      type: "streams_changed";
      reason: "created" | "closed" | "reopened" | "pinned" | "renamed" | "cwd_changed";
      streamId: string;
      streamName?: string;
    }
  | { type: "status_changed"; subsystem: string; timestamp: string }
  | {
      type: "sessions_changed";
      sessionId: string;
      piSessionId: string;
      reason: "registered" | "ended" | "stopped";
    }
  | {
      type: "worktree_changed";
      piSessionId: string;
      streamId: string;
    }
  | {
      type: "message_ack";
      serverMessageId: string;
      text: string;
      source: "web";
    }
  | { type: "resources_reloaded" }
  | { type: "history_rewritten"; piSessionId: string; reason: "prune" | "compact" }
  | { type: "error"; message: string };
