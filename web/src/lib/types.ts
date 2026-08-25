import type { SkillListItem, StatusResponse } from "../../../src/contracts/control-surface-api.ts";

export type { PiSessionStatus } from "../../../src/contracts/blackboard.ts";
export type {
  AuthFlowPrompt,
  AuthFlowSnapshot,
  AuthProvider,
  AuthProvidersResponse,
  CreateSwimlaneRequest,
  DirectoryCompletionItem,
  DirectoryCompletionsResponse,
  DirectSessionMessageResponse,
  DownstreamSessionItem,
  ModelListItem,
  ModelsListResponse,
  ModelsMutationResponse,
  PiSessionModelInfo,
  RemoveTurnQueueItemResponse,
  RuntimeWhatsAppControlResponse,
  SessionDetailResponse,
  SessionSearchResponse,
  SessionsListResponse,
  ShortcutBindingsConfig,
  SkillsListResponse,
  StatusResponse,
  StreamSummary,
  StreamsHistoryLimit,
  StreamsHistoryResponse,
  SwimlaneLaunchArgs,
} from "../../../src/contracts/control-surface-api.ts";
export type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineMessageBlock,
  ChatTimelineTool,
  ImageAttachment,
  JsonValue,
  MessageSource,
  TokenUsage,
} from "../../../src/contracts/timeline.ts";
export type { TranscriptPageResponse } from "../../../src/contracts/transcript.ts";
export type {
  TurnQueueItemSummary,
  TurnQueueSnapshot,
} from "../../../src/contracts/websocket.ts";

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
