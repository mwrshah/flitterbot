import type { QueueItem } from "./turn-queue.ts";

/**
 * Produce the final prompt string for session.prompt().
 * The source is tracked via QueueItem.source — no bracket prefix in text.
 */
export function formatPromptWithContext(item: QueueItem): string {
  return item.text;
}
