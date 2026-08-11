import fs from "node:fs";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import {
  endPiSession,
  reassociateOrphanedSessions,
  reconcilePreviousPiSessions,
  replaceDefaultPiSession,
  upsertPiSession,
} from "../blackboard/pi-sessions.ts";
import {
  finalizeStreamCloseRows,
  getStreamById,
  getStreamPiSessionId,
  getStreamPiSessionRow,
  reopenStreamRows,
  rollbackStreamReopenRows,
  type StreamPiSessionRow,
  setStreamPinned as setStreamPinnedRow,
  updateStreamRepoPath,
} from "../blackboard/query-streams.ts";
import { type FlitterbotConfig, loadConfig } from "../config/load-config.ts";
import type { ApiError, MessageMetadata, StreamRow } from "../contracts/blackboard.ts";
import type { ChatTimelineMessage } from "../contracts/timeline.ts";
import type { WebSocketHub } from "../ws/hub.ts";
import { createFlitterbotAgent, readPiSessionHeaderId } from "./create-agent.ts";
import type { FlitterbotTool } from "./flitterbot-extension.ts";
import { formatStreamPrompt } from "./format-stream-prompt.ts";
import { PiSessionState } from "./pi-session-state.ts";
import { subscribeToPiSession } from "./pi-subscribe.ts";
import {
  classifySessionFileTopology,
  reconcileAllStreamSessionFiles,
  reconcileStreamSessionFiles,
} from "./session-file-placement.ts";
import { terminateDownstreamSessions } from "./terminate-downstream-sessions.ts";
import { createToolDisplayContextCache, type ToolDisplayContextCache } from "./tool-display.ts";
import { type QueueItem, TurnQueue } from "./turn-queue.ts";

export { formatStreamPrompt };

type ExpectedPiSessionId = string | null;

type StreamOperationContext = {
  streamId: string;
  expectedPiSessionId: ExpectedPiSessionId;
};

type CloseRequest = {
  streamId: string;
  piSessionId: string;
  requestedBy: "tool" | "api";
  finalizationStarted: boolean;
};

export interface ManagedPiSession {
  runtime: AgentSessionRuntime | null;
  queue: TurnQueue;
  state: PiSessionState;
  role: "default" | "orchestrator";
  streamId: string | null;
  streamName: string | null;
  piSessionId: string;
  createdAt: string;
  modelInfo: {
    provider: string;
    id: string;
    entryId: string;
    thinkingLevel: ModelThinkingLevel;
  };
  unsubscribe: () => void;
  closeRequested?: CloseRequest;
  lastSurfacedAssistantMessage?: ChatTimelineMessage;
  whatsappRemoteJid?: string;
}

export type ProcessQueueItemCallback = (
  managed: ManagedPiSession,
  item: QueueItem,
  steered?: boolean,
) => Promise<void>;

function rewriteSessionHeaderCwd(sessionFile: string, cwd: string): string | undefined {
  const content = fs.readFileSync(sessionFile, "utf8");
  const lines = content.split("\n");
  const headerLine = lines[0];
  if (!headerLine?.trim()) throw new Error(`Session file has no header: ${sessionFile}`);
  const header = JSON.parse(headerLine) as Record<string, unknown>;
  if (header.type !== "session")
    throw new Error(`Session file header is not a session: ${sessionFile}`);
  const previousCwd = typeof header.cwd === "string" ? header.cwd : undefined;
  header.cwd = cwd;
  lines[0] = JSON.stringify(header);
  fs.writeFileSync(sessionFile, lines.join("\n"));
  return previousCwd;
}

export class PiSessionManager {
  private defaultSession?: ManagedPiSession;
  private readonly streamSessions = new Map<string, ManagedPiSession>();
  private readonly byPiSessionId = new Map<string, ManagedPiSession>();
  private readonly blackboard: BlackboardDatabase;
  private readonly configLoader: () => FlitterbotConfig;
  private readonly wsHub: WebSocketHub;
  private readonly runtimeInstanceId: string;
  private readonly startedAt: number;
  private readonly processCallback: ProcessQueueItemCallback;
  private readonly log: (message: string) => void;
  private readonly streamOperationTails = new Map<string, Promise<void>>();
  readonly toolDisplayCache: ToolDisplayContextCache;

  constructor(
    blackboard: BlackboardDatabase,
    wsHub: WebSocketHub,
    runtimeInstanceId: string,
    startedAt: number,
    processCallback: ProcessQueueItemCallback,
    log: (message: string) => void,
    configLoader: () => FlitterbotConfig = loadConfig,
  ) {
    this.blackboard = blackboard;
    this.configLoader = configLoader;
    this.wsHub = wsHub;
    this.runtimeInstanceId = runtimeInstanceId;
    this.startedAt = startedAt;
    this.processCallback = processCallback;
    this.log = log;
    this.toolDisplayCache = createToolDisplayContextCache(blackboard);
  }

  private get config(): FlitterbotConfig {
    return this.configLoader();
  }

  getDefault(): ManagedPiSession | undefined {
    return this.defaultSession;
  }

  getByStream(streamId: string): ManagedPiSession | undefined {
    return this.streamSessions.get(streamId);
  }

  getByPiSessionId(piSessionId: string): ManagedPiSession | undefined {
    return this.byPiSessionId.get(piSessionId);
  }

  listStreamSessions(): ManagedPiSession[] {
    return Array.from(this.streamSessions.values());
  }

  assertDownstreamSessionStartAdmission(streamId: string, piSessionId?: string): void {
    const stream = getStreamById(this.blackboard, streamId);
    if (stream?.status !== "open") throw new Error("stream is not open");
    const managed = this.streamSessions.get(streamId);
    if (!managed) throw new Error("stream has no managed Pi session");
    if (!piSessionId) throw new Error("session start has no Pi session identity");
    if (managed.piSessionId !== piSessionId) {
      throw new Error(
        `stale Pi session identity: expected ${managed.piSessionId}, found ${piSessionId}`,
      );
    }
    managed.queue.assertAccepting();
  }

  getExpectedPiSessionId(streamId: string): ExpectedPiSessionId {
    return (
      this.streamSessions.get(streamId)?.piSessionId ??
      getStreamPiSessionId(this.blackboard, streamId) ??
      null
    );
  }

  async withStreamOperation<T>(
    context: StreamOperationContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.streamOperationTails.get(context.streamId) ?? Promise.resolve();
    const result = previous
      .catch(() => {})
      .then(async () => {
        this.assertExpectedPiSession(context);
        return operation();
      });
    const tail = result.then(
      () => {},
      () => {},
    );
    this.streamOperationTails.set(context.streamId, tail);
    try {
      return await result;
    } finally {
      if (this.streamOperationTails.get(context.streamId) === tail) {
        this.streamOperationTails.delete(context.streamId);
      }
    }
  }

  async interruptPiSession(piSessionId: string): Promise<{ bashAborted: boolean } | null> {
    const managed = this.byPiSessionId.get(piSessionId);
    if (!managed) return null;
    const interrupt = () => {
      let bashAborted = false;
      const session = managed.runtime?.session;
      if (session) {
        try {
          session.abort?.();
        } catch {}
        try {
          if (session.isBashRunning) {
            session.abortBash?.();
            bashAborted = true;
          }
        } catch {}
      }
      return { bashAborted };
    };
    if (!managed.streamId) return interrupt();
    return this.withStreamOperation(
      { streamId: managed.streamId, expectedPiSessionId: piSessionId },
      async () => interrupt(),
    );
  }

  async withActiveStreamOperation<T>(
    context: StreamOperationContext,
    customTools: FlitterbotTool[],
    operation: (managed: ManagedPiSession) => Promise<T> | T,
  ): Promise<T> {
    return this.withStreamOperation(context, async () => {
      const managed = this.streamSessions.get(context.streamId);
      if (!managed) throw new Error(`No stream session for stream ${context.streamId}`);
      await this.activateStreamSessionOnce(managed, customTools);
      return operation(managed);
    });
  }

  async withIdleActiveStreamOperation<T>(
    context: StreamOperationContext,
    customTools: FlitterbotTool[],
    operation: (managed: ManagedPiSession) => Promise<T> | T,
  ): Promise<T> {
    return this.withStreamOperation(context, async () => {
      const managed = this.streamSessions.get(context.streamId);
      if (!managed) throw new Error(`No stream session for stream ${context.streamId}`);
      if (!managed.queue.pause()) throw new Error("Pi session is busy");
      try {
        await this.activateStreamSessionOnce(managed, customTools);
        return await operation(managed);
      } finally {
        managed.queue.resume();
      }
    });
  }

  requestStreamClose(
    streamId: string,
    expectedPiSessionId: string,
    requestedBy: CloseRequest["requestedBy"],
  ): void {
    const managed = this.streamSessions.get(streamId);
    if (!managed || managed.piSessionId !== expectedPiSessionId) {
      throw new Error(
        `Pi session identity changed for stream ${streamId}: expected ${expectedPiSessionId}, found ${managed?.piSessionId ?? "none"}`,
      );
    }
    const stream = getStreamById(this.blackboard, streamId);
    if (stream?.status !== "open") {
      throw new Error(`Stream is not open: ${streamId}`);
    }
    managed.closeRequested = {
      streamId,
      piSessionId: expectedPiSessionId,
      requestedBy,
      finalizationStarted: requestedBy === "api",
    };
  }

  async closeStreamSession<T>(
    context: StreamOperationContext & { expectedPiSessionId: string },
    prepare: () => Promise<T>,
  ): Promise<T> {
    const admission = this.streamSessions.get(context.streamId)?.queue;
    admission?.freezeAdmission();
    try {
      return await this.withPausedStreamOperation(context, async (managed) => {
        let result: T;
        try {
          result = await prepare();
        } catch (error) {
          managed?.queue.restoreAdmission();
          throw error;
        }
        if (managed) {
          this.requestStreamClose(context.streamId, context.expectedPiSessionId, "api");
        }
        try {
          await this.finalizeStreamCloseWithinOperation(
            context.streamId,
            context.expectedPiSessionId,
          );
        } catch (error) {
          if (managed) {
            managed.closeRequested = undefined;
            managed.queue.restoreAdmission();
          }
          throw error;
        }
        return result;
      });
    } catch (error) {
      this.streamSessions.get(context.streamId)?.queue.restoreAdmission();
      throw error;
    }
  }

  private async withPausedStreamOperation<T>(
    context: StreamOperationContext,
    operation: (managed: ManagedPiSession | undefined) => Promise<T>,
  ): Promise<T> {
    for (;;) {
      await this.streamSessions.get(context.streamId)?.queue.waitForIdle();
      const outcome = await this.withStreamOperation(context, async () => {
        const managed = this.streamSessions.get(context.streamId);
        if (managed && !managed.queue.pause() && !managed.queue.isStopped()) {
          return { retry: true as const };
        }
        try {
          return { retry: false as const, result: await operation(managed) };
        } catch (error) {
          managed?.queue.resume();
          throw error;
        }
      });
      if (!outcome.retry) return outcome.result;
    }
  }

  async finalizeStreamClose(streamId: string, expectedPiSessionId: string): Promise<void> {
    await this.withStreamOperation({ streamId, expectedPiSessionId }, () =>
      this.finalizeStreamCloseWithinOperation(streamId, expectedPiSessionId),
    );
  }

  async setStreamPinned(
    context: StreamOperationContext,
    pinned: boolean,
  ): Promise<{ ok: true; streamId: string; pinned: boolean }> {
    return this.withStreamOperation(context, async () => {
      const previous = getStreamById(this.blackboard, context.streamId);
      if (!previous) throw new Error(`Stream not found: ${context.streamId}`);
      const stream = setStreamPinnedRow(this.blackboard, context.streamId, pinned);
      if (!stream) throw new Error(`Stream not found: ${context.streamId}`);
      try {
        reconcileStreamSessionFiles(
          this.blackboard,
          context.streamId,
          this.config.controlSurfaceSessionsDir,
          this.config.controlSurfaceArchivedSessionsDir,
        );
      } catch (error) {
        setStreamPinnedRow(this.blackboard, context.streamId, Boolean(previous.pinned));
        try {
          reconcileStreamSessionFiles(
            this.blackboard,
            context.streamId,
            this.config.controlSurfaceSessionsDir,
            this.config.controlSurfaceArchivedSessionsDir,
          );
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Failed to change pin state and restore session-file placement for stream ${context.streamId}`,
          );
        }
        throw error;
      }
      this.wsHub.broadcast({
        type: "streams_changed",
        reason: "pinned",
        streamId: context.streamId,
        streamName: stream.name,
      });
      return { ok: true, streamId: context.streamId, pinned: Boolean(stream.pinned) };
    });
  }

  reconcileAllStreamSessionFiles(): void {
    reconcileAllStreamSessionFiles(
      this.blackboard,
      this.config.controlSurfaceSessionsDir,
      this.config.controlSurfaceArchivedSessionsDir,
    );
  }

  requireRestorableStreamPiSession(streamId: string): StreamPiSessionRow {
    const sessionRow = getStreamPiSessionRow(this.blackboard, streamId);
    if (!sessionRow) throw new Error(`Stream ${streamId} has no linked Pi session`);
    this.assertValidPersistedSession(sessionRow);
    return sessionRow;
  }

  async reopenStreamSession(context: StreamOperationContext): Promise<ManagedPiSession> {
    return this.withStreamOperation(context, async () => {
      const stream = getStreamById(this.blackboard, context.streamId);
      if (!stream) throw new Error(`Stream not found: ${context.streamId}`);

      const sessionRow = this.requireRestorableStreamPiSession(context.streamId);
      const hasDeadPiSession =
        stream.status === "open" &&
        sessionRow.status !== "active" &&
        sessionRow.status !== "waiting_for_user" &&
        sessionRow.status !== "waiting_for_sessions";
      if (stream.status !== "closed" && !hasDeadPiSession) {
        throw new Error("Stream is not closed and has no recoverable pi-session");
      }

      const stale = this.streamSessions.get(context.streamId);
      if (stale) await this.disposeManagedStreamSession(stale);

      try {
        const reopenedAt = new Date().toISOString();
        reopenStreamRows(this.blackboard, context.streamId, sessionRow.pi_session_id, reopenedAt);
        reconcileStreamSessionFiles(
          this.blackboard,
          context.streamId,
          this.config.controlSurfaceSessionsDir,
          this.config.controlSurfaceArchivedSessionsDir,
        );

        const restored = getStreamPiSessionRow(this.blackboard, context.streamId);
        if (!restored?.session_file || !fs.existsSync(restored.session_file)) {
          throw new Error(`Restored session file is missing for stream ${context.streamId}`);
        }
        const headerPiSessionId = readPiSessionHeaderId(restored.session_file);
        if (headerPiSessionId !== restored.pi_session_id) {
          throw new Error(
            `Restored session file identity mismatch for stream ${context.streamId}: expected ${restored.pi_session_id}, found ${headerPiSessionId}`,
          );
        }
        const managed = this.rehydrateStreamSession(
          context.streamId,
          stream.name,
          restored.pi_session_id,
          restored.session_file,
          restored.started_at,
          restored.model_provider,
          restored.model_id,
        );

        this.wsHub.broadcast({
          type: "streams_changed",
          reason: "reopened",
          streamId: context.streamId,
          streamName: stream.name,
        });
        return managed;
      } catch (error) {
        this.rollbackFailedReopen(stream, sessionRow);
        throw error;
      }
    });
  }

  private rollbackFailedReopen(stream: StreamRow, sessionRow: StreamPiSessionRow): void {
    rollbackStreamReopenRows(this.blackboard, stream, {
      piSessionId: sessionRow.pi_session_id,
      status: sessionRow.status,
      endedAt: sessionRow.ended_at,
      endReason: sessionRow.end_reason,
      lastEventAt: sessionRow.last_event_at,
    });
    reconcileStreamSessionFiles(
      this.blackboard,
      stream.id,
      this.config.controlSurfaceSessionsDir,
      this.config.controlSurfaceArchivedSessionsDir,
    );
  }

  private assertExpectedPiSession(context: StreamOperationContext): void {
    const managedPiSessionId = this.streamSessions.get(context.streamId)?.piSessionId ?? null;
    const persistedPiSessionId = getStreamPiSessionId(this.blackboard, context.streamId) ?? null;
    if (managedPiSessionId && managedPiSessionId !== persistedPiSessionId) {
      throw new Error(
        `Managed Pi session identity for stream ${context.streamId} is stale: managed ${managedPiSessionId}, persisted ${persistedPiSessionId ?? "none"}`,
      );
    }
    const actual = persistedPiSessionId ?? managedPiSessionId;
    if (actual !== context.expectedPiSessionId) {
      throw new Error(
        `Pi session identity changed for stream ${context.streamId}: expected ${context.expectedPiSessionId ?? "none"}, found ${actual ?? "none"}`,
      );
    }
  }

  private assertValidPersistedSession(row: StreamPiSessionRow): void {
    if (!row.session_file) {
      throw new Error(`Pi session ${row.pi_session_id} has no materialized session file`);
    }
    const topology = classifySessionFileTopology(
      {
        piSessionId: row.pi_session_id,
        streamId: "reopen-validation",
        sessionFile: row.session_file,
      },
      this.config.controlSurfaceSessionsDir,
      this.config.controlSurfaceArchivedSessionsDir,
    );
    if (!topology.physicalPath) {
      throw new Error(`Pi session file is missing for ${row.pi_session_id}: ${row.session_file}`);
    }
    const headerPiSessionId = readPiSessionHeaderId(topology.physicalPath);
    if (headerPiSessionId !== row.pi_session_id) {
      throw new Error(
        `Pi session file identity mismatch: expected ${row.pi_session_id}, found ${headerPiSessionId}`,
      );
    }
  }

  private async finalizeStreamCloseWithinOperation(
    streamId: string,
    expectedPiSessionId: string,
  ): Promise<void> {
    const stream = getStreamById(this.blackboard, streamId);
    if (!stream) throw new Error(`Stream not found: ${streamId}`);

    const sessionRow = this.requireRestorableStreamPiSession(streamId);
    if (sessionRow.pi_session_id !== expectedPiSessionId) {
      throw new Error(
        `Pi session identity changed for stream ${streamId}: expected ${expectedPiSessionId}, found ${sessionRow.pi_session_id}`,
      );
    }

    const managed = this.streamSessions.get(streamId);
    try {
      if (managed) await this.quiesceManagedSession(managed);
      await terminateDownstreamSessions(this.blackboard, streamId);
      if (stream.status !== "closed") {
        finalizeStreamCloseRows(
          this.blackboard,
          streamId,
          expectedPiSessionId,
          new Date().toISOString(),
        );
      }
    } catch (error) {
      if (managed) this.restoreManagedAfterFailedClose(managed);
      throw error;
    }
    if (managed) this.removeManagedStreamSession(managed);

    try {
      reconcileStreamSessionFiles(
        this.blackboard,
        streamId,
        this.config.controlSurfaceSessionsDir,
        this.config.controlSurfaceArchivedSessionsDir,
      );
    } finally {
      this.wsHub.broadcast({
        type: "streams_changed",
        reason: "closed",
        streamId,
        streamName: stream.name,
      });
      this.wsHub.broadcast({
        type: "status_changed",
        subsystem: "pi_session",
        timestamp: new Date().toISOString(),
      });
      this.log(
        `${managed?.role ?? "stream"} destroyed for stream "${stream.name}" (${streamId}): stream_closed`,
      );
    }
  }

  private async quiesceManagedSession(managed: ManagedPiSession): Promise<void> {
    await managed.queue.stopAndWait();
    let settlementError: unknown;
    try {
      await managed.runtime?.session.waitForIdle();
    } catch (error) {
      settlementError = error;
    }
    try {
      const disposalError = await this.disposeManagedRuntime(managed);
      if (settlementError) throw settlementError;
      if (disposalError) throw disposalError;
    } finally {
      managed.closeRequested = undefined;
    }
  }

  private async disposeManagedRuntime(managed: ManagedPiSession): Promise<unknown> {
    const runtime = managed.runtime;
    if (!runtime) return undefined;
    let gracefulError: unknown;
    try {
      await runtime.dispose();
    } catch (error) {
      gracefulError = error;
      try {
        runtime.session.dispose();
      } catch (forcedError) {
        this.log(
          `Pi runtime shutdown remains unconfirmed: ${forcedError instanceof Error ? forcedError.message : String(forcedError)}`,
        );
        throw error;
      }
    }
    try {
      managed.unsubscribe();
    } catch {}
    managed.runtime = null;
    return gracefulError;
  }

  private restoreManagedAfterFailedClose(managed: ManagedPiSession): void {
    managed.closeRequested = undefined;
    if (!managed.queue.isStopped()) {
      managed.queue.restoreAdmission();
    } else if (!managed.runtime && managed.streamId) {
      this.attachQueue(managed, managed.state, managed.streamId);
    }
  }

  recoverFailedToolClose(streamId: string, piSessionId: string): void {
    const managed = this.streamSessions.get(streamId);
    if (!managed || managed.piSessionId !== piSessionId) return;
    this.restoreManagedAfterFailedClose(managed);
  }

  private removeManagedStreamSession(managed: ManagedPiSession): void {
    if (!managed.streamId) return;
    this.streamSessions.delete(managed.streamId);
    this.byPiSessionId.delete(managed.piSessionId);
    this.toolDisplayCache.deletePiSession(managed.piSessionId);
  }

  private async disposeManagedStreamSession(managed: ManagedPiSession): Promise<void> {
    await this.quiesceManagedSession(managed);
    this.removeManagedStreamSession(managed);
  }

  async createDefault(
    customTools: FlitterbotTool[],
    resumeSessionFile?: string,
  ): Promise<ManagedPiSession> {
    reconcilePreviousPiSessions(this.blackboard, "default", this.runtimeInstanceId, "restart");

    const created = await createFlitterbotAgent({
      customTools,
      role: "default",
      resumeSessionFile,
    });

    const session = created.runtime.session;
    const state = new PiSessionState();
    state.initialize(session.sessionId, session.sessionFile, session.messages.length);

    const managed = this.buildManagedSession(created, state, "default", null, null);

    let reassociated: number;
    try {
      upsertPiSession(this.blackboard, {
        piSessionId: session.sessionId,
        role: "default",
        status: "waiting_for_user",
        runtimeInstanceId: this.runtimeInstanceId,
        pid: process.pid,
        sessionFile: session.sessionFile,
        cwd: this.config.projectsDir,
        agentDir: this.config.piAgentDir,
        modelProvider: created.modelInfo.provider,
        modelId: created.modelInfo.id,
        thinkingLevel: created.modelInfo.thinkingLevel,
        startedAt: new Date(this.startedAt).toISOString(),
        lastEventAt: new Date().toISOString(),
      });
      reassociated = reassociateOrphanedSessions(this.blackboard, managed.piSessionId);
    } catch (error) {
      await this.disposeUnpublishedManaged(managed);
      throw error;
    }

    if (reassociated > 0) {
      this.log(`reassociated ${reassociated} orphaned session(s) to new default pi session`);
    }

    this.defaultSession = managed;
    this.byPiSessionId.set(managed.piSessionId, managed);
    this.logResourceMessages("default", created.resourceMessages);
    return managed;
  }

  async createOrchestrator(
    streamId: string,
    streamName: string,
    repoPath?: string,
    customTools?: FlitterbotTool[],
    resumeSessionFile?: string,
  ): Promise<ManagedPiSession> {
    const existing = this.streamSessions.get(streamId);
    if (existing) return existing;
    return this.withStreamOperation(
      { streamId, expectedPiSessionId: this.getExpectedPiSessionId(streamId) },
      () =>
        this.createStreamSession(
          "orchestrator",
          streamId,
          streamName,
          repoPath,
          customTools,
          resumeSessionFile,
        ),
    );
  }

  async createDefaultStream(
    streamId: string,
    streamName: string,
    repoPath?: string,
    customTools?: FlitterbotTool[],
  ): Promise<ManagedPiSession> {
    const existing = this.streamSessions.get(streamId);
    if (existing) return existing;
    return this.withStreamOperation(
      { streamId, expectedPiSessionId: this.getExpectedPiSessionId(streamId) },
      () => this.createStreamSession("default", streamId, streamName, repoPath, customTools),
    );
  }

  private async createStreamSession(
    agentRole: "default" | "orchestrator",
    streamId: string,
    streamName: string,
    repoPath?: string,
    customTools?: FlitterbotTool[],
    resumeSessionFile?: string,
  ): Promise<ManagedPiSession> {
    const existing = this.streamSessions.get(streamId);
    if (existing) return existing;

    const created = await createFlitterbotAgent({
      customTools: customTools ?? [],
      role: agentRole,
      orchestratorContext:
        agentRole === "orchestrator" ? { streamName, streamId, repoPath } : undefined,
      cwd: repoPath,
      resumeSessionFile,
    });

    const session = created.runtime.session;
    const state = new PiSessionState();
    state.initialize(session.sessionId, session.sessionFile, session.messages.length);

    const managed = this.buildManagedSession(created, state, "orchestrator", streamId, streamName);

    try {
      upsertPiSession(this.blackboard, {
        piSessionId: session.sessionId,
        role: "orchestrator",
        status: "waiting_for_user",
        runtimeInstanceId: this.runtimeInstanceId,
        pid: process.pid,
        sessionFile: session.sessionFile,
        cwd: repoPath ?? this.config.projectsDir,
        agentDir: this.config.piAgentDir,
        modelProvider: created.modelInfo.provider,
        modelId: created.modelInfo.id,
        thinkingLevel: created.modelInfo.thinkingLevel,
        startedAt: new Date().toISOString(),
        lastEventAt: new Date().toISOString(),
        streamId,
      });
    } catch (error) {
      await this.disposeUnpublishedManaged(managed);
      throw error;
    }

    this.streamSessions.set(streamId, managed);
    this.byPiSessionId.set(managed.piSessionId, managed);
    this.log(`${agentRole} agent created for stream "${streamName}" (${streamId})`);
    this.logResourceMessages(agentRole, created.resourceMessages);
    return managed;
  }

  rehydrateStreamSession(
    streamId: string,
    streamName: string,
    piSessionId: string,
    sessionFile: string | null,
    createdAt: string,
    modelProvider: string | null,
    modelId: string | null,
  ): ManagedPiSession {
    const existing = this.streamSessions.get(streamId);
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
      modelInfo: {
        provider: modelProvider ?? "unknown",
        id: modelId ?? "unknown",
        entryId: "",
        thinkingLevel: this.config.defaultThinkingLevel,
      },
      unsubscribe: () => {},
      whatsappRemoteJid: this.findLatestWhatsAppRemoteJid(streamId),
    };

    this.attachQueue(managed, state, streamId);

    upsertPiSession(this.blackboard, {
      piSessionId,
      role: "orchestrator",
      status: "waiting_for_user",
      runtimeInstanceId: this.runtimeInstanceId,
      pid: process.pid,
      sessionFile: sessionFile ?? undefined,
      cwd: repoPath ?? this.config.projectsDir,
      startedAt: createdAt,
      lastEventAt: new Date().toISOString(),
      streamId,
    });

    this.streamSessions.set(streamId, managed);
    this.byPiSessionId.set(piSessionId, managed);
    this.log(
      `rehydrated dormant stream session for "${streamName}" (${streamId}) piSessionId=${piSessionId}`,
    );
    return managed;
  }

  async activateStreamSession(
    managed: ManagedPiSession,
    customTools?: FlitterbotTool[],
  ): Promise<void> {
    if (!managed.streamId) throw new Error("Cannot activate pi session without a stream");
    await this.withStreamOperation(
      { streamId: managed.streamId, expectedPiSessionId: managed.piSessionId },
      () => this.activateStreamSessionOnce(managed, customTools),
    );
  }

  private async activateStreamSessionOnce(
    managed: ManagedPiSession,
    customTools?: FlitterbotTool[],
  ): Promise<void> {
    if (managed.runtime) return;
    if (!managed.streamId) throw new Error("Cannot activate pi session without a stream");
    if (managed.role === "default") throw new Error("Default session is not stream-backed");

    managed.queue.freezeAdmission();
    try {
      const sessionFile = managed.state.getSnapshot().sessionFile;
      if (!sessionFile) {
        throw new Error(
          `Cannot activate stream ${managed.streamId}: Pi session ${managed.piSessionId} has no materialized session file`,
        );
      }
      if (!fs.existsSync(sessionFile)) {
        throw new Error(
          `Cannot activate stream ${managed.streamId}: Pi session file is missing: ${sessionFile}`,
        );
      }
      const headerPiSessionId = readPiSessionHeaderId(sessionFile);
      if (headerPiSessionId !== managed.piSessionId) {
        throw new Error(
          `Cannot activate stream ${managed.streamId}: session file identity mismatch; expected ${managed.piSessionId}, found ${headerPiSessionId}`,
        );
      }

      const stream = getStreamById(this.blackboard, managed.streamId);
      const repoPath = stream?.repo_path ?? undefined;
      const agentRole = stream?.type === "defaultStream" ? "default" : "orchestrator";
      const created = await createFlitterbotAgent({
        customTools: customTools ?? [],
        role: agentRole,
        orchestratorContext:
          agentRole === "orchestrator"
            ? {
                streamName: managed.streamName ?? managed.streamId,
                streamId: managed.streamId,
                repoPath,
              }
            : undefined,
        cwd: repoPath,
        resumeSessionFile: sessionFile,
        expectedPiSessionId: managed.piSessionId,
      });

      const session = created.runtime.session;
      managed.runtime = created.runtime;
      managed.modelInfo = created.modelInfo;
      managed.state.initialize(session.sessionId, session.sessionFile, session.messages.length);
      managed.unsubscribe = this.subscribeManagedSession(managed, session, managed.state);

      this.log(
        `activated dormant ${agentRole} agent for stream "${managed.streamName}" (${managed.streamId})`,
      );
      this.logResourceMessages(agentRole, created.resourceMessages);
    } finally {
      managed.queue.restoreAdmission();
    }
  }

  async destroyStreamSession(
    streamId: string,
    expectedPiSessionId: string,
    reason: string,
  ): Promise<void> {
    await this.withPausedStreamOperation({ streamId, expectedPiSessionId }, async (managed) => {
      if (!managed) return;

      await this.quiesceManagedSession(managed);
      if (reason !== "shutdown") {
        const status = reason === "crashed" ? "crashed" : "ended";
        endPiSession(
          this.blackboard,
          managed.piSessionId,
          status,
          reason,
          new Date().toISOString(),
        );
        this.wsHub.broadcast({
          type: "status_changed",
          subsystem: "pi_session",
          timestamp: new Date().toISOString(),
        });
      }

      this.removeManagedStreamSession(managed);
      this.log(
        `${managed.role} destroyed for stream "${managed.streamName}" (${streamId}): ${reason}`,
      );
    });
  }

  async switchStreamCwd(
    streamId: string,
    cwd: string,
    customTools?: FlitterbotTool[],
  ): Promise<ManagedPiSession> {
    const expectedPiSessionId = this.getExpectedPiSessionId(streamId);
    return this.withIdleActiveStreamOperation(
      { streamId, expectedPiSessionId },
      customTools ?? [],
      async (managed) => {
        const switched = await this.switchStreamCwdWithinOperation(managed, cwd);
        updateStreamRepoPath(this.blackboard, streamId, cwd);
        this.blackboard
          .prepare(
            `UPDATE pi_sessions
           SET cwd = ?, last_event_at = ?
           WHERE pi_session_id = ?`,
          )
          .run(cwd, new Date().toISOString(), switched.piSessionId);
        this.wsHub.broadcast({
          type: "streams_changed",
          reason: "cwd_changed",
          streamId,
          streamName: managed.streamName ?? undefined,
        });
        this.wsHub.broadcast({
          type: "worktree_changed",
          piSessionId: switched.piSessionId,
          streamId,
        });
        this.wsHub.broadcast({
          type: "status_changed",
          subsystem: "pi_session",
          timestamp: new Date().toISOString(),
        });
        return switched;
      },
    );
  }

  private async switchStreamCwdWithinOperation(
    managed: ManagedPiSession,
    cwd: string,
  ): Promise<ManagedPiSession> {
    const streamId = managed.streamId;
    if (!streamId) throw new Error("No stream session for stream");
    if (managed.role !== "orchestrator")
      throw new Error("cwd switch is only supported for streams");
    if (!managed.runtime) throw new Error("Cannot switch cwd for a dormant stream session");
    if (managed.state.getSnapshot().busy)
      throw new Error("Cannot switch cwd while session is busy");

    const sessionFile = managed.runtime.session.sessionFile;
    if (!sessionFile) throw new Error("Cannot switch cwd for a session without a session file");
    if (!fs.existsSync(sessionFile)) throw new Error(`Session file does not exist: ${sessionFile}`);
    const headerPiSessionId = readPiSessionHeaderId(sessionFile);
    if (headerPiSessionId !== managed.piSessionId) {
      throw new Error(
        `Stream session file identity mismatch: expected ${managed.piSessionId}, found ${headerPiSessionId}`,
      );
    }

    const previousCwd = rewriteSessionHeaderCwd(sessionFile, cwd);

    try {
      const switchResult = await managed.runtime.switchSession(sessionFile);
      if (switchResult.cancelled) {
        if (previousCwd !== undefined) rewriteSessionHeaderCwd(sessionFile, previousCwd);
        throw new Error("cwd switch cancelled by session hook");
      }
    } catch (error) {
      if (previousCwd !== undefined) rewriteSessionHeaderCwd(sessionFile, previousCwd);
      throw error;
    }

    const session = managed.runtime.session;
    if (session.sessionId !== managed.piSessionId) {
      throw new Error(
        `Pi session identity changed during cwd switch: expected ${managed.piSessionId}, found ${session.sessionId}`,
      );
    }
    managed.state.initialize(session.sessionId, session.sessionFile, session.messages.length);
    managed.modelInfo = {
      provider: session.model?.provider ?? managed.modelInfo.provider,
      id: session.model?.id ?? managed.modelInfo.id,
      entryId: managed.modelInfo.entryId,
      thinkingLevel: session.thinkingLevel,
    };

    try {
      managed.unsubscribe();
    } catch {}
    managed.unsubscribe = subscribeToPiSession(
      session,
      managed.state,
      this.blackboard,
      this.wsHub,
      this.toolDisplayCache,
      managed.streamId,
      managed.streamName,
      (lastAssistantMessage) => {
        managed.lastSurfacedAssistantMessage = lastAssistantMessage ?? undefined;
      },
      () => managed.queue.steerPendingHooks(),
      () => managed.queue.enableSteering(),
    );

    this.toolDisplayCache.invalidatePiSession(managed.piSessionId);
    this.log(`switched cwd for stream "${managed.streamName}" (${streamId}) to ${cwd}`);
    return managed;
  }

  async resetDefault(): Promise<void> {
    const managed = this.defaultSession;
    if (!managed?.runtime) {
      throw new Error("No active default session to reset");
    }

    const { oldPiSessionId, newPiSessionId } = await this.resetDefaultSession(managed);

    this.log(`default session reset: ${oldPiSessionId} → ${newPiSessionId}`);
  }

  private async resetDefaultSession(
    managed: ManagedPiSession,
  ): Promise<{ oldPiSessionId: string; newPiSessionId: string }> {
    if (!managed.runtime) throw new Error("No active pi session to reset");

    const oldPiSessionId = managed.piSessionId;

    await managed.queue.stopAndWait();
    try {
      managed.unsubscribe();
    } catch {}

    let resetResult: { cancelled: boolean };
    try {
      resetResult = await managed.runtime.newSession();
    } catch (error) {
      await this.discardManagedAfterFailedReset(managed, oldPiSessionId);
      throw error;
    }
    if (resetResult.cancelled) {
      this.attachQueue(managed, managed.state, null);
      managed.unsubscribe = this.subscribeManagedSession(
        managed,
        managed.runtime.session,
        managed.state,
      );
      throw new Error("Session reset cancelled by session hook");
    }

    const newSession = managed.runtime.session;
    const newPiSessionId = newSession.sessionId;
    const newSessionFile = newSession.sessionFile;
    const now = new Date().toISOString();
    const newModelInfo = {
      provider: newSession.model?.provider ?? managed.modelInfo.provider,
      id: newSession.model?.id ?? managed.modelInfo.id,
      entryId: managed.modelInfo.entryId,
      thinkingLevel: newSession.thinkingLevel,
    };

    try {
      replaceDefaultPiSession(
        this.blackboard,
        oldPiSessionId,
        {
          piSessionId: newPiSessionId,
          role: "default",
          status: "waiting_for_user",
          runtimeInstanceId: this.runtimeInstanceId,
          pid: process.pid,
          sessionFile: newSessionFile,
          cwd: this.config.projectsDir,
          agentDir: this.config.piAgentDir,
          modelProvider: newModelInfo.provider,
          modelId: newModelInfo.id,
          thinkingLevel: newModelInfo.thinkingLevel,
          startedAt: now,
          lastEventAt: now,
        },
        { status: "ended", endedAt: now, endReason: "clear" },
      );
    } catch (error) {
      await this.discardManagedAfterFailedReset(managed, oldPiSessionId, now);
      throw error;
    }

    this.toolDisplayCache.deletePiSession(oldPiSessionId);
    managed.state.initialize(newPiSessionId, newSessionFile, newSession.messages.length);
    managed.piSessionId = newPiSessionId;
    managed.modelInfo = newModelInfo;

    this.byPiSessionId.delete(oldPiSessionId);
    this.byPiSessionId.set(newPiSessionId, managed);

    this.attachQueue(managed, managed.state, null);
    this.toolDisplayCache.invalidatePiSession(newPiSessionId);
    managed.unsubscribe = this.subscribeManagedSession(managed, newSession, managed.state);

    this.wsHub.broadcast({
      type: "status_changed",
      subsystem: "pi_session",
      timestamp: new Date().toISOString(),
    });

    return { oldPiSessionId, newPiSessionId };
  }

  private async discardManagedAfterFailedReset(
    managed: ManagedPiSession,
    oldPiSessionId: string,
    failedAt = new Date().toISOString(),
  ): Promise<void> {
    try {
      const disposalError = await this.disposeManagedRuntime(managed);
      if (disposalError) {
        this.log(
          `Pi runtime required forced disposal after reset failure: ${disposalError instanceof Error ? disposalError.message : String(disposalError)}`,
        );
      }
    } catch (error) {
      this.log(
        `retaining quarantined Pi runtime after reset failure: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.wsHub.broadcast({
        type: "status_changed",
        subsystem: "pi_session",
        timestamp: failedAt,
      });
      return;
    }
    try {
      endPiSession(this.blackboard, oldPiSessionId, "crashed", "clear_failed", failedAt);
    } catch (error) {
      this.log(
        `failed to persist reset failure for ${oldPiSessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.attachQueue(managed, managed.state, null);
      this.wsHub.broadcast({
        type: "status_changed",
        subsystem: "pi_session",
        timestamp: failedAt,
      });
      return;
    }
    this.byPiSessionId.delete(oldPiSessionId);
    this.toolDisplayCache.deletePiSession(oldPiSessionId);
    this.defaultSession = undefined;
    this.wsHub.broadcast({
      type: "status_changed",
      subsystem: "pi_session",
      timestamp: failedAt,
    });
  }

  async disposeAll(): Promise<void> {
    await Promise.all(
      Array.from(this.streamSessions.entries()).map(([streamId, managed]) =>
        this.destroyStreamSession(streamId, managed.piSessionId, "shutdown"),
      ),
    );

    if (this.defaultSession) {
      await this.defaultSession.queue.stopAndWait();
      await this.defaultSession.runtime?.session.waitForIdle();
      try {
        this.defaultSession.unsubscribe();
      } catch {}
      endPiSession(
        this.blackboard,
        this.defaultSession.piSessionId,
        "ended",
        "shutdown",
        new Date().toISOString(),
      );
      if (this.defaultSession.runtime) await this.defaultSession.runtime.dispose();
      this.byPiSessionId.delete(this.defaultSession.piSessionId);
      this.toolDisplayCache.deletePiSession(this.defaultSession.piSessionId);
      this.defaultSession = undefined;
    }
  }

  buildStreamPrompt(
    currentMessage: string,
    streamName: string,
    streamId: string,
    agentMessage?: string,
    bootstrapMessage?: string,
  ): string {
    return formatStreamPrompt(
      [currentMessage],
      streamName,
      streamId,
      agentMessage,
      bootstrapMessage,
    );
  }

  private logResourceMessages(role: string, messages: string[]): void {
    for (const message of messages) this.log(`pi-agent (${role}): ${message}`);
  }

  private findLatestWhatsAppRemoteJid(streamId: string | null): string | undefined {
    if (!streamId) return undefined;
    const rows = this.blackboard.all<{ metadata: string | null }>(
      `SELECT metadata
       FROM messages
       WHERE stream_id = ?
         AND metadata IS NOT NULL
       ORDER BY datetime(created_at) DESC
       LIMIT 100`,
      streamId,
    );

    for (const row of rows) {
      if (!row.metadata) continue;
      try {
        const metadata = JSON.parse(row.metadata) as MessageMetadata;
        const remoteJid = metadata.stream_owner_remote_jid;
        if (typeof remoteJid === "string" && remoteJid.trim()) {
          return remoteJid;
        }
      } catch {}
    }
    return undefined;
  }

  private attachQueue(
    managed: ManagedPiSession,
    state: PiSessionState,
    streamId: string | null,
  ): void {
    const processCallback = this.processCallback;
    managed.queue = new TurnQueue({
      process: (item) => processCallback(managed, item),
      steer: (item) => processCallback(managed, item, true),
      canSteer: () => managed.runtime?.session.isStreaming ?? false,
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
      onItemEnd: (item, error, steered) => {
        if (!steered) {
          state.setBusy(false);
          this.wsHub.broadcast({
            type: "status_changed",
            subsystem: "pi",
            timestamp: new Date().toISOString(),
          });
        }

        if (error) {
          const apiErr = error instanceof Error ? (error as ApiError) : undefined;
          const detail = apiErr
            ? `${apiErr.message}${apiErr.status ? ` [status=${apiErr.status}]` : ""}${apiErr.body ? ` body=${JSON.stringify(apiErr.body).slice(0, 200)}` : ""}`
            : String(error);
          this.log(
            `queue item ${item.id} failed (${managed.role}${streamId ? ` stream=${streamId}` : ""}): ${detail}`,
          );
        }
        this.wsHub.broadcast({
          type: "queue_item_end",
          itemId: item.id,
          ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
          piSessionId: managed.piSessionId,
          ...(streamId ? { streamId } : {}),
        });

        if (
          !steered &&
          managed.closeRequested?.requestedBy === "tool" &&
          !managed.closeRequested.finalizationStarted
        ) {
          const request = managed.closeRequested;
          request.finalizationStarted = true;
          queueMicrotask(() => {
            void this.finalizeStreamClose(request.streamId, request.piSessionId).catch(
              (closeError) => {
                this.recoverFailedToolClose(request.streamId, request.piSessionId);
                this.log(
                  `stream close finalization failed for ${request.streamId}: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
                );
                this.wsHub.broadcast({
                  type: "error",
                  message: `Stream close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
                  piSessionId: request.piSessionId,
                });
              },
            );
          });
        } else if (error && !steered && managed.role !== "default" && streamId) {
          const expectedPiSessionId = managed.piSessionId;
          queueMicrotask(() => {
            void this.destroyStreamSession(streamId, expectedPiSessionId, "crashed").catch(
              (destroyError) => {
                this.log(
                  `crashed stream disposal failed for ${streamId}: ${destroyError instanceof Error ? destroyError.message : String(destroyError)}`,
                );
              },
            );
          });
        }
      },
    });
  }

  private subscribeManagedSession(
    managed: ManagedPiSession,
    session: AgentSessionRuntime["session"],
    state: PiSessionState,
  ): () => void {
    return subscribeToPiSession(
      session,
      state,
      this.blackboard,
      this.wsHub,
      this.toolDisplayCache,
      managed.streamId,
      managed.streamName,
      (lastAssistantMessage) => {
        managed.lastSurfacedAssistantMessage = lastAssistantMessage ?? undefined;
      },
      () => managed.queue.steerPendingHooks(),
      () => managed.queue.enableSteering(),
    );
  }

  private async disposeUnpublishedManaged(managed: ManagedPiSession): Promise<void> {
    try {
      managed.unsubscribe();
    } catch {}
    await managed.runtime?.dispose().catch(() => {});
    managed.runtime = null;
  }

  private buildManagedSession(
    created: Awaited<ReturnType<typeof createFlitterbotAgent>>,
    state: PiSessionState,
    role: "default" | "orchestrator",
    streamId: string | null,
    streamName: string | null,
  ): ManagedPiSession {
    const session = created.runtime.session;
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
      whatsappRemoteJid: this.findLatestWhatsAppRemoteJid(streamId),
    };

    this.attachQueue(managed, state, streamId);
    managed.unsubscribe = this.subscribeManagedSession(managed, session, state);

    return managed;
  }
}
