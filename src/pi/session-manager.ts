import path from "node:path";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import {
  endPiSession,
  reconcilePreviousPiSessions,
  upsertPiSession,
} from "../blackboard/pi-sessions.ts";
import type { AutonomaConfig } from "../config/load-config.ts";
import { type QueueItem, TurnQueue } from "./turn-queue.ts";
import type { WebSocketHub } from "../ws/hub.ts";
import { createAutonomaAgent } from "./create-agent.ts";
import { PiSessionState } from "./session-state.ts";
import { subscribeToPiSession } from "./subscribe.ts";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

export interface ManagedPiSession {
  session: AgentSession;
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

export type ProcessQueueItemCallback = (
  managed: ManagedPiSession,
  item: QueueItem,
) => Promise<void>;

export class PiSessionManager {
  private defaultSession?: ManagedPiSession;
  private readonly orchestrators = new Map<string, ManagedPiSession>();
  private readonly byPiSessionId = new Map<string, ManagedPiSession>();
  private readonly config: AutonomaConfig;
  private readonly blackboard: BlackboardDatabase;
  private readonly wsHub: WebSocketHub;
  private readonly runtimeInstanceId: string;
  private readonly startedAt: number;
  private readonly processCallback: ProcessQueueItemCallback;
  private readonly log: (message: string) => void;

  constructor(
    config: AutonomaConfig,
    blackboard: BlackboardDatabase,
    wsHub: WebSocketHub,
    runtimeInstanceId: string,
    startedAt: number,
    processCallback: ProcessQueueItemCallback,
    log: (message: string) => void,
  ) {
    this.config = config;
    this.blackboard = blackboard;
    this.wsHub = wsHub;
    this.runtimeInstanceId = runtimeInstanceId;
    this.startedAt = startedAt;
    this.processCallback = processCallback;
    this.log = log;
  }

  getDefault(): ManagedPiSession | undefined {
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

  async createDefault(customTools: unknown[]): Promise<ManagedPiSession> {
    reconcilePreviousPiSessions(this.blackboard, "default", this.runtimeInstanceId, "restart");
    reconcilePreviousPiSessions(this.blackboard, "orchestrator", this.runtimeInstanceId, "restart");

    const created = await createAutonomaAgent({
      config: this.config,
      customTools,
      role: "default",
    });

    const state = new PiSessionState();
    state.initialize(
      created.session.sessionId,
      created.session.sessionFile,
      created.session.messages.length,
    );

    const managed = this.buildManagedSession(created, state, "default", null, null);

    upsertPiSession(this.blackboard, {
      piSessionId: created.session.sessionId,
      role: "default",
      status: "waiting_for_user",
      runtimeInstanceId: this.runtimeInstanceId,
      pid: process.pid,
      sessionFile: created.session.sessionFile,
      cwd: this.config.projectsDir,
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
    customTools?: unknown[],
  ): Promise<ManagedPiSession> {
    // If one already exists for this workstream, return it
    const existing = this.orchestrators.get(workstreamId);
    if (existing) return existing;

    const orchestratorContext = {
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
    state.initialize(
      created.session.sessionId,
      created.session.sessionFile,
      created.session.messages.length,
    );

    const managed = this.buildManagedSession(
      created,
      state,
      "orchestrator",
      workstreamId,
      workstreamName,
    );

    upsertPiSession(this.blackboard, {
      piSessionId: created.session.sessionId,
      role: "orchestrator",
      status: "waiting_for_user",
      runtimeInstanceId: this.runtimeInstanceId,
      pid: process.pid,
      sessionFile: created.session.sessionFile,
      cwd: this.config.projectsDir,
      agentDir: this.config.controlSurfaceAgentDir,
      modelProvider: created.modelInfo.provider,
      modelId: created.modelInfo.id,
      thinkingLevel: this.config.piThinkingLevel,
      startedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString(),
      workstreamId,
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
    try {
      managed.unsubscribe();
    } catch {
      /* ignore */
    }
    try {
      managed.session.dispose?.();
    } catch {
      /* ignore */
    }

    const status = reason === "crashed" ? "crashed" : "ended";
    endPiSession(this.blackboard, managed.piSessionId, status, reason, new Date().toISOString());

    this.orchestrators.delete(workstreamId);
    this.byPiSessionId.delete(managed.piSessionId);
    this.log(
      `orchestrator destroyed for workstream "${managed.workstreamName}" (${workstreamId}): ${reason}`,
    );
  }

  disposeAll(): void {
    // Dispose orchestrators first
    for (const [wsId] of this.orchestrators) {
      this.destroyOrchestrator(wsId, "shutdown");
    }

    // Dispose default
    if (this.defaultSession) {
      this.defaultSession.queue.stop();
      try {
        this.defaultSession.unsubscribe();
      } catch {
        /* ignore */
      }
      endPiSession(
        this.blackboard,
        this.defaultSession.piSessionId,
        "ended",
        "shutdown",
        new Date().toISOString(),
      );
      try {
        this.defaultSession.session.dispose?.();
      } catch {
        /* ignore */
      }
      this.byPiSessionId.delete(this.defaultSession.piSessionId);
      this.defaultSession = undefined;
    }
  }

  /**
   * Build the initial prompt for a new orchestrator workstream.
   */
  buildWorkstreamPrompt(
    workstreamName: string,
    workstreamId: string,
    originalUserMessage?: string,
    agentContext?: string,
  ): string {
    return this.formatWorkstreamMessage(workstreamName, workstreamId, originalUserMessage, agentContext);
  }

  private formatWorkstreamMessage(
    name: string,
    id: string,
    originalUserMessage?: string,
    agentContext?: string,
  ): string {
    let prompt = `[Workstream: "${name}" (${id})] [NEW]\n`;
    if (originalUserMessage) {
      prompt += `[User request]\n${originalUserMessage}\n\n`;
    }
    if (agentContext) {
      prompt += `[Agent context]\n${agentContext}\n\n`;
    }
    prompt += `IMPORTANT: Before doing anything else, run /load2-w to load essential skills.`;
    return prompt;
  }

  private buildManagedSession(
    created: { session: AgentSession; modelInfo: { provider?: string; id?: string } },
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
      onItemStart: (item) => {
        state.setBusy(true, item);
        this.wsHub.broadcast({
          type: "queue_item_start",
          item,
          sessionId: managed.piSessionId,
          ...(workstreamId ? { workstreamId } : {}),
        });
      },
      onItemEnd: (item, error) => {
        state.setBusy(false);
        if (error) {
          const detail =
            error instanceof Error
              ? `${error.message}${(error as any).status ? ` [status=${(error as any).status}]` : ""}${(error as any).body ? ` body=${JSON.stringify((error as any).body).slice(0, 200)}` : ""}`
              : String(error);
          this.log(
            `queue item ${item.id} failed (${role}${workstreamId ? ` ws=${workstreamId}` : ""}): ${detail}`,
          );

          // If orchestrator crashes, destroy it
          if (role === "orchestrator" && workstreamId) {
            this.destroyOrchestrator(workstreamId, "crashed");
          }
        }
        this.wsHub.broadcast({
          type: "queue_item_end",
          itemId: item.id,
          error: error instanceof Error ? error.message : error ? String(error) : undefined,
          sessionId: managed.piSessionId,
          ...(workstreamId ? { workstreamId } : {}),
        });
      },
    });

    managed.unsubscribe = subscribeToPiSession(created.session, state, this.blackboard, this.wsHub);

    return managed;
  }
}

