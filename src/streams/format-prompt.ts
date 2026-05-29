import type { QueueItem } from "./turn-queue.ts";

export function formatPromptWithContext(item: QueueItem): string {
  return item.text;
}
