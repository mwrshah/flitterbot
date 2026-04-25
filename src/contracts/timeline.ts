/**
 * Canonical timeline types shared by backend (history API) and frontend (UI).
 *
 * Both `src/` and `web/src/` import from this file.
 * Backend: via `../contracts/timeline.ts`
 * Frontend: re-exported through `web/src/lib/types.ts`
 */

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
  /** True while the message is still being streamed via text_delta events. */
  streaming?: boolean;
  /** True for non-final assistant messages in a multi-message turn. */
  intermediate?: boolean;
  /** Server-generated UUID for optimistic UI correlation. */
  serverMessageId?: string;
  /**
   * Client-generated UUID echoed back from the server on the user-role
   * `message_end` envelope. Stamped onto the canonical message by the WS
   * bridge when reconciling an optimistic bubble, so structural-sharing
   * dedup (mergeTimelineItems) recognises the optimistic entry as covered.
   */
  clientMessageId?: string;
  /**
   * Underlying pi-sdk SessionManager entry id. Present when the message was
   * loaded from a live or on-disk pi session (not for surface-table messages).
   * Required to prune history from a specific point via navigateTree().
   */
  entryId?: string;
  createdAt: string;
};

export type ChatTimelineTool = {
  id: string;
  kind: "tool";
  tool: string;
  phase: "start" | "update" | "end";
  toolUseId?: string;
  args?: JsonValue;
  result?: JsonValue;
  isError?: boolean;
  createdAt: string;
};

/** Dividers are a presentation concern — the backend never produces them. */
export type ChatTimelineDivider = {
  id: string;
  kind: "divider";
  createdAt: string;
};

export type ChatTimelineItem = ChatTimelineMessage | ChatTimelineTool | ChatTimelineDivider;
