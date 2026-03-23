import type { QueueItem } from "../queue/turn-queue.ts";

/**
 * Produce the final prompt string for session.prompt().
 * Source metadata lives on QueueItem.source — not in the message text.
 * Hook and cron messages carry their own bracket prefix in the text itself.
 */
export function formatPromptWithContext(item: QueueItem, _role: "default" | "orchestrator"): string {
  return item.text;
}
