import fs from "node:fs";
import path from "node:path";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import {
  endStreamsSession,
  reassociateOrphanedSessions,
  reconcilePreviousStreamsSessions,
  upsertStreamsSession,
} from "../blackboard/streams-sessions.ts";
import type { AutonomaConfig } from "../config/load-config.ts";
import type { ApiError } from "../contracts/blackboard.ts";
import type { WebSocketHub } from "../ws/hub.ts";
import { createAutonomaAgent } from "./create-agent.ts";
import { formatStreamPrompt } from "./format-stream-prompt.ts";
import { StreamsSessionState } from "./session-state.ts";
import { subscribeToStreamsSession } from "./subscribe.ts";
import { type QueueItem, TurnQueue } from "./turn-queue.ts";

export { formatStreamPrompt };

export interface ManagedStreamsSession {
  /** Live SDK session. Null for dormant sessions rehydrated from DB on restart. */
  session: AgentSession | null;
  queue: TurnQueue;
  state: StreamsSessionState;
  role: "default" | "orchestrator";
  streamId: string | null;
  streamName: string | null;
  streamsSessionId: string;
  createdAt: string;
  modelInfo: { provider: string; id: string };
  unsubscribe: () => void;
}

export type ProcessQueueItemCallback = (
  managed: ManagedStreamsSession,
  item: QueueItem,
) => Promise<void>;

export class StreamsSessionManager {
  private defaultSession?: ManagedStreamsSession;
  private readonly orchestrators = new Map<string, ManagedStreamsSession>();
  private readonly byStreamsSessionId = new Map<string, ManagedStreamsSession>();
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

  getDefault(): ManagedStreamsSession | undefined {
    return this.defaultSession;
  }

  getByStream(streamId: string): ManagedStreamsSession | undefined {
    return this.orchestrators.get(streamId);
  }

  getByStreamsSessionId(streamsSessionId: string): ManagedStreamsSession | undefined {
    return this.byStreamsSessionId.get(streamsSessionId);
  }

  listOrchestrators(): ManagedStreamsSession[] {
    return Array.from(this.orchestrators.values());
  }

  async createDefault(customTools: unknown[]): Promise<ManagedStreamsSession> {
    // Only reconcile the default session — orchestrator sessions for active streams
    // must survive restarts so their streamsSessionId (and associated messages) are preserved.
    reconcilePreviousStreamsSessions(this.blackboard, "default", this.runtimeInstanceId, "restart");

    const created = await createAutonomaAgent({
      config: this.config,
      customTools,
      role: "default",
    });

    const state = new StreamsSessionState();
    state.initialize(
      created.session.sessionId,
      created.session.sessionFile,
      created.session.messages.length,
    );

    const managed = this.buildManagedSession(created, state, "default", null, null);

    upsertStreamsSession(this.blackboard, {
      streamsSessionId: created.session.sessionId,
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

    // Re-associate orphaned sessions from ended streams sessions to this new default session
    const reassociated = reassociateOrphanedSessions(this.blackboard, managed.streamsSessionId);
    if (reassociated > 0) {
      this.log(`reassociated ${reassociated} orphaned session(s) to new default streams session`);
    }

    this.defaultSession = managed;
    this.byStreamsSessionId.set(managed.streamsSessionId, managed);
    this.logResourceInfo("default", created.resourceInfo);
    return managed;
  }

  async createOrchestrator(
    streamId: string,
    streamName: string,
    repoPath?: string,
    customTools?: unknown[],
  ): Promise<ManagedStreamsSession> {
    // If one already exists for this stream, return it
    const existing = this.orchestrators.get(streamId);
    if (existing) return existing;

    const orchestratorContext = {
      streamName,
      streamId,
      repoPath,
    };

    const created = await createAutonomaAgent({
      config: this.config,
      customTools: customTools ?? [],
      role: "orchestrator",
      orchestratorContext,
    });

    const state = new StreamsSessionState();
    state.initialize(
      created.session.sessionId,
      created.session.sessionFile,
      created.session.messages.length,
    );

    const managed = this.buildManagedSession(created, state, "orchestrator", streamId, streamName);

    upsertStreamsSession(this.blackboard, {
      streamsSessionId: created.session.sessionId,
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
      streamId: streamId,
    });

    this.orchestrators.set(streamId, managed);
    this.byStreamsSessionId.set(managed.streamsSessionId, managed);
    this.log(`orchestrator created for stream "${streamName}" (${streamId})`);
    this.logResourceInfo("orchestrator", created.resourceInfo);
    return managed;
  }

  /**
   * Rehydrate a dormant orchestrator from a pi_sessions DB row.
   * No live SDK agent is created — just the in-memory maps are populated so that
   * getInputSurfaceHistory() finds messages via the preserved streamsSessionId, and
   * readSessionHistory() falls through to reading the JSONL file on disk.
   *
   * When a new message arrives for this stream, activateOrchestrator() creates
   * the live agent session pointing at the existing session_file.
   */
  rehydrateOrchestrator(
    streamId: string,
    streamName: string,
    streamsSessionId: string,
    sessionFile: string | null,
    createdAt: string,
    modelProvider: string | null,
    modelId: string | null,
  ): ManagedStreamsSession {
    const existing = this.orchestrators.get(streamId);
    if (existing) return existing;

    const state = new StreamsSessionState();
    state.initialize(streamsSessionId, sessionFile ?? undefined, 0);

    const managed: ManagedStreamsSession = {
      session: null,
      queue: null!,
      state,
      role: "orchestrator",
      streamId,
      streamName,
      streamsSessionId,
      createdAt,
      modelInfo: { provider: modelProvider ?? "unknown", id: modelId ?? "unknown" },
      unsubscribe: () => {},
    };

    const processCallback = this.processCallback;
    managed.queue = new TurnQueue({
      process: (item) => processCallback(managed, item),
      onItemStart: (item) => {
        state.setBusy(true, item);
        this.wsHub.broadcast({
          type: "status_changed",
          subsystem: "pi",
          timestamp: new Date().toISOString(),
        });
        this.wsHub.broadcast({
          type: "queue_item_start",
          item,
          sessionId: managed.streamsSessionId,
          streamId,
        });
      },
      onItemEnd: (item, error) => {
        state.setBusy(false);
        this.wsHub.broadcast({
          type: "status_changed",
          subsystem: "pi",
          timestamp: new Date().toISOString(),
        });
        if (error) {
          const apiErr = error instanceof Error ? (error as ApiError) : undefined;
          const detail = apiErr
            ? `${apiErr.message}${apiErr.status ? ` [status=${apiErr.status}]` : ""}${apiErr.body ? ` body=${JSON.stringify(apiErr.body).slice(0, 200)}` : ""}`
            : String(error);
          this.log(`queue item ${item.id} failed (orchestrator stream=${streamId}): ${detail}`);
          this.destroyOrchestrator(streamId, "crashed");
        }
        this.wsHub.broadcast({
          type: "queue_item_end",
          itemId: item.id,
          ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
          sessionId: managed.streamsSessionId,
          streamId,
        });
      },
    });

    // Update the DB row to reflect the new runtime instance
    upsertStreamsSession(this.blackboard, {
      streamsSessionId: streamsSessionId,
      role: "orchestrator",
      status: "waiting_for_user",
      runtimeInstanceId: this.runtimeInstanceId,
      pid: process.pid,
      sessionFile: sessionFile ?? undefined,
      cwd: this.config.projectsDir,
      startedAt: createdAt,
      lastEventAt: new Date().toISOString(),
      streamId: streamId,
    });

    this.orchestrators.set(streamId, managed);
    this.byStreamsSessionId.set(streamsSessionId, managed);
    this.log(
      `rehydrated dormant orchestrator for stream "${streamName}" (${streamId}) streamsSessionId=${streamsSessionId}`,
    );
    return managed;
  }

  /**
   * Activate a dormant orchestrator by creating a live SDK agent session that
   * resumes from the existing JSONL session_file. Called lazily when the first
   * message arrives for a rehydrated stream.
   */
  async activateOrchestrator(
    managed: ManagedStreamsSession,
    customTools?: unknown[],
  ): Promise<void> {
    if (managed.session) return; // already active
    if (!managed.streamId) throw new Error("Cannot activate non-stream session");

    const snapshot = managed.state.getSnapshot();
    const sessionFile = snapshot.sessionFile;

    const created = await createAutonomaAgent({
      config: this.config,
      customTools: customTools ?? [],
      role: "orchestrator",
      orchestratorContext: {
        streamName: managed.streamName ?? managed.streamId,
        streamId: managed.streamId,
      },
      resumeSessionFile: sessionFile && fs.existsSync(sessionFile) ? sessionFile : undefined,
    });

    managed.session = created.session;
    managed.modelInfo = created.modelInfo;
    managed.unsubscribe = subscribeToStreamsSession(
      created.session,
      managed.state,
      this.blackboard,
      this.wsHub,
    );

    // Re-initialize state with actual message count from the resumed session
    managed.state.initialize(
      created.session.sessionId,
      created.session.sessionFile,
      created.session.messages.length,
    );

    this.log(
      `activated dormant orchestrator for stream "${managed.streamName}" (${managed.streamId})`,
    );
    this.logResourceInfo("orchestrator", created.resourceInfo);
  }

  destroyOrchestrator(streamId: string, reason: string): void {
    const managed = this.orchestrators.get(streamId);
    if (!managed) return;

    managed.queue.stop();
    try {
      managed.unsubscribe();
    } catch {
      /* ignore */
    }
    try {
      managed.session?.dispose?.();
    } catch {
      /* ignore */
    }

    // On clean shutdown, leave the session in waiting_for_user so the rehydration
    // query finds it on next restart. Only permanently end on crash or explicit close.
    if (reason !== "shutdown") {
      const status = reason === "crashed" ? "crashed" : "ended";
      endStreamsSession(
        this.blackboard,
        managed.streamsSessionId,
        status,
        reason,
        new Date().toISOString(),
      );
    }

    this.orchestrators.delete(streamId);
    this.byStreamsSessionId.delete(managed.streamsSessionId);
    this.log(`orchestrator destroyed for stream "${managed.streamName}" (${streamId}): ${reason}`);
  }

  disposeAll(): void {
    // Dispose orchestrators first
    for (const [streamId] of this.orchestrators) {
      this.destroyOrchestrator(streamId, "shutdown");
    }

    // Dispose default
    if (this.defaultSession) {
      this.defaultSession.queue.stop();
      try {
        this.defaultSession.unsubscribe();
      } catch {
        /* ignore */
      }
      endStreamsSession(
        this.blackboard,
        this.defaultSession.streamsSessionId,
        "ended",
        "shutdown",
        new Date().toISOString(),
      );
      try {
        this.defaultSession.session?.dispose?.();
      } catch {
        /* ignore */
      }
      this.byStreamsSessionId.delete(this.defaultSession.streamsSessionId);
      this.defaultSession = undefined;
    }
  }

  /**
   * Build the initial prompt for a new orchestrator stream.
   */
  buildStreamPrompt(
    currentMessage: string,
    streamName: string,
    streamId: string,
    agentMessage?: string,
  ): string {
    return formatStreamPrompt([currentMessage], streamName, streamId, agentMessage);
  }

  private logResourceInfo(
    role: string,
    info: { skillNames: string[]; agentsFilePaths: string[] },
  ): void {
    const { skillNames, agentsFilePaths } = info;
    if (skillNames.length > 0) {
      this.log(
        `streams-agent (${role}): loaded ${skillNames.length} skills: ${skillNames.join(", ")}`,
      );
    } else {
      this.log(`streams-agent (${role}): no skills loaded`);
    }
    for (const filePath of agentsFilePaths) {
      this.log(`streams-agent (${role}): loaded ${path.basename(filePath)} from ${filePath}`);
    }
  }

  private buildManagedSession(
    created: { session: AgentSession; modelInfo: { provider: string; id: string } },
    state: StreamsSessionState,
    role: "default" | "orchestrator",
    streamId: string | null,
    streamName: string | null,
  ): ManagedStreamsSession {
    // Circular init: queue callback closes over `managed`, so the object must exist first.
    // null! signals deferred initialization — both fields are set immediately below.
    const managed: ManagedStreamsSession = {
      session: created.session,
      queue: null!,
      state,
      role,
      streamId,
      streamName,
      streamsSessionId: created.session.sessionId,
      createdAt: new Date().toISOString(),
      modelInfo: created.modelInfo,
      unsubscribe: null!,
    };

    const processCallback = this.processCallback;
    managed.queue = new TurnQueue({
      process: (item) => processCallback(managed, item),
      onItemStart: (item) => {
        state.setBusy(true, item);
        this.wsHub.broadcast({
          type: "status_changed",
          subsystem: "pi",
          timestamp: new Date().toISOString(),
        });
        this.wsHub.broadcast({
          type: "queue_item_start",
          item,
          sessionId: managed.streamsSessionId,
          ...(streamId ? { streamId } : {}),
        });
      },
      onItemEnd: (item, error) => {
        state.setBusy(false);
        this.wsHub.broadcast({
          type: "status_changed",
          subsystem: "pi",
          timestamp: new Date().toISOString(),
        });

        if (error) {
          const apiErr = error instanceof Error ? (error as ApiError) : undefined;
          const detail = apiErr
            ? `${apiErr.message}${apiErr.status ? ` [status=${apiErr.status}]` : ""}${apiErr.body ? ` body=${JSON.stringify(apiErr.body).slice(0, 200)}` : ""}`
            : String(error);
          this.log(
            `queue item ${item.id} failed (${role}${streamId ? ` stream=${streamId}` : ""}): ${detail}`,
          );
          if (role === "orchestrator" && streamId) {
            this.destroyOrchestrator(streamId, "crashed");
          }
        }
        this.wsHub.broadcast({
          type: "queue_item_end",
          itemId: item.id,
          ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
          sessionId: managed.streamsSessionId,
          ...(streamId ? { streamId } : {}),
        });
      },
    });

    managed.unsubscribe = subscribeToStreamsSession(
      created.session,
      state,
      this.blackboard,
      this.wsHub,
    );

    return managed;
  }
}
