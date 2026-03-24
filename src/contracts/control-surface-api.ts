import type { ClaudeSessionStatus, MessageMetadata } from "./blackboard.ts";
import type { MessageSource } from "./message.ts";
import type {
  SendMessageToTmuxSessionFailureReason,
  TmuxDeliveryMethod,
  TmuxSessionInspection,
} from "./tmux-bridge.ts";
import type { TranscriptPageResponse } from "./transcript.ts";

export type { MessageSource } from "./message.ts";
export type DeliveryMode = "followUp" | "steer";
export type BlackboardHealth = "ok" | "error";
export type WhatsAppDaemonStatus =
  | "unknown"
  | "disabled"
  | "stopped"
  | "starting"
  | "auth_required"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "logged_out"
  | "error"
  | "stopping";

export interface WhatsAppRuntimeStatus {
  ok?: boolean;
  status: WhatsAppDaemonStatus;
  pid?: number | null;
  managedByControlSurface: boolean;
  requiresManualAuth?: boolean;
}

export interface PiRuntimeStatus {
  sessionId: string;
  sessionFile: string | null;
  messageCount: number;
  lastPromptAt: string | null;
  busy: boolean;
}

export interface ClaudeSessionListItem {
  sessionId: string;
  tmuxSession: string | null;
  cwd: string;
  project: string;
  projectLabel: string | null;
  model: string | null;
  permissionMode: string | null;
  source: string | null;
  status: ClaudeSessionStatus;
  transcriptPath: string | null;
  taskDescription: string | null;
  todoistTaskId: string | null;
  agentManaged: boolean;
  sessionEndReason: string | null;
  workstreamId: string | null;
  piSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  lastEventAt: string;
  lastToolStartedAt: string | null;
}

export type ClaudeSessionDetail = ClaudeSessionListItem;

export interface PiOrchestratorStatus {
  sessionId: string;
  workstreamId: string;
  workstreamName: string | null;
  messageCount: number;
  busy: boolean;
}

export interface PiMultiSessionStatus {
  default: PiRuntimeStatus | null;
  orchestrators: PiOrchestratorStatus[];
}

export interface WorkstreamSummary {
  id: string;
  name: string;
  status: "open" | "closed";
  closedAt?: string;
  repoPath?: string;
  worktreePath?: string;
  piSessionId?: string;
  sessionCount: number;
  createdAt: string;
}

export interface StatusResponse {
  ok: true;
  pid: number;
  uptime: number;
  pi: PiMultiSessionStatus;
  whatsapp: WhatsAppRuntimeStatus;
  blackboard: BlackboardHealth;
  workstreams?: WorkstreamSummary[];
}

export interface MessageRequest {
  text: string;
  source?: MessageSource;
  metadata?: MessageMetadata;
  deliveryMode?: DeliveryMode;
  images?: Array<{ data: string; mimeType: string }>;
  targetSessionId?: string;
}

export interface MessageResponse {
  ok: boolean;
}

export interface ClaudeHookPayload {
  hook_event_name?: string;
  event_name?: string;
  session_id?: string;
  sessionId?: string;
  tool_name?: string;
  tool_use_id?: string;
  cwd?: string;
  model?: string;
  permission_mode?: string;
  permissionMode?: string;
  source?: string;
  transcript_path?: string;
  transcriptPath?: string;
  reason?: string;
  stop_reason?: string;
  session_end_reason?: string;
  timestamp?: string;
  lastAssistantText?: string;
  agent_managed?: boolean | number;
  pi_session_id?: string;
  piSessionId?: string;
  AUTONOMA_PI_SESSION_ID?: string;
  workstream_id?: string;
  workstreamId?: string;
  AUTONOMA_WORKSTREAM_ID?: string;
  tmux_session?: string;
  tmuxSession?: string;
  AUTONOMA_TMUX_SESSION?: string;
  task_description?: string;
  taskDescription?: string;
  AUTONOMA_TASK_DESCRIPTION?: string;
  todoist_task_id?: string;
  todoistTaskId?: string;
  AUTONOMA_TODOIST_TASK_ID?: string;
  project?: string;
  project_label?: string;
  projectLabel?: string;
  [key: string]: unknown;
}

export interface HookResponse {
  ok: boolean;
  filtered?: boolean;
  bookkeeping?: boolean;
}

export interface SessionsListResponse {
  items: ClaudeSessionListItem[];
}

export interface SessionDetailResponse {
  session: ClaudeSessionDetail;
  tmux?: TmuxSessionInspection | null;
}

export interface PiHistoryMessageItem {
  id: string;
  kind: "message";
  role: "user" | "assistant" | "system";
  content: string;
  source?: string;
  blocks?: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }>;
  workstreamName?: string;
  createdAt: string;
}

export interface PiHistoryToolItem {
  id: string;
  kind: "tool";
  tool: string;
  phase: "start" | "end";
  toolUseId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  createdAt: string;
}

export type PiHistoryItem = PiHistoryMessageItem | PiHistoryToolItem;

export interface PiHistoryResponse {
  sessionId: string | null;
  sessionFile: string | null;
  items: PiHistoryItem[];
}

export type SessionTranscriptResponse = TranscriptPageResponse;

export interface DirectSessionMessageRequest {
  text: string;
}

export type DirectSessionMessageFailureReason =
  | "ended"
  | "no_tmux_session"
  | "busy"
  | "stale_or_ambiguous"
  | SendMessageToTmuxSessionFailureReason;

export interface DirectSessionMessageResponse {
  ok: boolean;
  sessionId: string;
  delivery?: TmuxDeliveryMethod;
  busy?: boolean;
  reason?: DirectSessionMessageFailureReason;
  error?: string;
}

export interface RuntimeWhatsAppControlResponse {
  ok: boolean;
  status: WhatsAppDaemonStatus;
  pid?: number;
  managedByControlSurface?: boolean;
  requiresManualAuth?: boolean;
}

export type RuntimeWhatsAppStartResponse = RuntimeWhatsAppControlResponse;
export type RuntimeWhatsAppStopResponse = RuntimeWhatsAppControlResponse;

export interface SkillListItem {
  name: string;
  description: string;
  disableModelInvocation: boolean;
}

export interface SkillsListResponse {
  items: SkillListItem[];
}

export interface StopResponse {
  ok: boolean;
  message: string;
}

export type CronTickAction = "enqueued" | "skipped";
export type CronTickReason =
  | "idle_check"
  | "stale_check"
  | "pi_active"
  | "pi_ended"
  | "whatsapp_disconnected"
  | "circuit_breaker"
  | "no_actionable_state";

export interface CronTickResponse {
  ok: true;
  action: CronTickAction;
  reason: CronTickReason;
  flags?: string[];
}

export const CONTROL_SURFACE_ENDPOINTS = {
  status: {
    method: "GET",
    path: "/status",
    auth: "none",
  },
  message: {
    method: "POST",
    path: "/message",
    auth: "bearer",
  },
  hook: {
    method: "POST",
    path: "/hook/:event",
    auth: "bearer",
  },
  sessions: {
    method: "GET",
    path: "/api/sessions",
    auth: "none",
  },
  sessionDetail: {
    method: "GET",
    path: "/api/sessions/:sessionId",
    auth: "none",
  },
  piHistory: {
    method: "GET",
    path: "/api/pi/history",
    auth: "none",
  },
  sessionTranscript: {
    method: "GET",
    path: "/api/sessions/:sessionId/transcript",
    auth: "none",
  },
  sessionMessage: {
    method: "POST",
    path: "/sessions/:sessionId/message",
    auth: "bearer",
  },
  runtimeWhatsAppStart: {
    method: "POST",
    path: "/runtime/whatsapp/start",
    auth: "bearer",
  },
  runtimeWhatsAppStop: {
    method: "POST",
    path: "/runtime/whatsapp/stop",
    auth: "bearer",
  },
  skills: {
    method: "GET",
    path: "/api/skills",
    auth: "none",
  },
  stop: {
    method: "POST",
    path: "/stop",
    auth: "bearer",
  },
  cronTick: {
    method: "POST",
    path: "/cron/tick",
    auth: "bearer",
  },
} as const;
