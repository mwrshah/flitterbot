import type { QueueItem } from "./turn-queue.ts";

const PI_SKILL_COMMAND_WITHOUT_SPACE_DELIMITER = /^(\/skill:[^\s]+)(?=[^\S ])/u;

export function formatPromptWithContext(item: QueueItem): string {
  return item.text.replace(PI_SKILL_COMMAND_WITHOUT_SPACE_DELIMITER, "$1 ");
}
