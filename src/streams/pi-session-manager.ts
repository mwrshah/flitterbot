import fs from "node:fs";
import path from "node:path";
import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import {
  endPiSession,
  reassociateOrphanedSessions,
  reconcilePreviousPiSessions,
  upsertPiSession,
} from "../blackboard/pi-sessions.ts";
import { getStreamById } from "../blackboard/query-streams.ts";
import type { FlitterbotConfig, ThinkingLevel } from "../config/load-config.ts";
import type { ApiError } from "../contracts/blackboard.ts";
import type { ChatTimelineMessage } from "../contracts/timeline.ts";
import type { WebSocketHub } from "../ws/hub.ts";
import { createFlitterbotAgent } from "./create-agent.ts";
import { formatStreamPrompt } from "./format-stream-prompt.ts";
import { PiSessionState } from "./pi-session-state.ts";
import { subscribeToPiSession } from "./pi-subscribe.ts";
import { type QueueItem, TurnQueue } from "./turn-queue.ts";

export { formatStreamPrompt };

export interface ManagedPiSession {
  /** Live SDK runtime. Null for dormant sessions rehydrated from DB on restart. */
  runtime: AgentSessionRuntime | null;
  queue: TurnQueue;
  state: PiSessionState;
  role: "default" | "orchestrator";
  streamId: string | null;
  streamName: string | null;
  piSessionId: string;
  createdAt: string;
  /**
   * Current effective model for this session. `entryId` is the `config.models[].id`
   * that produced this model (used to skip redundant `setModel()` calls when the
   * same override arrives). `provider`+`id` are the pi SDK identifiers persisted
   * to `pi_sessions.model_provider` / `pi_sessions.model_id`.
   */
  modelInfo: {
    provider: string;
    id: string;
    entryId: string;
    thinkingLevel: ThinkingLevel;
  };
  unsubscribe: () => void;
  /** Set during close_stream tool execution; checked post-turn to destroy after the turn completes. */
  pendingDestroy?: boolean;
  /** Populated by pi-subscribe on agent_end; consumed by runtime.ts to broadcast stream_surfaced after persist. */
  lastSurfacedAssistantMessage?: ChatTimelineMessage;
}

export type ProcessQueueItemCallback = (
  managed: ManagedPiSession,
  item: QueueItem,
) => Promise<void>;

export class PiSessionManager {
  private defaultSession?: ManagedPiSession;
  private readonly orchestrators = new Map<string, ManagedPiSession>();
  private readonly byPiSessionId = new Map<string, ManagedPiSession>();
  private readonly config: FlitterbotConfig;
  private readonly blackboard: BlackboardDatabase;
  private readonly wsHub: WebSocketHub;
  private readonly runtimeInstanceId: string;
  private readonly startedAt: number;
  private readonly processCallback: ProcessQueueItemCallback;
  private readonly log: (message: string) => void;

  constructor(
    config: FlitterbotConfig,
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

  getByStream(streamId: string): ManagedPiSession | undefined {
    return this.orchestrators.get(streamId);
  }

  getByPiSessionId(piSessionId: string): ManagedPiSession | undefined {
    return this.byPiSessionId.get(piSessionId);
  }

  listOrchestrators(): ManagedPiSession[] {
    return Array.from(this.orchestrators.values());
  }

  async createDefault(customTools: unknown[]): Promise<ManagedPiSession> {
    // Only reconcile the default session — orchestrator sessions for active streams
    // must survive restarts so their piSessionId (and associated messages) are preserved.
    reconcilePreviousPiSessions(this.blackboard, "default", this.runtimeInstanceId, "restart");

    const created = await createFlitterbotAgent({
      config: this.config,
      customTools,
      role: "default",
    });

    const session = created.runtime.session;
    const state = new PiSessionState();
    state.initialize(session.sessionId, session.sessionFile, session.messages.length);

    const managed = this.buildManagedSession(created, state, "default", null, null);

    upsertPiSession(this.blackboard, {
      piSessionId: session.sessionId,
      role: "default",
      status: "waiting_for_user",
      runtimeInstanceId: this.runtimeInstanceId,
      pid: process.pid,
      sessionFile: session.sessionFile,
      cwd: this.config.projectsDir,
      agentDir: this.config.controlSurfaceAgentDir,
      modelProvider: created.modelInfo.provider,
      modelId: created.modelInfo.id,
      thinkingLevel: created.modelInfo.thinkingLevel,
      startedAt: new Date(this.startedAt).toISOString(),
      lastEventAt: new Date().toISOString(),
    });

    // Re-associate orphaned sessions from ended pi sessions to this new default session
    const reassociated = reassociateOrphanedSessions(this.blackboard, managed.piSessionId);
    if (reassociated > 0) {
      this.log(`reassociated ${reassociated} orphaned session(s) to new default pi session`);
    }

    this.defaultSession = managed;
    this.byPiSessionId.set(managed.piSessionId, managed);
    this.logResourceInfo("default", created.resourceInfo);
    return managed;
  }

  async createOrchestrator(
    streamId: string,
    streamName: string,
    repoPath?: string,
    customTools?: unknown[],
  ): Promise<ManagedPiSession> {
    // If one already exists for this stream, return it
    const existing = this.orchestrators.get(streamId);
    if (existing) return existing;

    const orchestratorContext = {
      streamName,
      streamId,
      repoPath,
    };

    const created = await createFlitterbotAgent({
      config: this.config,
      customTools: customTools ?? [],
      role: "orchestrator",
      orchestratorContext,
      cwd: repoPath,
      tmux2Enabled: this.config.tmux2Enabled,
    });

    const session = created.runtime.session;
    const state = new PiSessionState();
    state.initialize(session.sessionId, session.sessionFile, session.messages.length);

    const managed = this.buildManagedSession(created, state, "orchestrator", streamId, streamName);

    upsertPiSession(this.blackboard, {
      piSessionId: session.sessionId,
      role: "orchestrator",
      status: "waiting_for_user",
      runtimeInstanceId: this.runtimeInstanceId,
      pid: process.pid,
      sessionFile: session.sessionFile,
      cwd: repoPath ?? this.config.projectsDir,
      agentDir: this.config.controlSurfaceAgentDir,
      modelProvider: created.modelInfo.provider,
      modelId: created.modelInfo.id,
      thinkingLevel: created.modelInfo.thinkingLevel,
      startedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString(),
      streamId: streamId,
    });

    this.orchestrators.set(streamId, managed);
    this.byPiSessionId.set(managed.piSessionId, managed);
    this.log(`orchestrator created for stream "${streamName}" (${streamId})`);
    this.logResourceInfo("orchestrator", created.resourceInfo);
    return managed;
  }

  /**
   * Rehydrate a dormant orchestrator from a pi_sessions DB row.
   * No live SDK agent is created — just the in-memory maps are populated so that
   * getInputSurfaceHistory() finds messages via the preserved piSessionId, and
   * readSessionHistory() falls through to reading the JSONL file on disk.
   *
   * When a new message arrives for this stream, activateOrchestrator() creates
   * the live agent session pointing at the existing session_file.
   */
  rehydrateOrchestrator(
    streamId: string,
    streamName: string,
    piSessionId: string,
    sessionFile: string | null,
    createdAt: string,
    modelProvider: string | null,
    modelId: string | null,
  ): ManagedPiSession {
    const existing = this.orchestrators.get(streamId);
    if (existing) return existing;

    const state = new PiSessionState();
    state.initialize(piSessionId, sessionFile ?? undefined, 0);

    const stream = getStreamById(this.blackboard, streamId);
    const repoPath = stream?.repo_path ?? undefined;

    const managed: ManagedPiSession = {
      runtime: null,
      queue: null!,
      state,
      role: "orchestrator",
      streamId,
      streamName,
      piSessionId,
      createdAt,
      // Dormant sessions have no live SDK to query — record whatever the DB
      // last knew. entryId is unknown until activation, so leave it blank;
      // the first model override call will do a full setModel().
      modelInfo: {
        provider: modelProvider ?? "unknown",
        id: modelId ?? "unknown",
        entryId: "",
        thinkingLevel: this.config.defaultThinkingLevel,
      },
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
          piSessionId: managed.piSessionId,
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
          piSessionId: managed.piSessionId,
          streamId,
        });
      },
    });

    // Update the DB row to reflect the new runtime instance
    upsertPiSession(this.blackboard, {
      piSessionId: piSessionId,
      role: "orchestrator",
      status: "waiting_for_user",
      runtimeInstanceId: this.runtimeInstanceId,
      pid: process.pid,
      sessionFile: sessionFile ?? undefined,
      cwd: repoPath ?? this.config.projectsDir,
      startedAt: createdAt,
      lastEventAt: new Date().toISOString(),
      streamId: streamId,
    });

    this.orchestrators.set(streamId, managed);
    this.byPiSessionId.set(piSessionId, managed);
    this.log(
      `rehydrated dormant orchestrator for stream "${streamName}" (${streamId}) piSessionId=${piSessionId}`,
    );
    return managed;
  }

  /**
   * Activate a dormant orchestrator by creating a live SDK agent session that
   * resumes from the existing JSONL session_file. Called lazily when the first
   * message arrives for a rehydrated stream.
   */
  async activateOrchestrator(managed: ManagedPiSession, customTools?: unknown[]): Promise<void> {
    if (managed.runtime) return; // already active
    if (!managed.streamId) throw new Error("Cannot activate pi session without a stream");

    const snapshot = managed.state.getSnapshot();
    const sessionFile = snapshot.sessionFile;
    const stream = getStreamById(this.blackboard, managed.streamId);
    const repoPath = stream?.repo_path ?? undefined;

    const created = await createFlitterbotAgent({
      config: this.config,
      customTools: customTools ?? [],
      role: "orchestrator",
      orchestratorContext: {
        streamName: managed.streamName ?? managed.streamId,
        streamId: managed.streamId,
        repoPath,
      },
      cwd: repoPath,
      resumeSessionFile: sessionFile && fs.existsSync(sessionFile) ? sessionFile : undefined,
      tmux2Enabled: this.config.tmux2Enabled,
    });

    const session = created.runtime.session;
    managed.runtime = created.runtime;
    managed.modelInfo = created.modelInfo;
    managed.unsubscribe = subscribeToPiSession(
      session,
      managed.state,
      this.blackboard,
      this.wsHub,
      managed.streamId,
      managed.streamName,
      (lastAssistantMessage) => {
        managed.lastSurfacedAssistantMessage = lastAssistantMessage ?? undefined;
        if (managed.pendingDestroy && managed.streamId) {
          this.destroyOrchestrator(managed.streamId, "close_stream");
        }
      },
    );

    // Re-initialize state with actual message count from the resumed session
    managed.state.initialize(session.sessionId, session.sessionFile, session.messages.length);

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
      // dispose() is async on AgentSessionRuntime — fire and forget in sync context
      void managed.runtime?.dispose();
    } catch {
      /* ignore */
    }

    // On clean shutdown, leave the session in waiting_for_user so the rehydration
    // query finds it on next restart. Only permanently end on crash or explicit close.
    if (reason !== "shutdown") {
      const status = reason === "crashed" ? "crashed" : "ended";
      endPiSession(this.blackboard, managed.piSessionId, status, reason, new Date().toISOString());
      this.wsHub.broadcast({
        type: "status_changed",
        subsystem: "pi_session",
        timestamp: new Date().toISOString(),
      });
    }

    this.orchestrators.delete(streamId);
    this.byPiSessionId.delete(managed.piSessionId);
    this.log(`orchestrator destroyed for stream "${managed.streamName}" (${streamId}): ${reason}`);
  }

  /**
   * Reset the default session: end the old pi_session, call newSession() on
   * the SDK AgentSessionRuntime to tear down and recreate the session, update
   * all in-memory maps and DB rows, re-subscribe, and broadcast so the frontend
   * picks up the new piSessionId.
   */
  async resetDefault(): Promise<void> {
    const old = this.defaultSession;
    if (!old?.runtime) {
      throw new Error("No active default session to reset");
    }

    const oldPiSessionId = old.piSessionId;

    // 1. Stop queue and unsubscribe from SDK events
    old.queue.stop();
    try {
      old.unsubscribe();
    } catch {
      /* ignore */
    }

    // 2. End the old pi_session in the DB
    endPiSession(this.blackboard, oldPiSessionId, "ended", "clear", new Date().toISOString());

    // 3. Call newSession() on the AgentSessionRuntime — tears down old session,
    //    creates a new one via the stored factory
    await old.runtime.newSession();

    const newSession = old.runtime.session;
    const newPiSessionId = newSession.sessionId;
    const newSessionFile = newSession.sessionFile;

    // 4. Re-initialize state with the new session
    old.state.initialize(newPiSessionId, newSessionFile, newSession.messages.length);

    // 5. Update the managed session's piSessionId
    old.piSessionId = newPiSessionId;

    // 6. Upsert the new pi_sessions row
    upsertPiSession(this.blackboard, {
      piSessionId: newPiSessionId,
      role: "default",
      status: "waiting_for_user",
      runtimeInstanceId: this.runtimeInstanceId,
      pid: process.pid,
      sessionFile: newSessionFile,
      cwd: this.config.projectsDir,
      agentDir: this.config.controlSurfaceAgentDir,
      modelProvider: old.modelInfo.provider,
      modelId: old.modelInfo.id,
      thinkingLevel: old.modelInfo.thinkingLevel,
      startedAt: new Date(this.startedAt).toISOString(),
      lastEventAt: new Date().toISOString(),
    });

    // 7. Update byPiSessionId map
    this.byPiSessionId.delete(oldPiSessionId);
    this.byPiSessionId.set(newPiSessionId, old);

    // 8. Create a new TurnQueue (old one is stopped)
    const processCallback = this.processCallback;
    old.queue = new TurnQueue({
      process: (item) => processCallback(old, item),
      onItemStart: (item) => {
        old.state.setBusy(true, item);
        this.wsHub.broadcast({
          type: "status_changed",
          subsystem: "pi",
          timestamp: new Date().toISOString(),
        });
        this.wsHub.broadcast({
          type: "queue_item_start",
          item,
          piSessionId: old.piSessionId,
        });
      },
      onItemEnd: (item, error) => {
        old.state.setBusy(false);
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
          this.log(`queue item ${item.id} failed (default): ${detail}`);
        }
        this.wsHub.broadcast({
          type: "queue_item_end",
          itemId: item.id,
          ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
          piSessionId: old.piSessionId,
        });
      },
    });

    // 9. Re-subscribe to SDK events on the new session
    old.unsubscribe = subscribeToPiSession(
      newSession,
      old.state,
      this.blackboard,
      this.wsHub,
      null,
      null,
      (lastAssistantMessage) => {
        old.lastSurfacedAssistantMessage = lastAssistantMessage ?? undefined;
      },
    );

    // 10. Broadcast status_changed so frontend picks up the new piSessionId
    this.wsHub.broadcast({
      type: "status_changed",
      subsystem: "pi_session",
      timestamp: new Date().toISOString(),
    });

    this.log(`default session reset: ${oldPiSessionId} → ${newPiSessionId}`);
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
      endPiSession(
        this.blackboard,
        this.defaultSession.piSessionId,
        "ended",
        "shutdown",
        new Date().toISOString(),
      );
      try {
        void this.defaultSession.runtime?.dispose();
      } catch {
        /* ignore */
      }
      this.byPiSessionId.delete(this.defaultSession.piSessionId);
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
    footer?: string,
  ): string {
    return formatStreamPrompt([currentMessage], streamName, streamId, agentMessage, footer);
  }

  private logResourceInfo(
    role: string,
    info: { skillNames: string[]; agentsFilePaths: string[]; skillMessages?: string[] },
  ): void {
    const { skillNames, agentsFilePaths, skillMessages } = info;
    if (skillNames.length > 0) {
      this.log(`pi-agent (${role}): loaded ${skillNames.length} skills: ${skillNames.join(", ")}`);
    } else {
      this.log(`pi-agent (${role}): no skills loaded`);
    }
    for (const message of skillMessages ?? []) {
      this.log(`pi-agent (${role}): ${message}`);
    }
    for (const filePath of agentsFilePaths) {
      this.log(`pi-agent (${role}): loaded ${path.basename(filePath)} from ${filePath}`);
    }
  }

  private buildManagedSession(
    created: {
      runtime: AgentSessionRuntime;
      modelInfo: {
        provider: string;
        id: string;
        entryId: string;
        thinkingLevel: ThinkingLevel;
      };
    },
    state: PiSessionState,
    role: "default" | "orchestrator",
    streamId: string | null,
    streamName: string | null,
  ): ManagedPiSession {
    const session = created.runtime.session;
    // Circular init: queue callback closes over `managed`, so the object must exist first.
    // null! signals deferred initialization — both fields are set immediately below.
    const managed: ManagedPiSession = {
      runtime: created.runtime,
      queue: null!,
      state,
      role,
      streamId,
      streamName,
      piSessionId: session.sessionId,
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
          piSessionId: managed.piSessionId,
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
          piSessionId: managed.piSessionId,
          ...(streamId ? { streamId } : {}),
        });
      },
    });

    managed.unsubscribe = subscribeToPiSession(
      session,
      state,
      this.blackboard,
      this.wsHub,
      streamId,
      streamName,
      (lastAssistantMessage) => {
        managed.lastSurfacedAssistantMessage = lastAssistantMessage ?? undefined;
        if (managed.pendingDestroy && managed.streamId) {
          this.destroyOrchestrator(managed.streamId, "close_stream");
        }
      },
    );

    return managed;
  }
}
