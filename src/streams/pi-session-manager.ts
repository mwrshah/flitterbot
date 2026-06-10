import fs from "node:fs";
import path from "node:path";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import {
  endPiSession,
  reassociateOrphanedSessions,
  reconcilePreviousPiSessions,
  upsertPiSession,
} from "../blackboard/pi-sessions.ts";
import { getStreamById } from "../blackboard/query-streams.ts";
import type { FlitterbotConfig, ThinkingLevel } from "../config/load-config.ts";
import type { ApiError, MessageMetadata } from "../contracts/blackboard.ts";
import type { ChatTimelineMessage } from "../contracts/timeline.ts";
import type { WebSocketHub } from "../ws/hub.ts";
import { createFlitterbotAgent } from "./create-agent.ts";
import { formatStreamPrompt } from "./format-stream-prompt.ts";
import { PiSessionState } from "./pi-session-state.ts";
import { subscribeToPiSession } from "./pi-subscribe.ts";
import { createToolDisplayContextCache, type ToolDisplayContextCache } from "./tool-display.ts";
import { type QueueItem, TurnQueue } from "./turn-queue.ts";

export { formatStreamPrompt };

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
    thinkingLevel: ThinkingLevel;
  };
  unsubscribe: () => void;
  pendingDestroy?: boolean;
  lastSurfacedAssistantMessage?: ChatTimelineMessage;
  whatsappRemoteJid?: string;
}

export type ProcessQueueItemCallback = (
  managed: ManagedPiSession,
  item: QueueItem,
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
  private readonly config: FlitterbotConfig;
  private readonly blackboard: BlackboardDatabase;
  private readonly wsHub: WebSocketHub;
  private readonly runtimeInstanceId: string;
  private readonly startedAt: number;
  private readonly processCallback: ProcessQueueItemCallback;
  private readonly log: (message: string) => void;
  readonly toolDisplayCache: ToolDisplayContextCache;

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
    this.toolDisplayCache = createToolDisplayContextCache(blackboard);
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

  async createDefault(
    customTools: unknown[],
    resumeSessionFile?: string,
  ): Promise<ManagedPiSession> {
    reconcilePreviousPiSessions(this.blackboard, "default", this.runtimeInstanceId, "restart");

    const created = await createFlitterbotAgent({
      config: this.config,
      customTools,
      role: "default",
      ...(resumeSessionFile ? { resumeSessionFile } : {}),
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
    return this.createStreamSession("orchestrator", streamId, streamName, repoPath, customTools);
  }

  async createDefaultStream(
    streamId: string,
    streamName: string,
    repoPath?: string,
    customTools?: unknown[],
  ): Promise<ManagedPiSession> {
    return this.createStreamSession("default", streamId, streamName, repoPath, customTools);
  }

  private async createStreamSession(
    agentRole: "default" | "orchestrator",
    streamId: string,
    streamName: string,
    repoPath?: string,
    customTools?: unknown[],
  ): Promise<ManagedPiSession> {
    const existing = this.streamSessions.get(streamId);
    if (existing) return existing;

    const created = await createFlitterbotAgent({
      config: this.config,
      customTools: customTools ?? [],
      role: agentRole,
      ...(agentRole === "orchestrator"
        ? {
            orchestratorContext: { streamName, streamId, repoPath },
            tmuxEnabled: this.config.tmuxEnabled,
          }
        : {}),
      cwd: repoPath,
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
      streamId,
    });

    this.streamSessions.set(streamId, managed);
    this.byPiSessionId.set(managed.piSessionId, managed);
    this.log(`${agentRole} agent created for stream "${streamName}" (${streamId})`);
    this.logResourceInfo(agentRole, created.resourceInfo);
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

  async activateStreamSession(managed: ManagedPiSession, customTools?: unknown[]): Promise<void> {
    if (managed.runtime) return;
    if (!managed.streamId) throw new Error("Cannot activate pi session without a stream");
    if (managed.role === "default") throw new Error("Default session is not stream-backed");

    const snapshot = managed.state.getSnapshot();
    const sessionFile = snapshot.sessionFile;
    const stream = getStreamById(this.blackboard, managed.streamId);
    const repoPath = stream?.repo_path ?? undefined;
    const agentRole = stream?.type === "defaultStream" ? "default" : "orchestrator";

    const created = await createFlitterbotAgent({
      config: this.config,
      customTools: customTools ?? [],
      role: agentRole,
      ...(agentRole === "orchestrator"
        ? {
            orchestratorContext: {
              streamName: managed.streamName ?? managed.streamId,
              streamId: managed.streamId,
              repoPath,
            },
            tmuxEnabled: this.config.tmuxEnabled,
          }
        : {}),
      cwd: repoPath,
      resumeSessionFile: sessionFile && fs.existsSync(sessionFile) ? sessionFile : undefined,
    });

    const session = created.runtime.session;
    managed.runtime = created.runtime;
    managed.modelInfo = created.modelInfo;
    managed.unsubscribe = this.subscribeManagedSession(managed, session, managed.state);
    managed.state.initialize(session.sessionId, session.sessionFile, session.messages.length);

    this.log(
      `activated dormant ${agentRole} agent for stream "${managed.streamName}" (${managed.streamId})`,
    );
    this.logResourceInfo(agentRole, created.resourceInfo);
  }

  destroyStreamSession(streamId: string, reason: string): void {
    const managed = this.streamSessions.get(streamId);
    if (!managed) return;

    managed.queue.stop();
    try {
      managed.unsubscribe();
    } catch {}
    try {
      void managed.runtime?.dispose();
    } catch {}

    if (reason !== "shutdown") {
      const status = reason === "crashed" ? "crashed" : "ended";
      endPiSession(this.blackboard, managed.piSessionId, status, reason, new Date().toISOString());
      this.wsHub.broadcast({
        type: "status_changed",
        subsystem: "pi_session",
        timestamp: new Date().toISOString(),
      });
    }

    this.streamSessions.delete(streamId);
    this.byPiSessionId.delete(managed.piSessionId);
    this.toolDisplayCache.deletePiSession(managed.piSessionId);
    this.log(
      `${managed.role} destroyed for stream "${managed.streamName}" (${streamId}): ${reason}`,
    );
  }

  async switchStreamCwd(streamId: string, cwd: string): Promise<ManagedPiSession> {
    const managed = this.streamSessions.get(streamId);
    if (!managed) throw new Error("No stream session for stream");
    if (managed.role !== "orchestrator")
      throw new Error("cwd switch is only supported for streams");
    if (!managed.runtime) throw new Error("Cannot switch cwd for a dormant stream session");
    if (managed.state.getSnapshot().busy)
      throw new Error("Cannot switch cwd while session is busy");

    const sessionFile = managed.runtime.session.sessionFile;
    if (!sessionFile) throw new Error("Cannot switch cwd for a session without a session file");
    if (!fs.existsSync(sessionFile)) throw new Error(`Session file does not exist: ${sessionFile}`);

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
    managed.piSessionId = session.sessionId;
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
        if (managed.pendingDestroy && managed.streamId) {
          this.destroyStreamSession(managed.streamId, "close_stream");
        }
      },
    );

    this.toolDisplayCache.invalidatePiSession(managed.piSessionId);
    this.log(`switched cwd for stream "${managed.streamName}" (${streamId}) to ${cwd}`);
    return managed;
  }

  async resetDefault(): Promise<void> {
    const old = this.defaultSession;
    if (!old?.runtime) {
      throw new Error("No active default session to reset");
    }

    const oldPiSessionId = old.piSessionId;

    old.queue.stop();
    try {
      old.unsubscribe();
    } catch {}

    endPiSession(this.blackboard, oldPiSessionId, "ended", "clear", new Date().toISOString());
    this.toolDisplayCache.deletePiSession(oldPiSessionId);

    await old.runtime.newSession();

    const newSession = old.runtime.session;
    const newPiSessionId = newSession.sessionId;
    const newSessionFile = newSession.sessionFile;

    old.state.initialize(newPiSessionId, newSessionFile, newSession.messages.length);

    old.piSessionId = newPiSessionId;

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

    this.byPiSessionId.delete(oldPiSessionId);
    this.byPiSessionId.set(newPiSessionId, old);

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

    this.toolDisplayCache.invalidatePiSession(newPiSessionId);
    old.unsubscribe = subscribeToPiSession(
      newSession,
      old.state,
      this.blackboard,
      this.wsHub,
      this.toolDisplayCache,
      null,
      null,
      (lastAssistantMessage) => {
        old.lastSurfacedAssistantMessage = lastAssistantMessage ?? undefined;
      },
    );

    this.wsHub.broadcast({
      type: "status_changed",
      subsystem: "pi_session",
      timestamp: new Date().toISOString(),
    });

    this.log(`default session reset: ${oldPiSessionId} → ${newPiSessionId}`);
  }

  disposeAll(): void {
    for (const [streamId] of this.streamSessions) {
      this.destroyStreamSession(streamId, "shutdown");
    }

    if (this.defaultSession) {
      this.defaultSession.queue.stop();
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
      try {
        void this.defaultSession.runtime?.dispose();
      } catch {}
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
            `queue item ${item.id} failed (${managed.role}${streamId ? ` stream=${streamId}` : ""}): ${detail}`,
          );
          if (managed.role !== "default" && streamId) {
            this.destroyStreamSession(streamId, "crashed");
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
        if (managed.pendingDestroy && managed.streamId) {
          this.destroyStreamSession(managed.streamId, "close_stream");
        }
      },
    );
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
