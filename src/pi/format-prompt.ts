import type { QueueItem } from "./turn-queue.ts";

/**
 * Sources that already embed their own bracket prefix in the message text.
 * These must NOT get a second prefix from formatPromptWithContext.
 */
const SELF_PREFIXED_SOURCES = new Set(["hook", "cron"]);

/**
 * Produce the final prompt string for session.prompt().
 * Prepends a `[source] ` prefix so history.ts can recover the source
 * after round-tripping through the SDK's JSONL session file.
 * Hook and cron messages already carry their own bracket prefix.
 */
export function formatPromptWithContext(item: QueueItem): string {
  if (SELF_PREFIXED_SOURCES.has(item.source)) {
    return item.text;
  }
  return `[${item.source}] ${item.text}`;
}
