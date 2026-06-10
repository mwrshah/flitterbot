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

export type ChatTimelineMessage = {
  id: string;
  kind: "message";
  role: "user" | "assistant" | "system";
  content: string;
  blocks?: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }>;
  images?: ImageAttachment[];
  source?: MessageSource;
  streamId?: string;
  streamName?: string;
  streaming?: boolean;
  intermediate?: boolean;
  /** True when this message is a surfaced compaction summary (rendered with a rule above it). */
  compaction?: boolean;
  serverMessageId?: string;
  clientMessageId?: string;
  createdAt: string;
};

export type ChatTimelineTool = {
  id: string;
  kind: "tool";
  tool: string;
  phase: "start" | "update" | "end";
  toolUseId?: string;
  /** Canonical tool input — must stay unchanged through UI rendering; replay and debug paths read raw values here. */
  args?: JsonValue;
  /** UI-only display projection of `args` — must never be sent back into tool execution. */
  displayArgs?: JsonValue;
  result?: JsonValue;
  isError?: boolean;
  createdAt: string;
};

export type ChatTimelineDivider = {
  id: string;
  kind: "divider";
  createdAt: string;
};

export type ChatTimelineItem = ChatTimelineMessage | ChatTimelineTool | ChatTimelineDivider;
