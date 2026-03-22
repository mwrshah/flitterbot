import fs from "node:fs";
import type { BlackboardDatabase } from "../../blackboard/db.ts";
import type { WorkstreamRow } from "../../contracts/index.ts";
import { listOpenWorkstreams, listRecentlyClosedWorkstreams, insertWorkstream, reopenWorkstream } from "../../blackboard/queries/workstreams.ts";
import { callGroqClassify, type ClassifyResult } from "./groq-client.ts";
import { getRecentConversationByWorkstream, type ConversationSnippet } from "../../blackboard/queries/messages.ts";

export type ClassificationResult = {
	workstream: WorkstreamRow | null;
	isWorkMessage: boolean;
	action: "matched" | "created" | "reopened" | "none";
};

function listProjectDirs(projectsDir: string): string[] {
	try {
		if (!fs.existsSync(projectsDir)) return [];
		return fs
			.readdirSync(projectsDir, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith("."))
			.map((d) => d.name);
	} catch {
		return [];
	}
}

function formatWorkstreamLine(ws: WorkstreamRow, label?: string): string {
	const suffix = label ? ` ${label}` : "";
	return `- id: "${ws.id}", name: "${ws.name}"${suffix}${ws.repo_path ? `, repo: ${ws.repo_path}` : ""}`;
}

function relativeTime(iso: string): string {
	const diffMs = Date.now() - new Date(iso).getTime();
	if (diffMs < 0) return "just now";
	const mins = Math.floor(diffMs / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "yesterday" : `${days}d ago`;
}

function truncate(text: string, maxLen: number): string {
	const oneLine = text.replace(/\n/g, " ").trim();
	return oneLine.length <= maxLen ? oneLine : oneLine.slice(0, maxLen - 1) + "…";
}

function formatSnippetLabel(s: ConversationSnippet): string {
	if (s.direction === "outbound") return "Agent";
	return "User";
}

function buildConversationBlock(
	workstreams: WorkstreamRow[],
	recentConversation: Map<string, ConversationSnippet[]>,
): string {
	// Cap at 5 most recently active workstreams
	const withConversation = workstreams
		.filter((ws) => recentConversation.has(ws.id))
		.slice(0, 5);

	if (withConversation.length === 0) return "";

	// Find the most recent agent message across all workstreams
	let latestAgentWsId: string | null = null;
	let latestAgentTime = "";
	for (const [wsId, snippets] of recentConversation) {
		for (const s of snippets) {
			if (s.direction === "outbound" && s.created_at > latestAgentTime) {
				latestAgentTime = s.created_at;
				latestAgentWsId = wsId;
			}
		}
	}

	const sections = withConversation.map((ws) => {
		const snippets = recentConversation.get(ws.id)!;
		const lines = snippets.map((s) => {
			const label = formatSnippetLabel(s);
			return `- [${s.source}] ${label}: "${truncate(s.content, 100)}" (${relativeTime(s.created_at)})`;
		});
		const heading = ws.id === latestAgentWsId
			? `### ${ws.name} (${ws.id.slice(0, 8)}) ← last agent response`
			: `### ${ws.name} (${ws.id.slice(0, 8)})`;
		return `${heading}\n${lines.join("\n")}`;
	});

	return `\n## Recent conversation per workstream\n${sections.join("\n\n")}\n`;
}

function buildClassificationPrompt(
	message: string,
	workstreams: WorkstreamRow[],
	recentlyClosed: WorkstreamRow[],
	recentConversation: Map<string, ConversationSnippet[]>,
	projects: string[],
): string {
	const workstreamBlock =
		workstreams.length > 0
			? workstreams.map((ws) => formatWorkstreamLine(ws)).join("\n")
			: "(none open)";

	const conversationBlock = buildConversationBlock(workstreams, recentConversation);

	const closedBlock =
		recentlyClosed.length > 0
			? recentlyClosed.map((ws) => formatWorkstreamLine(ws, "[closed]")).join("\n")
			: "(none)";

	const projectBlock = projects.length > 0 ? projects.join(", ") : "(none)";

	return `You are a message classifier for a software development assistant.

Given a user message, classify it against open workstreams and known projects.

## Open workstreams
${workstreamBlock}
${conversationBlock}
## Recently closed workstreams (last 6 hours)
${closedBlock}

## Known projects
${projectBlock}

## Rules
1. If the message clearly relates to an existing open workstream, return its id.
2. If the message starts new work (a task, bug, feature, investigation, etc.) that doesn't match any open workstream, set new_workstream_name to a short descriptive name (2-5 words, lowercase, dash-separated).
3. If the message is casual conversation, a greeting, a question about the assistant itself, or otherwise not work-related, set is_work_message to false and leave both ids null.
4. If the user explicitly asks to start/open/create a new workstream (e.g. "start a new workstream", "open a new workstream for this", "create a separate workstream"), ALWAYS create a new workstream regardless of whether the topic overlaps with an existing one. User intent overrides matching heuristics.
5. When in doubt between matching an existing workstream and creating a new one, prefer matching the existing one.
6. A message that references a known project by name should be matched to an existing workstream for that project if one exists, or trigger a new workstream if not.
7. If the message relates to a recently closed workstream, return its id. Do not create a duplicate workstream for recently completed work.
8. Use the recent conversation snippets to understand context when deciding if the message relates to an existing workstream. Agent messages show what the assistant last said to the user — short/ambiguous user replies (e.g. "yes", "sure", "do it") are almost certainly responding to the workstream that sent the most recent agent message (marked with "← last agent response").
9. Session management commands (kill tmux, close sessions, check status, restart daemon, close tmux windows, quit claude) are NOT work — set is_work_message to false. These are infrastructure meta-operations.
10. Cron health-check messages (containing "Cron idle check", "Cron stale session check", or similar automated system messages) are NOT work — set is_work_message to false.
11. Workstreams are about repository-scoped coding/engineering work (features, bugs, investigations in a project), not meta-operations on the Autonoma system itself or general task management.

## Response format
Respond with ONLY a JSON object containing four fields: workstream_id, new_workstream_name, is_work_message, and reasoning. No other text or explanation. Example:
\`\`\`json
{
  "is_work_message": true,
  "workstream_id": null,
  "new_workstream_name": "input-surface-websocket-investigation",
  "reasoning": "New investigation into websocket streaming issue distinct from existing steer-type workstream"
}
\`\`\`

## User message
${message}`;
}

export async function classifyMessage(
	message: string,
	db: BlackboardDatabase,
	apiKey: string,
	projectsDir: string,
): Promise<ClassificationResult> {
	const workstreams = listOpenWorkstreams(db);
	const recentlyClosed = listRecentlyClosedWorkstreams(db, 6);
	const recentConversation = getRecentConversationByWorkstream(db, 12, 5);
	const projects = listProjectDirs(projectsDir);
	const prompt = buildClassificationPrompt(message, workstreams, recentlyClosed, recentConversation, projects);

	let result: ClassifyResult;
	try {
		result = await callGroqClassify(apiKey, prompt);
	} catch (error) {
		// If classification fails, pass through as non-work (don't block the message)
		console.error(
			`[router] Groq classification failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { workstream: null, isWorkMessage: false, action: "none" };
	}

	if (!result.is_work_message) {
		return { workstream: null, isWorkMessage: false, action: "none" };
	}

	// Try to match existing open workstream
	if (result.workstream_id) {
		const existing = workstreams.find((ws) => ws.id === result.workstream_id);
		if (existing) {
			return { workstream: existing, isWorkMessage: true, action: "matched" };
		}

		// Check if it matches a recently closed workstream — reopen it
		const closed = recentlyClosed.find((ws) => ws.id === result.workstream_id);
		if (closed) {
			const reopened = reopenWorkstream(db, closed.id);
			if (reopened) {
				return { workstream: reopened, isWorkMessage: true, action: "reopened" };
			}
		}

		// LLM returned an id that doesn't exist — fall through to create
	}

	// Create new workstream
	if (result.new_workstream_name) {
		const created = insertWorkstream(db, result.new_workstream_name);
		return { workstream: created, isWorkMessage: true, action: "created" };
	}

	// Work message but no workstream assignment
	return { workstream: null, isWorkMessage: true, action: "none" };
}
