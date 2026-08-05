export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MessageSource =
  | "whatsapp"
  | "hook"
  | "cron"
  | "web"
  | "init"
  | "agent"
  | "stream_outbound";

export type ImageAttachment = {
  data: string;
  mimeType: string;
};

export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
};

export type ChatTimelineMessageBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool"; toolUseId: string };

export type ChatTimelineMessage = {
  id: string;
  piEntryId?: string;
  kind: "message";
  role: "user" | "assistant" | "system";
  content: string;
  blocks?: ChatTimelineMessageBlock[];
  images?: ImageAttachment[];
  source?: MessageSource;
  streamId?: string;
  streamName?: string;
  compaction?: boolean;
  usage?: TokenUsage;
  createdAt: string;
};

export type ChatTimelineTool = {
  id: string;
  piEntryId?: string;
  kind: "tool";
  tool: string;
  phase: "start" | "update" | "end";
  toolUseId: string;
  args?: JsonValue;
  displayArgs?: JsonValue;
  result?: JsonValue;
  isError?: boolean;
  createdAt: string;
};

export type ChatTimelineItem = ChatTimelineMessage | ChatTimelineTool;
