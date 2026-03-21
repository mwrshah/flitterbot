import crypto from "node:crypto";
import path from "node:path";
import type { AutonomaConfig } from "../../config/load-config.ts";
import type { BlackboardDatabase } from "../../blackboard/db.ts";
import {
	endPiSession,
	reconcilePreviousPiSessions,
	upsertPiSession,
} from "../../blackboard/queries/pi-sessions.ts";
import { createAutonomaAgent } from "./create-agent.ts";
import { PiSessionState } from "./session-state.ts";
import { subscribeToPiSession } from "./subscribe.ts";
import { TurnQueue, type QueueItem } from "../queue/turn-queue.ts";
import { readPiHistoryFromMessages } from "./history.ts";
import type { PiHistoryItem } from "../../contracts/index.ts";
import type { WebSocketHub } from "../ws/hub.ts";
import type { OrchestratorContext } from "./system-prompts/index.ts";

export interface ManagedPiSession {
	session: any;
	queue: TurnQueue;
	state: PiSessionState;
	role: "default" | "orchestrator";
	workstreamId: string | null;
	workstreamName: string | null;
	piSessionId: string;
	createdAt: string;
	modelInfo: { provider?: string; id?: string };
	unsubscribe: () => void;
}

export type ProcessQueueItemCallback = (managed: ManagedPiSession, item: QueueItem) => Promise<void>;

export class PiSessionManager {
	private defaultSession?: ManagedPiSession;
	private readonly orchestrators = new Map<string, ManagedPiSession>();
	private readonly byPiSessionId = new Map<string, ManagedPiSession>();

	constructor(
		private readonly config: AutonomaConfig,
		private readonly blackboard: BlackboardDatabase,
		private readonly wsHub: WebSocketHub,
		private readonly runtimeInstanceId: string,
		private readonly startedAt: number,
		private readonly processCallback: ProcessQueueItemCallback,
		private readonly log: (message: string) => void,
	) {}

	getDefault(): ManagedPiSession {
		if (!this.defaultSession) throw new Error("Default Pi session not initialized");
		return this.defaultSession;
	}

	getByWorkstream(workstreamId: string): ManagedPiSession | undefined {
		return this.orchestrators.get(workstreamId);
	}

	getByPiSessionId(piSessionId: string): ManagedPiSession | undefined {
		return this.byPiSessionId.get(piSessionId);
	}

	listOrchestrators(): ManagedPiSession[] {
		return Array.from(this.orchestrators.values());
	}

	async createDefault(customTools: Array<any>): Promise<ManagedPiSession> {
		reconcilePreviousPiSessions(this.blackboard, "default", this.runtimeInstanceId, "restart");
		reconcilePreviousPiSessions(this.blackboard, "orchestrator", this.runtimeInstanceId, "restart");

		const created = await createAutonomaAgent({
			config: this.config,
			customTools,
			role: "default",
		});

		const state = new PiSessionState();
		state.initialize(created.session.sessionId, created.session.sessionFile, created.session.messages.length);

		const managed = this.buildManagedSession(created, state, "default", null, null);

		upsertPiSession(this.blackboard, {
			piSessionId: created.session.sessionId,
			role: "default",
			status: "waiting_for_user",
			runtimeInstanceId: this.runtimeInstanceId,
			pid: process.pid,
			sessionFile: created.session.sessionFile,
			cwd: path.join(process.env.HOME ?? "/home/mas", "development"),
			agentDir: this.config.controlSurfaceAgentDir,
			modelProvider: created.modelInfo.provider,
			modelId: created.modelInfo.id,
			thinkingLevel: this.config.piThinkingLevel,
			startedAt: new Date(this.startedAt).toISOString(),
			lastEventAt: new Date().toISOString(),
		});

		this.defaultSession = managed;
		this.byPiSessionId.set(managed.piSessionId, managed);
		return managed;
	}

	async createOrchestrator(
		workstreamId: string,
		workstreamName: string,
		repoPath?: string,
		customTools?: Array<any>,
	): Promise<ManagedPiSession> {
		// If one already exists for this workstream, return it
		const existing = this.orchestrators.get(workstreamId);
		if (existing) return existing;

		const orchestratorContext: OrchestratorContext = {
			workstreamName,
			workstreamId,
			repoPath,
		};

		const created = await createAutonomaAgent({
			config: this.config,
			customTools: customTools ?? [],
			role: "orchestrator",
			orchestratorContext,
		});

		const state = new PiSessionState();
		state.initialize(created.session.sessionId, created.session.sessionFile, created.session.messages.length);

		const managed = this.buildManagedSession(created, state, "orchestrator", workstreamId, workstreamName);

		upsertPiSession(this.blackboard, {
			piSessionId: created.session.sessionId,
			role: "orchestrator",
			status: "waiting_for_user",
			runtimeInstanceId: this.runtimeInstanceId,
			pid: process.pid,
			sessionFile: created.session.sessionFile,
			cwd: path.join(process.env.HOME ?? "/home/mas", "development"),
			agentDir: this.config.controlSurfaceAgentDir,
			modelProvider: created.modelInfo.provider,
			modelId: created.modelInfo.id,
			thinkingLevel: this.config.piThinkingLevel,
			startedAt: new Date().toISOString(),
			lastEventAt: new Date().toISOString(),
		});

		this.orchestrators.set(workstreamId, managed);
		this.byPiSessionId.set(managed.piSessionId, managed);
		this.log(`orchestrator created for workstream "${workstreamName}" (${workstreamId})`);
		return managed;
	}

	destroyOrchestrator(workstreamId: string, reason: string): void {
		const managed = this.orchestrators.get(workstreamId);
		if (!managed) return;

		managed.queue.stop();
		try { managed.unsubscribe(); } catch { /* ignore */ }
		try { managed.session.dispose?.(); } catch { /* ignore */ }

		const status = reason === "crashed" ? "crashed" : "ended";
		endPiSession(this.blackboard, managed.piSessionId, status, reason, new Date().toISOString());

		this.orchestrators.delete(workstreamId);
		this.byPiSessionId.delete(managed.piSessionId);
		this.log(`orchestrator destroyed for workstream "${managed.workstreamName}" (${workstreamId}): ${reason}`);
	}

	disposeAll(): void {
		// Dispose orchestrators first
		for (const [wsId] of this.orchestrators) {
			this.destroyOrchestrator(wsId, "shutdown");
		}

		// Dispose default
		if (this.defaultSession) {
			this.defaultSession.queue.stop();
			try { this.defaultSession.unsubscribe(); } catch { /* ignore */ }
			endPiSession(
				this.blackboard,
				this.defaultSession.piSessionId,
				"ended",
				"shutdown",
				new Date().toISOString(),
			);
			try { this.defaultSession.session.dispose?.(); } catch { /* ignore */ }
			this.byPiSessionId.delete(this.defaultSession.piSessionId);
			this.defaultSession = undefined;
		}
	}

	/**
	 * Build context-transfer prompt for a new orchestrator from the default agent's recent history.
	 */
	buildContextTransferPrompt(
		currentMessage: string,
		workstreamName: string,
		workstreamId: string,
	): string {
		const def = this.defaultSession;
		if (!def) return this.formatWorkstreamMessage(currentMessage, workstreamName, workstreamId);

		const history = readPiHistoryFromMessages(
			def.piSessionId,
			def.session.sessionFile ?? null,
			def.session.messages,
			"input",
		);

		// Skip the init couplet (init user message + assistant response)
		const initEndIdx = findInitCoupletEnd(history.items);
		const postInit = history.items.slice(initEndIdx);

		// Take last 20 items
		const recent = postInit.slice(-20);
		if (recent.length === 0) {
			return this.formatWorkstreamMessage(currentMessage, workstreamName, workstreamId);
		}

		// Build prior_context block
		const contextLines: string[] = [];
		for (const item of recent) {
			if (item.kind !== "message") continue;
			const text = stripTransportPrefixes(item.content);
			if (item.role === "user") {
				contextLines.push(`User: ${text}`);
			} else if (item.role === "assistant") {
				contextLines.push(`Assistant: ${text}`);
			}
		}

		const wsPrefix = `[Workstream: "${workstreamName}" (${workstreamId})] [NEW]`;
		const parts = [
			`${wsPrefix}\n${currentMessage}`,
			`<prior_context>\n${contextLines.join("\n")}\n</prior_context>`,
			`${wsPrefix}\n${currentMessage}`,
		];

		return parts.join("\n\n");
	}

	private formatWorkstreamMessage(message: string, name: string, id: string): string {
		return `[Workstream: "${name}" (${id})] [NEW]\n${message}`;
	}

	private buildManagedSession(
		created: { session: any; modelInfo: { provider?: string; id?: string } },
		state: PiSessionState,
		role: "default" | "orchestrator",
		workstreamId: string | null,
		workstreamName: string | null,
	): ManagedPiSession {
		const managed: ManagedPiSession = {
			session: created.session,
			queue: undefined as any, // set below
			state,
			role,
			workstreamId,
			workstreamName,
			piSessionId: created.session.sessionId,
			createdAt: new Date().toISOString(),
			modelInfo: created.modelInfo,
			unsubscribe: undefined as any, // set below
		};

		const processCallback = this.processCallback;
		managed.queue = new TurnQueue({
			process: (item) => processCallback(managed, item),
			onDepthChange: (depth) => state.setQueueDepth(depth),
			onItemStart: (item) => {
				state.setBusy(true, item);
				this.wsHub.broadcast({
					type: "queue_item_start",
					item,
					...(workstreamId ? { workstreamId } : {}),
				} as any);
			},
			onItemEnd: (item, error) => {
				state.setBusy(false);
				if (error) {
					const detail = error instanceof Error
						? `${error.message}${(error as any).status ? ` [status=${(error as any).status}]` : ""}${(error as any).body ? ` body=${JSON.stringify((error as any).body).slice(0, 200)}` : ""}`
						: String(error);
					this.log(`queue item ${item.id} failed (${role}${workstreamId ? ` ws=${workstreamId}` : ""}): ${detail}`);

					// If orchestrator crashes, destroy it
					if (role === "orchestrator" && workstreamId) {
						this.destroyOrchestrator(workstreamId, "crashed");
					}
				}
				this.wsHub.broadcast({
					type: "queue_item_end",
					itemId: item.id,
					error: error instanceof Error ? error.message : error ? String(error) : undefined,
					...(workstreamId ? { workstreamId } : {}),
				} as any);
			},
		});

		managed.unsubscribe = subscribeToPiSession(created.session, state, this.blackboard, this.wsHub);

		return managed;
	}
}

/**
 * Find the end of the init couplet in shaped history items.
 * The init couplet is the first user message (e.g. "[init] User: /load2-w")
 * and its assistant response (e.g. "Skills loaded: ...").
 * Returns the index after the first assistant text message, or 0 if not found.
 */
function findInitCoupletEnd(items: PiHistoryItem[]): number {
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item.kind === "message" && item.role === "assistant" && item.content.trim()) {
			return i + 1;
		}
	}
	return 0;
}

/**
 * Strip transport prefixes like [Web] User: "...", [WhatsApp] User: "...",
 * and workstream prefixes like [Workstream: ...] from context entries.
 */
function stripTransportPrefixes(text: string): string {
	let result = text;
	// Strip [Web] User: "..." or [WhatsApp] User: "..." wrapping
	result = result.replace(/^\[(?:Web|WhatsApp)\]\s*(?:User|Assistant):\s*"?/i, "");
	// Strip trailing quote if present
	result = result.replace(/"$/, "");
	// Strip workstream prefix
	result = result.replace(/^\[Workstream:\s*"[^"]*"\s*\([^)]*\)\]\s*(?:\[(?:NEW|RESUMED)\]\s*)?/i, "");
	return result.trim();
}
