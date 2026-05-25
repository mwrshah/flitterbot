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
  /**
   * Persistent canonical id. For messages that have been appended to the
   * pi-sdk SessionManager this IS the SDK entry id (8-char hex), which is
   * also what's serialised to the JSONL session file. Same id on live
   * (post-message_end) and on history reload from disk — no parallel
   * synthetic ordinal scheme. Used for cache dedup AND for prune navigation
   * (`navigateTree(entryId)` accepts this directly).
   *
   * For optimistic user bubbles inserted before the WS round-trip this is
   * the client-generated `clientMessageId` UUID; on the user-role
   * `message_end` echo the bridge swaps the optimistic entry for the
   * canonical one (whose `id` is the SDK entry id) keyed via the
   * `clientMessageId` field below.
   */
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
  /**
   * Surface-timeline correlation key — the DB messages-table row id that
   * the runtime pre-allocates at enqueue time so the surface (input) view
   * can show the message before the SDK has appended an entry. Independent
   * of `id` (the SDK entry id) because the runtime needs an id at enqueue,
   * before the SDK has assigned its own.
   */
  serverMessageId?: string;
  /**
   * Optimistic-bubble correlation key for user-originated messages.
   * Echoed back from the server on the user-role `message_end` envelope
   * AND stamped onto the canonical message by the WS bridge so the
   * structural-sharing comparator (mergeTimelineItems) recognises the
   * optimistic entry (id === clientMessageId) as covered by the canonical
   * (id === entry.id) and doesn't re-append it as an extra.
   */
  clientMessageId?: string;
  createdAt: string;
};

export type ChatTimelineTool = {
  id: string;
  kind: "tool";
  tool: string;
  phase: "start" | "update" | "end";
  toolUseId?: string;
  /**
   * Canonical tool input. Persistent across history reads and live events.
   * MUST remain unchanged through any UI rendering — replay, debug, and
   * future action paths read raw values from here.
   */
  args?: JsonValue;
  /**
   * UI-only display projection of `args`. Produced server-side by
   * `tool-display.ts` from the active pi-session cwd and (when present)
   * the stream worktree. MUST NEVER be sent back into tool execution.
   * Undefined when no transformation applies; the UI uses `displayArgs
   * ?? args` as its single render rule.
   */
  displayArgs?: JsonValue;
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
