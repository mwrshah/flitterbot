/* ── JSON-safe value (no `unknown`) ── */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/* ── Chat timeline ── */

export type MessageSource = "web" | "whatsapp" | "hook" | "cron" | "init";

export type ImageAttachment = {
  data: string;
  mimeType: string;
};

export type ChatTimelineMessage = {
  id: string;
  kind: "message";
  role: "user" | "assistant" | "system";
  content: string;
  blocks?: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
  >;
  images?: ImageAttachment[];
  source?: MessageSource;
  workstreamName?: string;
  createdAt: string;
};

export type ChatTimelineTool = {
  id: string;
  kind: "tool";
  tool: string;
  phase: "start" | "end";
  toolUseId?: string;
  args?: JsonValue;
  result?: JsonValue;
  isError?: boolean;
  createdAt: string;
};

export type ChatTimelineDivider = {
  id: string;
  kind: "divider";
  createdAt: string;
};

export type ChatTimelineItem =
  | ChatTimelineMessage
  | ChatTimelineTool
  | ChatTimelineDivider;

/* ── Connection ── */

export type ConnectionState =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "stub"
  | "disconnected";

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
  | { type: "text_delta"; delta: string; sessionId?: string }
  | {
      type: "message_end";
      role: string;
      content?: string;
      source?: string;
      timestamp?: string;
      sessionId?: string;
    }
  | {
      type: "tool_execution_start" | "tool_execution_end";
      tool?: string;
      toolUseId?: string;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
      event?: unknown;
      timestamp?: string;
      sessionId?: string;
    }
  | { type: "turn_end"; sessionId?: string }
  | { type: "pi_surfaced"; content: string; timestamp?: string; sessionId?: string; workstreamName?: string }
  | { type: "error"; message: string };
