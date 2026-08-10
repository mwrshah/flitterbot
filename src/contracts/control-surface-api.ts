import type { AuthEvent, AuthPrompt, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type {
  ClaudeSessionStatus,
  PiSessionStatus,
  StreamStatus,
  StreamType,
} from "./blackboard.ts";
import type { ChatTimelineItem, MessageSource, TokenUsage } from "./timeline.ts";
import type {
  SendMessageToTmuxSessionFailureReason,
  TmuxDeliveryMethod,
  TmuxSessionInspection,
} from "./tmux-bridge.ts";
import type { ConversationEventPosition } from "./websocket.ts";

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
  status: WhatsAppDaemonStatus;
  pid?: number | null;
  managedByControlSurface: boolean;
  requiresManualAuth?: boolean;
}

export interface PiSessionModelInfo {
  id: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ModelThinkingLevel;
}

export interface PiSessionRuntimeStatus {
  piSessionId: string;
  sessionFile: string | null;
  messageCount: number;
  lastPromptAt: string | null;
  busy: boolean;
  isCompacting: boolean;
  contextUsage: TokenUsage | null;
  model?: PiSessionModelInfo;
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
  streamId: string | null;
  piSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  lastEventAt: string;
  lastToolStartedAt: string | null;
}

export interface PiOrchestratorStatus {
  piSessionId: string;
  streamId: string;
  streamName: string | null;
  messageCount: number;
  busy: boolean;
  isCompacting: boolean;
  contextUsage: TokenUsage | null;
}

export interface PiMultiSessionStatus {
  default: PiSessionRuntimeStatus | null;
  orchestrators: PiOrchestratorStatus[];
}

export interface StreamSummary {
  id: string;
  name: string;
  type: StreamType;
  status: StreamStatus;
  pinned: boolean;
  closedAt?: string;
  repoPath?: string;
  worktreePath?: string;
  piSessionId?: string;
  piSessionStatus?: PiSessionStatus;
  model?: PiSessionModelInfo;
  sessionCount: number;
  createdAt: string;
}

export type ShortcutBindingsConfig = Partial<Record<string, string | string[]>>;

export interface StatusResponse {
  ok: true;
  pid: number;
  uptime: number;
  piAgent: PiMultiSessionStatus;
  whatsapp: WhatsAppRuntimeStatus;
  blackboard: BlackboardHealth;
  groqConfigured: boolean;
  streams?: StreamSummary[];
  shortcuts?: ShortcutBindingsConfig;
}

export interface MessageRequest {
  text: string;
  source?: MessageSource;
  metadata?: Record<string, unknown>;
  images?: Array<{ data: string; mimeType: string }>;
  targetPiSessionId?: string;
}

export interface ModelListItem {
  id: string;
  label: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ModelThinkingLevel;
  reasoning?: boolean;
  supportsXhigh?: boolean;
  supportsMax?: boolean;
  name?: string;
  contextWindow?: number;
  available?: boolean;
  authKind?: "subscription" | "api_key" | "none";
}

export interface ModelsListResponse {
  pinned: ModelListItem[];
  all: ModelListItem[];
  defaultModel: string;
  defaultThinkingLevel: ModelThinkingLevel;
}

export interface ModelsMutationResponse extends ModelsListResponse {
  ok: true;
}

export interface MessageResponse {
  ok: boolean;
}

export interface ClaudeHookPayload {
  hook_event_name?: string;
  event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  cwd?: string;
  model?: string;
  permission_mode?: string;
  source?: string;
  transcript_path?: string;
  reason?: string;
  timestamp?: string;
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

export interface DownstreamSessionItem {
  sessionId: string;
  status: ClaudeSessionStatus;
  streamId: string | null;
  streamName: string | null;
  tmuxSession: string | null;
  cwd: string | null;
  taskDescription: string | null;
  project: string | null;
}

export interface DownstreamSessionsListResponse {
  items: DownstreamSessionItem[];
}

export interface SessionDetailResponse {
  session: ClaudeSessionListItem;
  tmux?: TmuxSessionInspection | null;
}

export const STREAMS_HISTORY_DEFAULT_VISIBLE_ROW_LIMIT = 30;
export const STREAMS_HISTORY_MAX_VISIBLE_ROW_LIMIT = 200;

export interface StreamsHistoryResponse {
  items: ChatTimelineItem[];
  historyPosition?: ConversationEventPosition;
  olderPageCursor?: string | null;
}

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

export type RuntimeWhatsAppControlResponse = Omit<WhatsAppRuntimeStatus, "pid"> & {
  ok: boolean;
  pid?: number;
};

export type SkillListItem = Pick<Skill, "name" | "description" | "disableModelInvocation">;

export interface SkillsListResponse {
  items: SkillListItem[];
}

export interface DirectoryCompletionItem {
  name: string;
  kind: "directory" | "file";
  path: string;
  insertText: string;
}

export interface DirectoryCompletionsResponse {
  items: DirectoryCompletionItem[];
  cwd: string;
  query: string;
}

export interface AuthProvider {
  id: string;
  name: string;
  oauthName: string;
  loginLabel?: string;
  searchText: string;
  connected: boolean;
}

export interface AuthProvidersResponse {
  providers: AuthProvider[];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type AuthFlowPrompt = DistributiveOmit<AuthPrompt, "signal"> & { id: string };

export interface AuthFlowSnapshot {
  id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  providerId: string;
  events: AuthEvent[];
  prompt?: AuthFlowPrompt;
  error?: string;
}

export interface StopResponse {
  ok: boolean;
  message: string;
}

export interface PiSessionInterruptResponse {
  ok: boolean;
  piSessionId?: string;
  signaledSessions?: number;
  error?: string;
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
  streamsHistory: {
    method: "GET",
    path: "/api/streams/history",
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
  models: {
    method: "GET",
    path: "/api/models",
    auth: "none",
  },
  modelsPin: {
    method: "POST",
    path: "/api/models/pin",
    auth: "bearer",
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
  piSessions: {
    method: "GET",
    path: "/api/pi-sessions/:piSessionId/sessions",
    auth: "none",
  },
  piSessionInterrupt: {
    method: "POST",
    path: "/api/pi-sessions/:piSessionId/interrupt",
    auth: "bearer",
  },
  piSessionModel: {
    method: "PUT",
    path: "/api/pi-sessions/:piSessionId/model",
    auth: "bearer",
  },
  directoryCompletions: {
    method: "GET",
    path: "/api/directory-completions",
    auth: "none",
  },
  streamsPrune: {
    method: "POST",
    path: "/api/streams/prune",
    auth: "bearer",
  },
  streamsFork: {
    method: "POST",
    path: "/api/streams/fork",
    auth: "bearer",
  },
  streamsCompact: {
    method: "POST",
    path: "/api/streams/compact",
    auth: "bearer",
  },
} as const;
