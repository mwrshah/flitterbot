/* ── Chat timeline (shared with backend) ── */

import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineTool,
} from "../../../src/contracts/timeline.ts";

export type {
  ChatTimelineDivider,
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineTool,
  ImageAttachment,
  JsonValue,
  MessageSource,
} from "../../../src/contracts/timeline.ts";

/* ── Connection ── */

export type ConnectionState = "connected" | "connecting" | "reconnecting" | "stub" | "disconnected";

export type DeliveryMode = "followUp";

/* ── Sessions ── */

export type SessionSummary = {
  sessionId: string;
  status: "working" | "idle" | "stale" | "ended";
  taskDescription?: string;
  project?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  lastEventAt?: string;
  streamId?: string;
  streamName?: string;
};

export type SessionDetail = {
  sessionId: string;
  status: "working" | "idle" | "stale" | "ended";
  taskDescription?: string;
  project?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  lastEventAt?: string;
  startedAt?: string;
  cwd?: string;
  model?: string;
  streamId?: string;
  streamName?: string;
  recentEvents: SessionEvent[];
};

export type SessionEvent = {
  id: number;
  event_name: string;
  tool_name?: string;
  payload?: string;
  timestamp: string;
};

export type TmuxSessionInspection = {
  exists: boolean;
  attached: boolean;
  pane?: {
    uiState?: string;
    currentCommand?: string;
    target?: string;
    panePid?: number;
    capture?: string;
  };
};

/* ── Transcripts ── */

export type TranscriptItem = {
  id: string;
  kind: "message" | "tool_call" | "tool_result" | "event";
  role?: string;
  text?: string;
  title?: string;
  rawType?: string;
  toolName?: string;
  timestamp?: string;
  metadata: Record<string, unknown>;
};

export type TranscriptPage = {
  items: TranscriptItem[];
  nextCursor?: string;
};

/* ── Status ── */

export type ShortcutBindingsConfig = Partial<Record<string, string | string[]>>;

export type StatusResponse = {
  source?: string;
  pid?: number;
  uptime: number;
  blackboard: string;
  whatsapp: {
    status: string;
    pid?: number;
    managedByControlSurface?: boolean;
  };
  piAgent?: {
    default?: {
      piSessionId?: string;
      busy?: boolean;
      messageCount?: number;
      state?: string;
    };
    orchestrators?: Array<{
      piSessionId: string;
      streamId: string;
      streamName?: string;
      messageCount: number;
      busy: boolean;
    }>;
  };
  streams?: StreamSummary[];
  shortcuts?: ShortcutBindingsConfig;
};

/* ── Streams ── */

export type PiSessionStatus =
  | "active"
  | "waiting_for_user"
  | "waiting_for_sessions"
  | "ended"
  | "crashed";

export type StreamSummary = {
  id: string;
  name: string;
  status: "open" | "closed";
  closedAt?: string;
  repoPath?: string;
  worktreePath?: string;
  piSessionId?: string;
  piSessionStatus?: PiSessionStatus;
  sessionCount: number;
  createdAt: string;
};

/* ── API responses ── */

export type SessionListResponse = {
  items: SessionSummary[];
};

export type DownstreamSessionItem = {
  sessionId: string;
  status: "working" | "idle" | "stale" | "ended";
  streamId: string | null;
  streamName: string | null;
  tmuxSession: string | null;
  cwd: string | null;
  taskDescription: string | null;
  project: string | null;
};

export type DownstreamSessionsListResponse = {
  items: DownstreamSessionItem[];
};

export type SessionDetailResponse = {
  session: SessionDetail;
  tmux?: TmuxSessionInspection | null;
};

export type DirectMessageResponse = {
  ok: boolean;
  delivery?: string;
  reason?: string;
};

export type StreamsHistoryResponse = {
  items: ChatTimelineItem[];
};

/* ── Skills ── */

export type SkillListItem = {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  /** "command" marks built-in slash commands (/clear, /reload); absent or "skill" for regular skills. */
  kind?: "skill" | "command";
};

export type SkillsListResponse = {
  items: SkillListItem[];
};

/* ── Models ── */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModelListItem = {
  id: string;
  label: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  name?: string;
  contextWindow?: number;
  available?: boolean;
};

export type ModelsListResponse = {
  pinned: ModelListItem[];
  all: ModelListItem[];
  defaultModel: string;
};

/* ── Directory Completions ── */

export type DirectoryCompletionItem = {
  name: string;
  kind: "directory" | "file";
  path: string;
  insertText: string;
};

export type DirectoryCompletionsResponse = {
  items: DirectoryCompletionItem[];
  cwd: string;
  query: string;
};

/* ── WebSocket messages (inbound) ── */

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
      toolCalls?: Array<{ toolUseId: string; toolName: string; args?: unknown }>;
    }
  | {
      type: "tool_execution_start" | "tool_execution_end";
      id?: string;
      tool?: string;
      toolUseId?: string;
      args?: unknown;
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
      reason: "created" | "closed" | "reopened";
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
  | { type: "history_rewritten"; piSessionId: string; reason: "prune" }
  | { type: "error"; message: string };
