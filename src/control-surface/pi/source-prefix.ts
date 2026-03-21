/**
 * Shared utility for the `[source]` bracket prefix convention.
 *
 * All messages entering the Pi session carry a bracket prefix:
 *   - User messages:  `[web] User: text`, `[whatsapp] User: text`, `[init] User: text`
 *   - Hook messages:  `[hook] EventName: details`
 *   - Cron messages:  `[cron] CheckName: details`
 *
 * This module provides:
 *   - `extractSourcePrefix` — parse and strip the prefix, returning source + clean content
 *   - `formatSourcePrefix` — construct the prefix for a given source
 */

const SOURCE_PREFIX_RE = /^\[(web|whatsapp|init|hook|cron)\]\s(?:User:\s)?/i;

export function extractSourcePrefix(content: string): { source?: string; cleanContent: string } {
	const match = content.match(SOURCE_PREFIX_RE);
	if (!match) return { cleanContent: content };
	return {
		source: match[1].toLowerCase(),
		cleanContent: content.slice(match[0].length),
	};
}

export function formatSourcePrefix(source: string, isUser: boolean): string {
	return isUser ? `[${source}] User: ` : `[${source}] `;
}
