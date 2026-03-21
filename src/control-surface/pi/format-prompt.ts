import type { QueueItem } from "../queue/turn-queue.ts";
import { formatSourcePrefix } from "./source-prefix.ts";

/**
 * Produce the final prompt string for session.prompt().
 * Every message gets a `[source] ` prefix so the agent knows the origin.
 * Hook and cron messages already carry their own bracket prefix.
 */
export function formatPromptWithContext(item: QueueItem, role: "default" | "orchestrator"): string {
	// Hook and cron messages already have [hook] / [cron] prefix
	if (item.source === "hook" || item.source === "cron") {
		return item.text;
	}

	// Orchestrators receive raw text (workstream context is in system prompt)
	if (role === "orchestrator") {
		return item.text;
	}

	// Default agent: prepend [source] User: prefix
	return `${formatSourcePrefix(item.source, true)}${item.text}`;
}
