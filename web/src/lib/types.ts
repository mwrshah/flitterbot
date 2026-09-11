import type { SkillListItem } from "../../../src/contracts/control-surface-api.ts";

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
  DueTasksResponse,
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

export type SkillPickerItem = SkillListItem & {
  kind?: "skill" | "command";
};
