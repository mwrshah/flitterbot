/* ── Chat timeline (shared with backend) ── */

import type { ChatTimelineItem, ChatTimelineMessage } from "../../../src/contracts/timeline.ts";

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

export type DeliveryMode = "followUp" | "steer";

/* ── Sessions ── */

export type SessionSummary = {
  sessionId: string;
  status: "working" | "idle" | "stale" | "ended";
  taskDescription?: string;
  project?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  lastEventAt?: string;
  workstreamId?: string;
  workstreamName?: string;
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
  workstreamId?: string;
  workstreamName?: string;
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
  pi?: {
    default?: {
      sessionId?: string;
      busy?: boolean;
      messageCount?: number;
      state?: string;
    };
    orchestrators?: Array<{
      sessionId: string;
      workstreamId: string;
      workstreamName?: string;
      messageCount: number;
      busy: boolean;
    }>;
  };
  workstreams?: WorkstreamSummary[];
};

/* ── Workstreams ── */

export type WorkstreamSummary = {
  id: string;
  name: string;
  status: "open" | "closed";
  closedAt?: string;
  repoPath?: string;
  worktreePath?: string;
  piSessionId?: string;
  sessionCount: number;
  createdAt: string;
};

/* ── API responses ── */

export type SessionListResponse = {
  items: SessionSummary[];
};

export type SessionDetailResponse = {
  session: SessionDetail;
  tmux?: TmuxSessionInspection | null;
};

export type SendMessageResponse = {
  ok: boolean;
};

export type DirectMessageResponse = {
  ok: boolean;
  delivery?: string;
  reason?: string;
};

export type PiHistoryResponse = {
  items: ChatTimelineItem[];
};

/* ── Skills ── */

export type SkillListItem = {
  name: string;
  description: string;
  disableModelInvocation: boolean;
};

export type SkillsListResponse = {
  items: SkillListItem[];
};

/* ── WebSocket messages (inbound) ── */

export type WsMessage =
  | { type: "connected"; clientId: string }
  | { type: "queue_item_start"; item: { id: string; source: string }; sessionId?: string }
  | { type: "queue_item_end"; itemId: string; error?: string; sessionId?: string }
  | { type: "text_delta"; delta: string; sessionId?: string; messageId: string }
  | {
      type: "message_end";
      sessionId?: string;
      message: ChatTimelineMessage;
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
      sessionId?: string;
    }
  | { type: "thinking_delta"; delta: string; sessionId?: string; messageId: string }
  | { type: "toolcall_start"; contentIndex: number; toolName?: string; sessionId?: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; sessionId?: string }
  | {
      type: "tool_execution_update";
      toolUseId?: string;
      partialResult?: unknown;
      sessionId?: string;
    }
  | { type: "turn_end"; sessionId?: string }
  | {
      type: "pi_surfaced";
      message: ChatTimelineMessage;
      sessionId?: string;
      workstreamId?: string;
      workstreamName?: string;
    }
  | {
      type: "workstreams_changed";
      reason: "created" | "closed";
      workstreamId: string;
      workstreamName?: string;
    }
  | { type: "status_changed"; subsystem: string; timestamp: string }
  | { type: "error"; message: string };
