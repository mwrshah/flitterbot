import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import type { AgentSession, CompactionResult, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ProviderAuthManager } from "./auth/provider-auth.ts";
import { type BlackboardDatabase, openBlackboard, pingBlackboard } from "./blackboard/db.ts";
import {
  getLastDatetimeReportedAt,
  touchDatetimeReportedAt,
  touchPiPrompt,
  updatePiSessionModelMirror,
  updatePiSessionStatus,
} from "./blackboard/pi-sessions.ts";
import { clearAllHealthFlags, setHealthFlag } from "./blackboard/query-health-flags.ts";
import { persistInboundMessage, persistOutboundMessage } from "./blackboard/query-messages.ts";
import {
  findIdleCleanupCandidates,
  getSessionById,
  insertSession,
  listSessions,
  markSessionEnded,
  markStaleSessions,
  updateSessionStop,
} from "./blackboard/query-sessions.ts";
import {
  CLOSED_STREAM_LOOKBACK_HOURS,
  getActiveStreamPiSessionId,
  getPiSessionStatus,
  getStreamById,
  getStreamByName,
  getStreamPiSessionId,
  getStreamPiSessionRow,
  listClosedStreams,
  listOpenStreams,
  resetClosedStreams,
  setStreamName,
  setStreamType,
} from "./blackboard/query-streams.ts";
import { createQueryBlackboardTool } from "./blackboard/tool-query-blackboard.ts";
import { resolveGroqApiKey } from "./classifier/groq-client.ts";
import { type FlitterbotConfig, loadConfig } from "./config/load-config.ts";
import { resolveModelEntry, resolveModelEntryId } from "./config/models.ts";
import { persistModelsToConfigFile } from "./config/persist-models.ts";
import type {
  ClaudeHookPayload,
  ControlSurfaceWebSocketClientEvent,
  WhatsAppDaemonStatus as ControlSurfaceWhatsAppStatus,
  DaemonCommand,
  DaemonResponse,
  DirectSessionMessageResponse,
  HookResponse,
  MessageMetadata,
  PiSessionModelInfo,
  RuntimeWhatsAppControlResponse,
  ClaudeSessionListItem as SessionListItem,
  StatusResponse,
  StreamRoutingMeta,
  StreamSurfacedWebSocketEvent,
  StreamType,
  TranscriptPageResponse,
} from "./contracts/index.ts";
import { executeCloseSwimlane } from "./custom-tools/close-swimlane.ts";
import { directSessionMessage } from "./custom-tools/manage-session.ts";
import { executeSetUpWorktree } from "./custom-tools/set-up-worktree.ts";
import { createPiModelRuntime } from "./pi-auth.ts";
import { formatDatetimeBlock } from "./prompts/datetime.ts";
import { readPiSessionHeaderId } from "./streams/create-agent.ts";
import type { FlitterbotTool } from "./streams/flitterbot-extension.ts";
import { formatPromptWithContext } from "./streams/format-prompt.ts";
import {
  resolveTmuxBootstrapMessage,
  stripInjectedDatetimeBlocks,
} from "./streams/format-stream-prompt.ts";
import { latestMeasuredContextUsage } from "./streams/history.ts";
import { type ManagedPiSession, PiSessionManager } from "./streams/pi-session-manager.ts";
import { stripStreamNamePrefix } from "./streams/strip-name-prefix.ts";
import type { QueueItem, QueueSource } from "./streams/turn-queue.ts";
import {
  clearWorktreePathIfStale,
  shouldReconcileWorktreeOnRecovery,
} from "./streams/worktree-link.ts";
import { fireAndForgetPeriodicTaskSync } from "./tasks/periodic-sync.ts";
import { killTmuxSession } from "./tmux-sessions/tmux.ts";
import { readTranscriptPage } from "./transcript/transcript.ts";
import { loadWhatsAppConfig } from "./whatsapp/config.ts";
import { sendDaemonCommand } from "./whatsapp/ipc.ts";
import { getWhatsAppStatusSignalPath } from "./whatsapp/paths.ts";
import {
  getDaemonStatus,
  startDaemonProcess,
  stopDaemonProcess,
  waitForDaemonReady,
} from "./whatsapp/process.ts";
import { type WebSocketClient, WebSocketHub } from "./ws/hub.ts";

type EnqueueInput = {
  text: string;
  source: QueueSource;
  metadata?: MessageMetadata;
  webClientId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  serverMessageId?: string;
};

const ACCEPTED_HOOK_EVENTS = new Set(["session-start", "stop", "session-end"]);

export class ControlSurfaceRuntime {
  readonly blackboard: BlackboardDatabase;
  readonly runtimeInstanceId = crypto.randomUUID();
  readonly startedAt = Date.now();
  readonly wsHub: WebSocketHub;
  readonly sessionManager: PiSessionManager;
  readonly providerAuth: ProviderAuthManager;
  server?: http.Server;
  private stopping = false;
  private maintenanceTimer?: NodeJS.Timeout;
  private readonly sessionReloads = new Map<string, Promise<void>>();
  private readonly compactionClaims = new WeakSet<ManagedPiSession>();
  private whatsappStatusWatcher?: fs.FSWatcher;
  private whatsappStatusCache: {
    status: ControlSurfaceWhatsAppStatus;
    pid?: number;
    managedByControlSurface: true;
    requiresManualAuth?: boolean;
  } = {
    status: "stopped",
    managedByControlSurface: true,
  };
  get whatsappEnabled(): boolean {
    return this.config.whatsappEnabled;
  }

  constructor() {
    const config = loadConfig();
    if (!config.whatsappEnabled) {
      this.whatsappStatusCache = { status: "disabled", managedByControlSurface: true };
    }
    this.blackboard = openBlackboard(config.blackboardPath);
    this.wsHub = new WebSocketHub(this.handleWebSocketMessage.bind(this));
    this.sessionManager = new PiSessionManager(
      this.blackboard,
      this.wsHub,
      this.runtimeInstanceId,
      this.startedAt,
      this.processQueueItem.bind(this),
      this.log.bind(this),
    );
    this.providerAuth = new ProviderAuthManager(() => this.resolveModelRuntime());
  }

  get config(): FlitterbotConfig {
    return loadConfig();
  }

  attachServer(server: http.Server): void {
    this.server = server;
  }

  async resolveModelRuntime(): Promise<ModelRuntime> {
    return (
      this.sessionManager.getDefault()?.runtime?.services.modelRuntime ??
      createPiModelRuntime(this.config.controlSurfaceAgentDir)
    );
  }

  async start(): Promise<void> {
    this.ensurePidFile();
    await createPiModelRuntime(this.config.controlSurfaceAgentDir, {
      allowModelNetwork: true,
    });

    this.sessionManager.reconcileAllStreamSessionFiles();

    const defaultUser = loadWhatsAppConfig().defaultUser;
    if (defaultUser) {
      const adopted = this.blackboard
        .prepare("UPDATE streams SET stream_user = ? WHERE type = 'work' AND stream_user IS NULL")
        .run(defaultUser);
      if (adopted.changes > 0) {
        this.blackboard
          .prepare(
            "UPDATE pi_sessions SET session_user = ? WHERE session_user IS NULL AND stream_id IN (SELECT id FROM streams WHERE stream_user = ?)",
          )
          .run(defaultUser, defaultUser);
        this.log(`adopted ${adopted.changes} legacy work stream(s) to owner "${defaultUser}"`);
      }
    }

    if (this.config.wipeStreamsOnStart) {
      const closed = resetClosedStreams(this.blackboard);
      if (closed > 0)
        this.log(`wiped ${closed} closed stream(s) on startup (wipeStreamsOnStart=true)`);
    }

    const resumeDefaultSessionFile =
      process.env.FLITTERBOT_RESUME_DEFAULT_SESSION?.trim() || undefined;
    if (resumeDefaultSessionFile) {
      this.log(`resuming default session from ${resumeDefaultSessionFile}`);
    }
    await this.sessionManager.createDefault(
      this.createCustomTools("default"),
      resumeDefaultSessionFile,
    );
    fireAndForgetPeriodicTaskSync(this.config, this.log.bind(this));

    const openStreams = listOpenStreams(this.blackboard);
    for (const ws of openStreams) {
      const latest = getStreamPiSessionRow(this.blackboard, ws.id);
      const streamsRow =
        latest?.role === "orchestrator" && latest.status !== "ended" && latest.status !== "crashed"
          ? latest
          : null;

      if (streamsRow) {
        this.sessionManager.requireRestorableStreamPiSession(ws.id);
        this.sessionManager.rehydrateStreamSession(
          ws.id,
          ws.name,
          streamsRow.pi_session_id,
          streamsRow.session_file,
          streamsRow.started_at,
          streamsRow.model_provider,
          streamsRow.model_id,
        );
      } else {
        this.log(
          `skipping stream session spawn for open stream "${ws.name}" (${ws.id}) — no alive pi_session; awaiting explicit Recover`,
        );
      }
    }
    if (openStreams.length > 0) {
      this.log(`rehydrated ${openStreams.length} stream session(s) for open streams`);
    }
    await this.ensureWhatsAppUserDefaultStreams();

    await this.ensureWhatsAppDaemon();
    await this.refreshWhatsAppStatus();
    this.watchWhatsAppStatusSignal();
    this.startMaintenanceLoop();
    clearAllHealthFlags(this.blackboard);
    this.log(
      `runtime started on ${this.config.controlSurfaceHost}:${this.config.controlSurfacePort}`,
    );

    if (!resumeDefaultSessionFile) {
      this.enqueueDefaultAgentFirstMessage("startup");
    }
  }

  async stop(reason: string = "shutdown", _crash: boolean = false): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`runtime stopping: ${reason}`);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.unwatchWhatsAppStatusSignal();
    this.providerAuth.stop();
    await this.sessionManager.disposeAll();
    try {
      await this.stopWhatsAppDaemon();
      await this.refreshWhatsAppStatus();
    } catch {}
    try {
      this.wsHub.closeAll();
    } catch {}
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    try {
      if (fs.existsSync(this.config.controlSurfacePidPath))
        fs.unlinkSync(this.config.controlSurfacePidPath);
    } catch {}
    this.blackboard.close();
    const { destroyAll: destroyAllFileFinders } = await import("./file-finder/manager.ts");
    destroyAllFileFinders();
  }

  private enqueueDefaultAgentFirstMessage(via: "startup" | "clear"): void {
    if (!this.config.defaultAgentFirstMessage.trim()) return;
    this.enqueue({
      text: this.config.defaultAgentFirstMessage,
      source: "init",
      metadata: { via },
    });
  }

  enqueue(
    input: EnqueueInput,
  ):
    | { ok: true; item: QueueItem }
    | { ok: true; cleared: true }
    | { ok: true; reloaded: true }
    | { ok: true; compacted: true }
    | { ok: true; forked: true } {
    input.text = input.text.trim();

    if (input.text === "/clear") {
      const targetSessionId = (input.metadata?._targetSessionId as string | undefined)?.trim();
      const target = targetSessionId
        ? this.sessionManager.getByPiSessionId(targetSessionId)
        : undefined;
      const routedStreamId =
        typeof input.metadata?.stream_id === "string" ? input.metadata.stream_id.trim() : "";
      const targetStreamId = (target?.streamId ?? routedStreamId) || undefined;
      const targetStream = targetStreamId ? getStreamById(this.blackboard, targetStreamId) : null;

      if (targetStreamId && targetStream) {
        const streamPiSessionId =
          targetSessionId ?? getStreamPiSessionId(this.blackboard, targetStreamId);
        throw new Error(
          `/clear is unavailable for stream-backed Pi sessions; stream ${targetStreamId} keeps immutable Pi identity ${streamPiSessionId ?? "unknown"}`,
        );
      }

      const defaultPiSessionId = this.sessionManager.getDefault()?.piSessionId;
      const targetsDefaultSession =
        (!input.metadata?.stream_id && !targetSessionId) ||
        (!!targetSessionId && targetSessionId === defaultPiSessionId);
      if (targetsDefaultSession) {
        this.log("/clear: resetting default session");
        void this.sessionManager
          .resetDefault()
          .then(() => {
            fireAndForgetPeriodicTaskSync(this.config, this.log.bind(this));
            this.enqueueDefaultAgentFirstMessage("clear");
          })
          .catch((error) => {
            this.log(
              `/clear reset failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        return { ok: true, cleared: true };
      }
    }

    if (input.text === "/reload") {
      void this.reloadIdleSessions().catch((error) => {
        this.log(`/reload failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return { ok: true, reloaded: true };
    }

    if (input.text === "/compact" || input.text.startsWith("/compact ")) {
      const customInstructions = input.text.startsWith("/compact ")
        ? input.text.slice("/compact ".length).trim()
        : undefined;
      const piSessionId = this.resolveCompactTargetPiSessionId(input.metadata);
      this.log(`/compact: compacting session ${piSessionId ?? "<none>"}`);
      void (async () => {
        try {
          if (!piSessionId) throw new Error("No pi session available to compact");
          await this.compactPiSession(piSessionId, customInstructions);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`/compact failed: ${message}`);
          this.wsHub.broadcast({
            type: "error",
            message: `Compact failed: ${message}`,
            ...(piSessionId ? { piSessionId } : {}),
          });
        }
      })();
      return { ok: true, compacted: true };
    }

    if (input.text === "/fork") {
      const piSessionId = this.resolveCompactTargetPiSessionId(input.metadata);
      this.log(`/fork: forking session ${piSessionId ?? "<none>"}`);
      void (async () => {
        try {
          if (!piSessionId) throw new Error("No pi session available to fork");
          await this.forkStream(piSessionId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`/fork failed: ${message}`);
          this.wsHub.broadcast({ type: "error", message: `Fork failed: ${message}` });
        }
      })();
      return { ok: true, forked: true };
    }

    const images = input.images?.map((img) => ({
      type: "image" as const,
      data: img.data,
      mimeType: img.mimeType,
    }));
    const messageUuid = input.serverMessageId ?? crypto.randomUUID();
    const sender: "user" | "system" =
      input.source === "web" || input.source === "whatsapp" ? "user" : "system";
    const item: QueueItem = {
      id: crypto.randomUUID(),
      source: input.source,
      sender,
      text: input.text,
      metadata: input.metadata,
      receivedAt: new Date().toISOString(),
      webClientId: input.webClientId,
      images: images?.length ? images : undefined,
      serverMessageId: messageUuid,
    };

    const target = this.resolveTargetSession(input, item);
    if (!target) throw new Error("No target session available");
    target.queue.assertAccepting();

    persistInboundMessage(this.blackboard, {
      id: messageUuid,
      source: item.source,
      content: input.text,
      sender: "user",
      streamId: target.streamId ?? undefined,
      piSessionId: target.piSessionId,
      metadata: input.metadata,
    });

    item.streamId = target.streamId ?? undefined;
    item.streamName = target.streamName ?? undefined;
    target.queue.enqueue(item);
    this.log(
      `enqueued ${item.source} item ${item.id} → ${target.role}${target.streamId ? ` ws=${target.streamId}` : ""}`,
    );

    return { ok: true, item };
  }

  handleHook(eventName: string, payload: ClaudeHookPayload): HookResponse {
    const normalized = eventName.toLowerCase();
    if (!ACCEPTED_HOOK_EVENTS.has(normalized)) {
      this.log(`hook ${eventName}: filtered, unknown event`);
      return { ok: true, filtered: true };
    }

    const sessionId = pickString(payload, ["session_id", "sessionId"]);
    if (!sessionId) {
      this.log(`hook ${normalized}: filtered, no session_id in payload`);
      return { ok: true, filtered: true };
    }

    const isOwnPiSession = this.sessionManager.getByPiSessionId(sessionId) !== undefined;

    if (normalized === "session-start") {
      const agentManaged = payload.agent_managed === true || payload.agent_managed === 1;
      if (!agentManaged && !isOwnPiSession) {
        return { ok: true, filtered: true };
      }
      const cwd = pickString(payload, ["cwd"]);
      const piSessionIdValue = pickString(payload, [
        "pi_session_id",
        "piSessionId",
        "FLITTERBOT_PI_SESSION_ID",
      ]);
      let streamIdValue = pickString(payload, ["stream_id", "streamId", "FLITTERBOT_STREAM_ID"]);
      if (piSessionIdValue && !streamIdValue) {
        streamIdValue =
          this.sessionManager.getByPiSessionId(piSessionIdValue)?.streamId ??
          this.blackboard.get<{ stream_id: string | null }>(
            "SELECT stream_id FROM pi_sessions WHERE pi_session_id = ?",
            piSessionIdValue,
          )?.stream_id ??
          undefined;
      }
      let terminateStartedSession = !piSessionIdValue;
      if (streamIdValue) {
        try {
          this.sessionManager.assertDownstreamSessionStartAdmission(
            streamIdValue,
            piSessionIdValue,
          );
        } catch (error) {
          terminateStartedSession = true;
          this.log(
            `hook session-start terminating for stream ${streamIdValue}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const tmuxSession = pickString(payload, [
        "tmux_session",
        "tmuxSession",
        "FLITTERBOT_TMUX_SESSION",
      ]);
      insertSession(this.blackboard, {
        session_id: sessionId,
        cwd,
        model: pickString(payload, ["model"]),
        permission_mode: pickString(payload, ["permission_mode", "permissionMode"]),
        source: pickString(payload, ["source"]),
        transcript_path: pickString(payload, ["transcript_path", "transcriptPath"]),
        agent_managed: agentManaged,
        tmux_session: tmuxSession,
        task_description: pickString(payload, [
          "task_description",
          "taskDescription",
          "FLITTERBOT_TASK_DESCRIPTION",
        ]),
        todoist_task_id: pickString(payload, [
          "todoist_task_id",
          "todoistTaskId",
          "FLITTERBOT_TODOIST_TASK_ID",
        ]),
        pi_session_id: piSessionIdValue,
        stream_id: streamIdValue,
      });
      if (piSessionIdValue) {
        this.wsHub.broadcast({
          type: "sessions_changed",
          piSessionId: piSessionIdValue,
          reason: "registered",
        });
      }
      if (terminateStartedSession) {
        void (async () => {
          try {
            if (tmuxSession) await killTmuxSession(tmuxSession);
            markSessionEnded(this.blackboard, sessionId, "stream_closing");
            if (piSessionIdValue) {
              this.wsHub.broadcast({
                type: "sessions_changed",
                piSessionId: piSessionIdValue,
                reason: "ended",
              });
            }
          } catch (error) {
            this.log(
              `failed to terminate late session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })();
      }
    } else {
      if (!isOwnPiSession) {
        const known = getSessionById(this.blackboard, sessionId);
        if (!known) {
          return { ok: true, filtered: true };
        }
      }

      if (normalized === "stop") {
        updateSessionStop(this.blackboard, sessionId);
        const stoppedSession = getSessionById(this.blackboard, sessionId);
        if (stoppedSession?.piSessionId) {
          this.wsHub.broadcast({
            type: "sessions_changed",
            piSessionId: stoppedSession.piSessionId,
            reason: "stopped",
          });
        }
      } else if (normalized === "session-end") {
        const reason =
          pickString(payload, ["reason", "stop_reason", "session_end_reason"]) || "ended";
        const endingSession = getSessionById(this.blackboard, sessionId);
        markSessionEnded(this.blackboard, sessionId, reason);
        if (endingSession?.piSessionId) {
          this.wsHub.broadcast({
            type: "sessions_changed",
            piSessionId: endingSession.piSessionId,
            reason: "ended",
          });
        }
      }
    }

    if (normalized !== "stop") {
      return { ok: true, bookkeeping: true };
    }

    const lastAssistantText = pickString(payload, [
      "last_assistant_message",
      "lastAssistantMessage",
    ]);
    if (lastAssistantText) {
      payload.lastAssistantText = lastAssistantText;
    }

    const piSessionIdFromPayload = pickString(payload, [
      "pi_session_id",
      "piSessionId",
      "FLITTERBOT_PI_SESSION_ID",
    ]);
    let targetQueue: ManagedPiSession | undefined;
    let resolvedVia = "default";
    if (piSessionIdFromPayload) {
      targetQueue = this.sessionManager.getByPiSessionId(piSessionIdFromPayload);
      if (targetQueue) resolvedVia = "payload";
    }
    const ccSession = !targetQueue ? getSessionById(this.blackboard, sessionId) : undefined;
    if (!targetQueue) {
      if (ccSession?.piSessionId) {
        targetQueue = this.sessionManager.getByPiSessionId(ccSession.piSessionId);
        if (targetQueue) resolvedVia = "sessions-table";
      }
    }
    if (!targetQueue) {
      const ccCwd = ccSession?.cwd || pickString(payload, ["cwd"]);
      if (ccCwd) {
        const openStreams = listOpenStreams(this.blackboard);
        const matchingStream = openStreams.find(
          (ws) => ws.worktree_path && ccCwd.startsWith(ws.worktree_path),
        );
        if (matchingStream) {
          targetQueue = this.sessionManager.getByStream(matchingStream.id);
          if (targetQueue) resolvedVia = `cwd-match:${matchingStream.id}`;
        }
      }
    }
    if (!targetQueue) {
      targetQueue = this.sessionManager.getDefault();
    }
    if (!targetQueue) {
      this.log(`hook: no target session found for session_id=${sessionId}`);
      return { ok: false };
    }

    const text = formatHookMessage(normalized, payload);
    const hookItem: QueueItem = {
      id: crypto.randomUUID(),
      source: "hook",
      sender: "system",
      text,
      metadata: { event: normalized, ...payload },
      receivedAt: new Date().toISOString(),
      streamId: targetQueue.streamId ?? undefined,
      streamName: targetQueue.streamName ?? undefined,
    };

    targetQueue.queue.assertAccepting();
    try {
      const persisted = persistInboundMessage(this.blackboard, {
        source: "hook",
        content: text,
        sender: "system",
        streamId: targetQueue.streamId ?? undefined,
        piSessionId: targetQueue.piSessionId,
        metadata: { event: normalized, ...payload },
      });
      hookItem.serverMessageId = persisted.id;
    } catch (error) {
      this.log(`message persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    targetQueue.queue.enqueue(hookItem);
    this.log(
      `hook stop: session_id=${sessionId} → ${targetQueue.role}${targetQueue.streamId ? ` ws=${targetQueue.streamId}` : ""} (via ${resolvedVia})`,
    );
    return { ok: true };
  }

  private toPiSessionModelInfo(modelInfo: {
    provider: string;
    id: string;
    thinkingLevel?: PiSessionModelInfo["thinkingLevel"];
  }): PiSessionModelInfo {
    return {
      id: resolveModelEntryId(this.config, modelInfo.provider, modelInfo.id),
      provider: modelInfo.provider,
      modelId: modelInfo.id,
      thinkingLevel: modelInfo.thinkingLevel,
    };
  }

  private getPersistedPiSessionModels(
    piSessionIds: Array<string | undefined>,
  ): Map<string, PiSessionModelInfo> {
    const ids = Array.from(new Set(piSessionIds.filter((id): id is string => Boolean(id))));
    const models = new Map<string, PiSessionModelInfo>();
    if (ids.length === 0) return models;

    const rows = this.blackboard.all<{
      pi_session_id: string;
      model_provider: string | null;
      model_id: string | null;
      thinking_level: PiSessionModelInfo["thinkingLevel"] | null;
    }>(
      `SELECT pi_session_id, model_provider, model_id, thinking_level
       FROM pi_sessions
       WHERE pi_session_id IN (${ids.map(() => "?").join(", ")})`,
      ...ids,
    );

    for (const row of rows) {
      if (!row.model_provider || !row.model_id) continue;
      models.set(row.pi_session_id, {
        id: resolveModelEntryId(this.config, row.model_provider, row.model_id),
        provider: row.model_provider,
        modelId: row.model_id,
        thinkingLevel: row.thinking_level ?? undefined,
      });
    }
    return models;
  }

  async setPiSessionModel(piSessionId: string, modelId: string): Promise<PiSessionModelInfo> {
    const managed = this.sessionManager.getByPiSessionId(piSessionId);
    if (!managed) {
      throw new Error(`Pi session not found: ${piSessionId}`);
    }
    if (managed.streamId) {
      return this.sessionManager.withIdleActiveStreamOperation(
        { streamId: managed.streamId, expectedPiSessionId: piSessionId },
        this.createStreamSessionTools(managed.streamId),
        (active) => this.setManagedPiSessionModel(active, modelId),
      );
    }
    return this.setManagedPiSessionModel(managed, modelId);
  }

  private async setManagedPiSessionModel(
    managed: ManagedPiSession,
    modelId: string,
  ): Promise<PiSessionModelInfo> {
    const piSessionId = managed.piSessionId;
    const session = managed.runtime?.session;
    if (!session) {
      throw new Error(`Pi session is not active: ${piSessionId}`);
    }

    const modelEntry = resolveModelEntry(this.config, modelId);
    const isDefaultSession = this.sessionManager.getDefault()?.piSessionId === piSessionId;
    if (
      managed.modelInfo.provider === modelEntry.provider &&
      managed.modelInfo.id === modelEntry.modelId
    ) {
      managed.modelInfo.entryId = modelEntry.id;
      updatePiSessionModelMirror(
        this.blackboard,
        managed.piSessionId,
        managed.modelInfo.provider,
        managed.modelInfo.id,
        managed.modelInfo.thinkingLevel,
      );
      if (isDefaultSession) this.persistDefaultModel(modelId);
      return this.toPiSessionModelInfo(managed.modelInfo);
    }

    const model = session.modelRuntime.getModel(modelEntry.provider, modelEntry.modelId);
    if (!model) {
      throw new Error(
        `Unable to resolve Pi model: provider=${modelEntry.provider} modelId=${modelEntry.modelId}. ` +
          `Not in the built-in catalog or ~/.flitterbot/control-surface/agent/models.json.`,
      );
    }

    await session.setModel(model);
    const currentModel = session.model;
    if (!currentModel) {
      throw new Error(`Pi session has no current model after switch: ${piSessionId}`);
    }

    managed.modelInfo = {
      provider: currentModel.provider,
      id: currentModel.id,
      entryId: resolveModelEntryId(this.config, currentModel.provider, currentModel.id),
      thinkingLevel: session.thinkingLevel,
    };
    updatePiSessionModelMirror(
      this.blackboard,
      managed.piSessionId,
      managed.modelInfo.provider,
      managed.modelInfo.id,
      managed.modelInfo.thinkingLevel,
    );
    this.broadcastStatusChanged("pi_session");
    this.log(
      `pi-session model switched: ${managed.piSessionId} → ${managed.modelInfo.provider}/${managed.modelInfo.id}`,
    );

    if (isDefaultSession) {
      this.persistDefaultModel(modelId);
      return this.setPiSessionThinkingLevel(
        piSessionId,
        modelEntry.thinkingLevel ?? this.config.defaultThinkingLevel,
      );
    }

    return this.toPiSessionModelInfo(managed.modelInfo);
  }

  private persistDefaultModel(modelId: string): void {
    persistModelsToConfigFile({
      models: this.config.models,
      defaultModel: modelId,
    });
    this.log(`models: defaultModel set to ${modelId}`);
  }

  async setPiSessionThinkingLevel(
    piSessionId: string,
    thinkingLevel: ModelThinkingLevel,
  ): Promise<PiSessionModelInfo> {
    const managed = this.sessionManager.getByPiSessionId(piSessionId);
    if (!managed) {
      throw new Error(`Pi session not found: ${piSessionId}`);
    }
    if (managed.streamId) {
      return this.sessionManager.withIdleActiveStreamOperation(
        { streamId: managed.streamId, expectedPiSessionId: piSessionId },
        this.createStreamSessionTools(managed.streamId),
        (active) => this.setManagedPiSessionThinkingLevel(active, thinkingLevel),
      );
    }
    return this.setManagedPiSessionThinkingLevel(managed, thinkingLevel);
  }

  private setManagedPiSessionThinkingLevel(
    managed: ManagedPiSession,
    thinkingLevel: ModelThinkingLevel,
  ): PiSessionModelInfo {
    const piSessionId = managed.piSessionId;
    const session = managed.runtime?.session;
    if (!session) {
      throw new Error(`Pi session is not active: ${piSessionId}`);
    }

    session.setThinkingLevel(thinkingLevel);
    const currentThinkingLevel = session.thinkingLevel;
    const currentModel = session.model;
    if (!currentModel) {
      throw new Error(
        `Pi session has no current model after thinking-level switch: ${piSessionId}`,
      );
    }

    managed.modelInfo = {
      provider: currentModel.provider,
      id: currentModel.id,
      entryId: resolveModelEntryId(this.config, currentModel.provider, currentModel.id),
      thinkingLevel: currentThinkingLevel,
    };
    updatePiSessionModelMirror(
      this.blackboard,
      managed.piSessionId,
      managed.modelInfo.provider,
      managed.modelInfo.id,
      managed.modelInfo.thinkingLevel,
    );
    this.broadcastStatusChanged("pi_session");
    this.log(
      `pi-session thinking level switched: ${managed.piSessionId} → ${managed.modelInfo.thinkingLevel}`,
    );

    if (this.sessionManager.getDefault()?.piSessionId === piSessionId) {
      persistModelsToConfigFile({
        models: this.config.models,
        defaultThinkingLevel: thinkingLevel,
      });
      this.log(`models: defaultThinkingLevel set to ${thinkingLevel}`);
    }

    return this.toPiSessionModelInfo(managed.modelInfo);
  }

  getStatus(): StatusResponse {
    const def = this.sessionManager.getDefault();
    const defSnapshot = def?.state.getSnapshot();
    const whatsapp = this.getWhatsAppStatusSnapshot();
    const blackboardStatus = pingBlackboard(this.blackboard) ? "ok" : "error";

    const orchestratorStatuses = this.sessionManager.listStreamSessions().map((o) => {
      const snap = o.state.getSnapshot();
      return {
        piSessionId: o.piSessionId,
        streamId: o.streamId!,
        streamName: o.streamName,
        messageCount: o.runtime?.session?.messages?.length ?? snap.messageCount,
        busy: snap.busy,
        isCompacting: o.runtime?.session?.isCompacting ?? false,
        contextUsage:
          o.runtime?.session && !o.runtime.session.isCompacting
            ? latestMeasuredContextUsage(o.runtime.session.sessionManager.getBranch())
            : null,
      };
    });

    const openStreams = listOpenStreams(this.blackboard).map((stream) => ({
      stream,
      piSessionId: getActiveStreamPiSessionId(this.blackboard, stream.id),
    }));
    const closedStreams = listClosedStreams(
      this.blackboard,
      CLOSED_STREAM_LOOKBACK_HOURS,
      true,
    ).map((stream) => ({
      stream,
      piSessionId: getStreamPiSessionId(this.blackboard, stream.id),
    }));
    const persistedModelByPiSession = this.getPersistedPiSessionModels([
      ...openStreams.map(({ piSessionId }) => piSessionId),
      ...closedStreams.map(({ piSessionId }) => piSessionId),
    ]);
    const sessionCountByStream = new Map<string, number>();
    for (const session of this.getSessionList()) {
      if (session.streamId) {
        sessionCountByStream.set(
          session.streamId,
          (sessionCountByStream.get(session.streamId) ?? 0) + 1,
        );
      }
    }

    return {
      ok: true,
      pid: process.pid,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      piAgent: {
        default: defSnapshot
          ? {
              piSessionId: defSnapshot.piSessionId!,
              sessionFile: defSnapshot.sessionFile ?? null,
              messageCount: def!.runtime?.session?.messages?.length ?? defSnapshot.messageCount,
              lastPromptAt: defSnapshot.lastPromptAt ?? null,
              busy: defSnapshot.busy,
              isCompacting: def!.runtime?.session?.isCompacting ?? false,
              contextUsage:
                def!.runtime?.session && !def!.runtime.session.isCompacting
                  ? latestMeasuredContextUsage(def!.runtime.session.sessionManager.getBranch())
                  : null,
              model: this.toPiSessionModelInfo(def!.modelInfo),
            }
          : null,
        orchestrators: orchestratorStatuses,
      },
      whatsapp: {
        status: whatsapp.status,
        pid: whatsapp.pid ?? null,
        managedByControlSurface: whatsapp.managedByControlSurface,
        requiresManualAuth: whatsapp.requiresManualAuth,
      },
      blackboard: blackboardStatus,
      groqConfigured: Boolean(resolveGroqApiKey()?.trim()),
      streams: [
        ...openStreams.map(({ stream: ws, piSessionId }) => {
          const managed = this.sessionManager.getByStream(ws.id);
          return {
            id: ws.id,
            name: ws.name,
            type: ws.type,
            status: "open" as const,
            pinned: Boolean(ws.pinned),
            repoPath: ws.repo_path ?? undefined,
            worktreePath: ws.worktree_path ?? undefined,
            piSessionId,
            piSessionStatus: piSessionId
              ? getPiSessionStatus(this.blackboard, piSessionId)
              : undefined,
            model: managed
              ? this.toPiSessionModelInfo(managed.modelInfo)
              : persistedModelByPiSession.get(piSessionId ?? ""),
            sessionCount: sessionCountByStream.get(ws.id) ?? 0,
            createdAt: ws.created_at,
          };
        }),
        ...closedStreams.map(({ stream: ws, piSessionId }) => ({
          id: ws.id,
          name: ws.name,
          type: ws.type,
          status: "closed" as const,
          pinned: Boolean(ws.pinned),
          closedAt: ws.closed_at ?? undefined,
          repoPath: ws.repo_path ?? undefined,
          worktreePath: ws.worktree_path ?? undefined,
          piSessionId,
          piSessionStatus: piSessionId
            ? getPiSessionStatus(this.blackboard, piSessionId)
            : undefined,
          model: persistedModelByPiSession.get(piSessionId ?? ""),
          sessionCount: sessionCountByStream.get(ws.id) ?? 0,
          createdAt: ws.created_at,
        })),
      ],
      shortcuts: this.config.shortcuts,
    };
  }

  async setStreamPinned(
    streamId: string,
    pinned: boolean,
  ): Promise<{ ok: true; streamId: string; pinned: boolean }> {
    return this.sessionManager.setStreamPinned(
      {
        streamId,
        expectedPiSessionId: this.sessionManager.getExpectedPiSessionId(streamId),
      },
      pinned,
    );
  }

  setStreamName(streamId: string, name: string): { ok: true; streamId: string; name: string } {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("name must not be empty");
    }
    const stream = setStreamName(this.blackboard, streamId, trimmed);
    if (!stream) {
      throw new Error(`Stream not found: ${streamId}`);
    }
    this.wsHub.broadcast({
      type: "streams_changed",
      reason: "renamed",
      streamId,
      streamName: stream.name,
    });
    return { ok: true, streamId, name: stream.name };
  }

  async closeSwimlaneNoop(
    streamId: string,
  ): Promise<{ ok: true; streamId: string; message: string }> {
    const piSessionId = this.sessionManager.getExpectedPiSessionId(streamId);
    if (!piSessionId) {
      throw new Error(`No pi session found for stream ${streamId}`);
    }
    const result = await this.sessionManager.closeStreamSession(
      { streamId, expectedPiSessionId: piSessionId },
      async () => {
        const prepared = await executeCloseSwimlane(
          this.blackboard,
          streamId,
          "noop",
          "closing: noop close from context menu",
        );
        if (!prepared.ok) throw new Error(prepared.message);
        return prepared;
      },
    );
    return { ok: true, streamId, message: result.message };
  }

  getSessionList(): SessionListItem[] {
    return listSessions(this.blackboard);
  }

  async getTranscript(
    sessionId: string,
    cursor?: string,
    limit: number = 50,
  ): Promise<TranscriptPageResponse> {
    const session = getSessionById(this.blackboard, sessionId);
    if (!session?.transcriptPath) {
      return {
        sessionId,
        transcriptPath: null,
        oldestFirst: true as const,
        items: [],
      };
    }
    return readTranscriptPage(sessionId, session.transcriptPath, cursor ?? "0", limit);
  }

  async directSessionMessage(
    sessionId: string,
    text: string,
  ): Promise<DirectSessionMessageResponse> {
    return directSessionMessage(this, sessionId, text);
  }

  async startWhatsAppDaemon(): Promise<RuntimeWhatsAppControlResponse> {
    if (!this.whatsappEnabled) {
      return { ok: false, status: "disabled", managedByControlSurface: true };
    }
    const existing = await getDaemonStatus();
    if (existing) {
      this.whatsappStatusCache = this.mapDaemonStatus(existing);
      return { ok: true, ...this.whatsappStatusCache };
    }
    await startDaemonProcess();
    const daemon = await waitForDaemonReady();
    this.whatsappStatusCache = this.mapDaemonStatus(daemon);
    this.watchWhatsAppStatusSignal();
    this.broadcastStatusChanged("whatsapp");
    return { ok: true, ...this.whatsappStatusCache };
  }

  async stopWhatsAppDaemon(): Promise<RuntimeWhatsAppControlResponse> {
    if (!this.whatsappEnabled) {
      return { ok: false, status: "disabled", managedByControlSurface: true };
    }
    const daemon = await stopDaemonProcess();
    this.whatsappStatusCache = this.mapDaemonStatus(daemon);
    this.broadcastStatusChanged("whatsapp");
    return { ok: true, ...this.whatsappStatusCache };
  }

  handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer | undefined): boolean {
    return this.wsHub.handleUpgrade(req, socket, head, this.config.controlSurfaceToken);
  }

  private static readonly DATETIME_INJECTION_INTERVAL_MS = 60 * 60 * 1000;

  private maybeInjectDatetime(piSessionId: string, text: string): string {
    const lastReportedAt = getLastDatetimeReportedAt(this.blackboard, piSessionId);
    const now = Date.now();
    const lastMs = lastReportedAt ? new Date(lastReportedAt).getTime() : 0;
    if (now - lastMs < ControlSurfaceRuntime.DATETIME_INJECTION_INTERVAL_MS) {
      return text;
    }

    const nowIso = new Date(now).toISOString();
    touchDatetimeReportedAt(this.blackboard, piSessionId, nowIso);

    return `${text}\n\n${formatDatetimeBlock()}`;
  }

  private resolveTargetSession(
    input: EnqueueInput,
    _item: QueueItem,
  ): ManagedPiSession | undefined {
    const meta = input.metadata;

    const targetSessionId = meta?._targetSessionId as string | undefined;
    if (targetSessionId) {
      return this.sessionManager.getByPiSessionId(targetSessionId);
    }

    if (input.source === "cron") {
      return this.sessionManager.getDefault();
    }

    const streamId = meta?.stream_id as string | undefined;
    if (streamId && meta?.router_action === "matched") {
      return this.sessionManager.getByStream(streamId);
    }

    return this.sessionManager.getDefault();
  }

  private async processQueueItem(
    managed: ManagedPiSession,
    item: QueueItem,
    steered = false,
  ): Promise<void> {
    if (steered) return this.steerQueueItem(managed, item);

    await this.sessionReloads.get(managed.piSessionId);
    if (!managed.runtime && managed.role !== "default" && managed.streamId) {
      this.log(`activating dormant stream session for stream ${managed.streamId}`);
      await this.sessionManager.activateStreamSession(
        managed,
        this.createStreamSessionTools(managed.streamId),
      );
    }

    const session = managed.runtime?.session;
    if (!session) throw new Error("pi session not initialized");

    const piSessionId = session.sessionId;
    if (item.source === "web" || item.source === "whatsapp") {
      item.text = this.maybeInjectDatetime(piSessionId, item.text);
    }
    const itemRemoteJid = extractRemoteJid(item.metadata);

    this.log(
      `processing queue item ${item.id} source=${item.source} role=${managed.role}${managed.streamId ? ` ws=${managed.streamId}` : ""} text=${item.text.slice(0, 80)}...`,
    );

    const promptAt = managed.state.notePrompt(session.messages.length);
    touchPiPrompt(this.blackboard, piSessionId, promptAt, "active");
    this.broadcastStatusChanged("pi_session");

    const promptText = formatPromptWithContext(item);

    await this.deliverQueueItem(session, item, promptText);

    this.log(`queue item ${item.id} prompt completed, messages=${session.messages.length}`);

    const lastMsg = session.messages[session.messages.length - 1];
    if (lastMsg?.role === "assistant") {
      const assistantMsg = lastMsg as AssistantMessage;
      if (assistantMsg.stopReason === "error") {
        this.log(`queue item ${item.id} API error: ${assistantMsg.errorMessage ?? "unknown"}`);
        throw new Error(
          `pi session API error: ${assistantMsg.errorMessage ?? assistantMsg.stopReason}`,
        );
      }
    }

    managed.state.noteEvent(session.messages.length);

    this.transitionStreamsAfterTurn(piSessionId);

    const finalAssistant = extractFinalAssistantMessage(session);
    const pendingSurface = managed.lastSurfacedAssistantMessage;
    managed.lastSurfacedAssistantMessage = undefined;
    if (finalAssistant) {
      const { text: finalText, messageId: finalMessageId } = finalAssistant;

      let persistedId: string | undefined;
      try {
        const streamId = managed.streamId ?? (item.metadata?.stream_id as string) ?? undefined;
        const row = persistOutboundMessage(this.blackboard, {
          id: finalMessageId,
          source: "stream_outbound",
          content: finalText,
          streamId,
          piSessionId: managed.piSessionId,
        });
        persistedId = row.id;
      } catch (error) {
        this.log(
          `outbound message persist failed (len=${finalText.length}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (pendingSurface && persistedId) {
        const surfacedPayload: StreamSurfacedWebSocketEvent = {
          type: "stream_surfaced",
          piSessionId: managed.piSessionId,
          message: pendingSurface,
          streamId: pendingSurface.streamId,
          streamName: pendingSurface.streamName,
        };
        this.wsHub.broadcast(surfacedPayload);
      }

      const surfaceText = managed.streamName ? `*[${managed.streamName}]* ${finalText}` : finalText;

      const MAX_WHATSAPP_LENGTH = 60_000;
      const waText =
        surfaceText.length > MAX_WHATSAPP_LENGTH
          ? `${surfaceText.slice(0, MAX_WHATSAPP_LENGTH)}\n\n[...truncated — full response available in web client]`
          : surfaceText;

      try {
        const targetUserId = managed.streamId
          ? whatsappUserIdFromStreamName(managed.streamName)
          : metadataString(item.metadata, "whatsapp_user_id");
        await this.sendWhatsAppCommand({
          command: "send",
          text: waText,
          contextRef: undefined,
          ...(targetUserId ? { targetUserId } : { remoteJid: itemRemoteJid }),
        });
      } catch (error) {
        this.log(
          `auto-surface to WhatsApp failed (len=${surfaceText.length}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async steerQueueItem(managed: ManagedPiSession, item: QueueItem): Promise<void> {
    const session = managed.runtime?.session;
    if (!session?.isStreaming) throw new Error("pi session is not available for steering");

    if (item.source === "web" || item.source === "whatsapp") {
      item.text = this.maybeInjectDatetime(session.sessionId, item.text);
    }
    if (item.source !== "hook") managed.state.addSteeredItem(item);
    try {
      const delivery = this.deliverQueueItem(session, item, formatPromptWithContext(item));
      this.log(`queue item ${item.id} delivered as steering guidance`);
      await delivery;
    } catch (error) {
      managed.state.removeSteeredItem(item);
      throw error;
    }
  }

  private deliverQueueItem(session: AgentSession, item: QueueItem, text: string): Promise<void> {
    if (item.source !== "hook") {
      return session.prompt(text, {
        streamingBehavior: "steer",
        images: item.images,
      });
    }
    const content = item.images?.length ? [{ type: "text" as const, text }, ...item.images] : text;
    return session.sendCustomMessage(
      {
        customType: "flitterbot-hook",
        content,
        display: true,
        details: { queueItemId: item.id, metadata: item.metadata },
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  }

  private transitionStreamsAfterTurn(piSessionId: string): void {
    try {
      const row = this.blackboard
        .prepare(
          `SELECT COUNT(*) as count FROM sessions
				 WHERE pi_session_id = ? AND status = 'working' AND agent_managed = 1`,
        )
        .get(piSessionId) as { count: number } | undefined;
      const activeCount = row?.count ?? 0;

      const nextStatus = activeCount > 0 ? "waiting_for_sessions" : "waiting_for_user";
      updatePiSessionStatus(this.blackboard, piSessionId, nextStatus);
      this.broadcastStatusChanged("pi_session");
    } catch (error) {
      this.log(
        `streams state transition failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async spawnStreamWithSession(opts: {
    name: string;
    cwd: string;
    type?: StreamType;
    streamUser?: string;
    repoPath?: string;
    worktreePath?: string;
    baseBranch?: string;
    resumeSessionFile?: string;
  }): Promise<
    | { ok: true; streamId: string; streamName: string; managed: ManagedPiSession }
    | { ok: false; streamId: null; streamName: string; spawnError: Error }
  > {
    const { insertStream, enrichStream, deleteStream } = await import(
      "./blackboard/query-streams.ts"
    );

    if (!fs.existsSync(opts.cwd)) {
      throw new Error(`cwd path "${opts.cwd}" does not exist`);
    }

    const ws = insertStream(this.blackboard, opts.name, opts.type ?? "work", opts.streamUser);
    enrichStream(
      this.blackboard,
      ws.id,
      opts.repoPath ?? opts.cwd,
      opts.worktreePath,
      opts.baseBranch,
    );

    try {
      const managed =
        opts.type === "defaultStream"
          ? await this.sessionManager.createDefaultStream(
              ws.id,
              ws.name,
              opts.cwd,
              this.createCustomTools("default", ws.id),
            )
          : await this.sessionManager.createOrchestrator(
              ws.id,
              ws.name,
              opts.cwd,
              this.createCustomTools("orchestrator", ws.id),
              opts.resumeSessionFile,
            );
      this.wsHub.broadcast({
        type: "streams_changed",
        reason: "created",
        streamId: ws.id,
        streamName: ws.name,
      });
      return { ok: true, streamId: ws.id, streamName: ws.name, managed };
    } catch (error) {
      const spawnError = error instanceof Error ? error : new Error(String(error));
      try {
        deleteStream(this.blackboard, ws.id);
        this.log(
          `${opts.type ?? "work"} stream session spawn failed for "${ws.name}" (${ws.id}); rolled back stream row: ${spawnError.message}`,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [spawnError, cleanupError],
          `${opts.type ?? "work"} stream session spawn failed and rollback failed for "${ws.name}" (${ws.id})`,
        );
      }
      return { ok: false, streamId: null, streamName: ws.name, spawnError };
    }
  }

  async createSwimlaneProgrammatic(input?: {
    name?: string;
    cwd?: string;
  }): Promise<{ ok: true; streamId: string; streamName: string; piSessionId: string }> {
    const { getStreamByName } = await import("./blackboard/query-streams.ts");

    let name = input?.name ? stripStreamNamePrefix(input.name) : "";
    if (!name) {
      for (let i = 0; i < 5; i++) {
        const candidate = `scratch-${crypto.randomUUID().slice(0, 6)}`;
        if (!getStreamByName(this.blackboard, candidate)) {
          name = candidate;
          break;
        }
      }
      if (!name) throw new Error("Failed to generate unique stream name");
    }

    const effectiveCwd = input?.cwd ?? this.config.projectsDir;
    this.log(`programmatic swimlane create requested name="${name}" cwd=${effectiveCwd}`);

    const result = await this.spawnStreamWithSession({
      name,
      cwd: effectiveCwd,
    });
    if (!result.ok) {
      throw result.spawnError;
    }
    this.log(`programmatic swimlane created "${result.streamName}" (${result.streamId})`);
    return {
      ok: true,
      streamId: result.streamId,
      streamName: result.streamName,
      piSessionId: result.managed.piSessionId,
    };
  }

  async setStreamCwd(
    streamId: string,
    cwdInput: string,
  ): Promise<{ ok: true; streamId: string; cwd: string; piSessionId: string }> {
    const cwd = this.resolveStreamCwdInput(cwdInput);
    const stat = fs.statSync(cwd, { throwIfNoEntry: false });
    if (!stat?.isDirectory())
      throw new Error(`cwd path "${cwd}" does not exist or is not a directory`);

    const ws = getStreamById(this.blackboard, streamId);
    if (!ws) throw new Error("Stream not found");
    if (ws.status !== "open") throw new Error("Stream is not open");

    const managed = this.sessionManager.getByStream(streamId);
    if (!managed) throw new Error("No orchestrator session for stream");
    if (managed.state.getSnapshot().busy)
      throw new Error("Cannot switch cwd while session is busy");
    if (managed.role !== "orchestrator")
      throw new Error("cwd switch is only supported for work streams");
    const switched = await this.sessionManager.switchStreamCwd(
      streamId,
      cwd,
      this.createCustomTools("orchestrator", streamId),
    );
    this.log(`stream cwd switched "${ws.name}" (${streamId}) → ${cwd}`);
    return { ok: true, streamId, cwd, piSessionId: switched.piSessionId };
  }

  private resolveStreamCwdInput(input: string): string {
    const raw = input.trim().replace(/^@/, "");
    if (!raw) return path.resolve(this.config.projectsDir);
    const expanded = raw.startsWith("~")
      ? path.resolve(os.homedir(), raw === "~" ? "." : raw.slice(2))
      : path.isAbsolute(raw)
        ? path.resolve(raw)
        : path.resolve(this.config.projectsDir, raw);
    const rel = path.relative(os.homedir(), expanded);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("cwd must stay under the home directory");
    }
    return expanded;
  }

  async reopenStream(streamId: string): Promise<{ ok: boolean; streamId: string }> {
    const ws = getStreamById(this.blackboard, streamId);
    if (!ws) throw new Error("Stream not found");

    await this.sessionManager.reopenStreamSession({
      streamId,
      expectedPiSessionId: this.sessionManager.getExpectedPiSessionId(streamId),
    });

    if (shouldReconcileWorktreeOnRecovery(ws.status)) {
      const reconciled = clearWorktreePathIfStale(this.blackboard, ws);
      if (reconciled.cleared) {
        this.log(
          `cleared stale worktree_path for reopened stream "${ws.name}" (${streamId}): ${reconciled.previousPath} (${reconciled.reason})`,
        );
      }
    }

    const reopenReason =
      ws.status === "closed" ? "reopened closed stream" : "recovered dead pi-session for stream";
    this.log(`${reopenReason} "${ws.name}" (${streamId})`);
    return { ok: true, streamId };
  }

  private async reloadIdleSessions(): Promise<void> {
    const defaultSession = this.sessionManager.getDefault();
    const sessions = [
      ...(defaultSession ? [defaultSession] : []),
      ...this.sessionManager.listStreamSessions(),
    ];
    let reloaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const managed of sessions) {
      const piSessionId = managed.piSessionId;
      const session = managed.runtime?.session;
      const label = managed.streamName ?? managed.role;
      if (
        !session ||
        this.sessionReloads.has(piSessionId) ||
        managed.queue.isBusy() ||
        session.isStreaming ||
        session.isCompacting
      ) {
        skipped++;
        this.log(`/reload: skipped busy or dormant session ${managed.piSessionId} (${label})`);
        continue;
      }

      const reload = managed.streamId
        ? this.sessionManager.withStreamOperation(
            { streamId: managed.streamId, expectedPiSessionId: piSessionId },
            async () => {
              const current = this.sessionManager.getByStream(managed.streamId!);
              if (current !== managed || !current.runtime) {
                throw new Error("Stream session changed before reload");
              }
              if (!current.queue.pause()) throw new Error("Pi session is busy");
              try {
                await current.runtime.session.reload();
              } finally {
                current.queue.resume();
              }
            },
          )
        : session.reload();
      const gate = reload.catch(() => {});
      this.sessionReloads.set(piSessionId, gate);
      try {
        await reload;
        reloaded++;
      } catch (error) {
        failed++;
        this.log(
          `/reload: session ${piSessionId} (${label}) failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (this.sessionReloads.get(piSessionId) === gate) {
          this.sessionReloads.delete(piSessionId);
        }
      }
    }

    this.log(`/reload: reloaded ${reloaded}, skipped ${skipped}, failed ${failed}`);
    if (reloaded > 0) this.wsHub.broadcast({ type: "resources_reloaded" });
  }

  private resolveCompactTargetPiSessionId(
    metadata: MessageMetadata | undefined,
  ): string | undefined {
    if (typeof metadata?._targetSessionId === "string" && metadata._targetSessionId.trim()) {
      return metadata._targetSessionId;
    }
    if (typeof metadata?.stream_id === "string" && metadata.stream_id.trim()) {
      return this.sessionManager.getByStream(metadata.stream_id)?.piSessionId;
    }
    return this.sessionManager.getDefault()?.piSessionId;
  }

  async compactPiSession(
    piSessionId: string,
    customInstructions?: string,
  ): Promise<{
    ok: true;
    piSessionId: string;
    messageCount: number;
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
  }> {
    const managed = this.sessionManager.getByPiSessionId(piSessionId);
    if (!managed) throw new Error("Pi session not found");
    if (managed.streamId) {
      return this.sessionManager.withActiveStreamOperation(
        { streamId: managed.streamId, expectedPiSessionId: piSessionId },
        this.createStreamSessionTools(managed.streamId),
        (active) => this.compactClaimedPiSession(active, active.piSessionId, customInstructions),
      );
    }
    return this.compactClaimedPiSession(managed, piSessionId, customInstructions);
  }

  private async compactClaimedPiSession(
    managed: ManagedPiSession,
    piSessionId: string,
    customInstructions?: string,
  ) {
    if (this.compactionClaims.has(managed)) throw new Error("Pi session is already compacting");
    this.compactionClaims.add(managed);
    try {
      return await this.compactManagedPiSession(managed, piSessionId, customInstructions);
    } finally {
      this.compactionClaims.delete(managed);
    }
  }

  private async compactManagedPiSession(
    managed: ManagedPiSession,
    piSessionId: string,
    customInstructions?: string,
  ) {
    if (!managed.queue.pause()) throw new Error("Pi session is busy");
    try {
      const session = managed.runtime?.session;
      if (!session) throw new Error("Pi session failed to activate");
      if (session.isCompacting) throw new Error("Pi session is already compacting");
      if (session.isStreaming) throw new Error("Pi session is busy");
      const result: CompactionResult = await session.compact(
        customInstructions?.trim() || undefined,
      );
      const newCount = session.messages.length;
      managed.state.noteEvent(newCount);

      this.log(
        `compacted pi session ${piSessionId} at entry ${result.firstKeptEntryId} (${result.tokensBefore} tokens before; messages now ${newCount})`,
      );
      return {
        ok: true as const,
        piSessionId,
        messageCount: newCount,
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
      };
    } finally {
      managed.queue.resume();
    }
  }

  async pruneStreamHistory(
    piSessionId: string,
    entryId: string,
  ): Promise<{ ok: true; piSessionId: string; messageCount: number }> {
    const managed = this.sessionManager.getByPiSessionId(piSessionId);
    if (!managed) throw new Error("Pi session not found");
    if (managed.streamId) {
      return this.sessionManager.withActiveStreamOperation(
        { streamId: managed.streamId, expectedPiSessionId: piSessionId },
        this.createStreamSessionTools(managed.streamId),
        (active) => this.pruneManagedStreamHistory(active, active.piSessionId, entryId),
      );
    }
    return this.pruneManagedStreamHistory(managed, piSessionId, entryId);
  }

  private async pruneManagedStreamHistory(
    managed: ManagedPiSession,
    piSessionId: string,
    entryId: string,
  ): Promise<{ ok: true; piSessionId: string; messageCount: number }> {
    if (!managed.queue.pause()) throw new Error("Pi session is busy");
    try {
      const session = managed.runtime?.session;
      if (!session) throw new Error("Pi session failed to activate");

      const sessionManager = session.sessionManager;
      const target = sessionManager.getEntry(entryId);
      if (!target) throw new Error(`Session entry ${entryId} not found`);
      if (target.type !== "message" || target.message.role !== "user") {
        throw new Error(`Entry ${entryId} is not a user message (type=${target.type})`);
      }

      const navResult = await session.navigateTree(entryId);
      if (navResult.cancelled) {
        throw new Error("navigateTree cancelled (extension veto)");
      }

      sessionManager.appendCustomEntry("flitterbot:prune_anchor", {
        prunedEntryId: entryId,
        prunedAt: new Date().toISOString(),
      });

      const newCount = session.messages.length;
      managed.state.noteEvent(newCount);

      this.wsHub.broadcastHistoryCommit({
        type: "history_rewritten",
        piSessionId,
        reason: "prune",
      });

      this.log(
        `pruned history for pi session ${piSessionId} at entry ${entryId} (messages now ${newCount})`,
      );
      return { ok: true, piSessionId, messageCount: newCount };
    } finally {
      managed.queue.resume();
    }
  }

  async forkStream(
    sourcePiSessionId: string,
    entryId?: string,
  ): Promise<{ ok: true; streamId: string; streamName: string; piSessionId: string }> {
    const managed = this.sessionManager.getByPiSessionId(sourcePiSessionId);
    if (!managed) throw new Error("Pi session not found");
    if (managed.streamId) {
      return this.sessionManager.withStreamOperation(
        { streamId: managed.streamId, expectedPiSessionId: sourcePiSessionId },
        () => this.forkManagedStream(managed, sourcePiSessionId, entryId),
      );
    }
    return this.forkManagedStream(managed, sourcePiSessionId, entryId);
  }

  private async forkManagedStream(
    managed: ManagedPiSession,
    sourcePiSessionId: string,
    entryId?: string,
  ): Promise<{ ok: true; streamId: string; streamName: string; piSessionId: string }> {
    if (!managed.queue.pause()) throw new Error("Pi session is busy");
    try {
      return await this.forkManagedStreamWhilePaused(managed, sourcePiSessionId, entryId);
    } finally {
      managed.queue.resume();
    }
  }

  private async forkManagedStreamWhilePaused(
    managed: ManagedPiSession,
    sourcePiSessionId: string,
    entryId?: string,
  ): Promise<{ ok: true; streamId: string; streamName: string; piSessionId: string }> {
    const sourceStream = managed.streamId ? getStreamById(this.blackboard, managed.streamId) : null;
    const row = this.blackboard.get<{ session_file: string | null; cwd: string | null }>(
      "SELECT session_file, cwd FROM pi_sessions WHERE pi_session_id = ?",
      sourcePiSessionId,
    );
    const sourceFile = managed.state.getSnapshot().sessionFile ?? row?.session_file ?? undefined;
    if (!sourceFile || !fs.existsSync(sourceFile)) {
      throw new Error("Source session file not found");
    }
    const sourceHeaderPiSessionId = readPiSessionHeaderId(sourceFile);
    if (sourceHeaderPiSessionId !== sourcePiSessionId) {
      throw new Error(
        `Source session file identity mismatch: expected ${sourcePiSessionId}, found ${sourceHeaderPiSessionId}`,
      );
    }

    const forkManager = SessionManager.open(sourceFile, this.config.controlSurfaceSessionsDir);
    let leafId: string | null;
    if (entryId) {
      const target = forkManager.getEntry(entryId);
      if (!target) throw new Error(`Session entry ${entryId} not found`);
      if (target.type !== "message" || target.message.role !== "user") {
        throw new Error(`Entry ${entryId} is not a user message (type=${target.type})`);
      }
      leafId = target.parentId;
    } else {
      leafId = forkManager.getLeafId();
    }
    if (!leafId) throw new Error("Nothing to fork before the target message");

    const forkedFile = forkManager.createBranchedSession(leafId);
    if (!forkedFile) throw new Error("Failed to create forked session");
    if (!fs.existsSync(forkedFile)) {
      throw new Error("Nothing to fork: the selected branch has no completed turns yet");
    }

    const baseName = stripStreamNamePrefix(
      sourceStream?.name ?? managed.streamName ?? "flitterbot",
    );
    const cwd = row?.cwd ?? sourceStream?.repo_path ?? this.config.projectsDir;
    const result = await this.spawnStreamWithSession({
      name: baseName,
      cwd,
      repoPath: sourceStream?.repo_path ?? cwd,
      ...(sourceStream?.worktree_path ? { worktreePath: sourceStream.worktree_path } : {}),
      ...(sourceStream?.base_branch ? { baseBranch: sourceStream.base_branch } : {}),
      resumeSessionFile: forkedFile,
    });
    if (!result.ok) throw result.spawnError;

    this.log(
      `forked session "${sourceStream?.name ?? managed.streamId ?? "default"}" \u2192 "${result.streamName}" (${result.streamId})`,
    );
    return {
      ok: true,
      streamId: result.streamId,
      streamName: result.streamName,
      piSessionId: result.managed.piSessionId,
    };
  }

  private async ensureWhatsAppUserDefaultStreams(): Promise<void> {
    if (!this.whatsappEnabled) return;

    const config = loadWhatsAppConfig();
    for (const userId of Object.keys(config.users)) {
      if (config.defaultUser === userId) continue;

      const streamName = `flitterbot: ${userId}`;
      let stream = getStreamByName(this.blackboard, streamName);

      if (stream && stream.type !== "defaultStream") {
        stream = setStreamType(this.blackboard, stream.id, "defaultStream") ?? stream;
      }

      if (stream?.status === "closed") {
        await this.reopenStream(stream.id);
        stream = getStreamById(this.blackboard, stream.id);
        if (stream)
          this.log(`reopened WhatsApp default stream for user "${userId}" (${stream.id})`);
      }

      if (!stream) {
        const created = await this.createWhatsAppDefaultStream(streamName, userId);
        this.log(`created WhatsApp default stream for user "${userId}" (${created.streamId})`);
        continue;
      }

      if (!stream.stream_user) {
        this.blackboard
          .prepare("UPDATE streams SET stream_user = ? WHERE id = ?")
          .run(userId, stream.id);
      }

      let managed = this.sessionManager.getByStream(stream.id);
      if (!managed) {
        const latestPiSessionId = getStreamPiSessionId(this.blackboard, stream.id);
        const latestStatus = latestPiSessionId
          ? getPiSessionStatus(this.blackboard, latestPiSessionId)
          : undefined;
        if (latestStatus === "ended" || latestStatus === "crashed") {
          await this.reopenStream(stream.id);
          managed = this.sessionManager.getByStream(stream.id);
          this.log(`recovered WhatsApp default stream for user "${userId}" (${stream.id})`);
        }
      }
      if (managed) continue;

      this.log(`creating missing WhatsApp default stream session for user "${userId}"`);
      await this.sessionManager.createDefaultStream(
        stream.id,
        stream.name,
        stream.repo_path ?? this.config.projectsDir,
        this.createCustomTools("default", stream.id),
      );
    }
  }

  private async createWhatsAppDefaultStream(
    streamName: string,
    streamUser: string,
  ): Promise<{ streamId: string; streamName: string; piSessionId: string }> {
    const spawn = await this.spawnStreamWithSession({
      name: streamName,
      cwd: this.config.projectsDir,
      type: "defaultStream",
      streamUser,
    });
    if (!spawn.ok) throw spawn.spawnError;
    this.enqueueDefaultStreamFirstMessage(spawn.managed);
    return {
      streamId: spawn.streamId,
      streamName: spawn.streamName,
      piSessionId: spawn.managed.piSessionId,
    };
  }

  private enqueueDefaultStreamFirstMessage(managed: ManagedPiSession): void {
    const text = this.config.defaultAgentFirstMessage.trim();
    if (!text || !managed.streamId) return;
    managed.queue.enqueue({
      id: `default-stream-init-${managed.streamId}`,
      text,
      source: "init",
      sender: "system",
      metadata: {
        stream_id: managed.streamId,
        stream_name: managed.streamName ?? undefined,
        via: "defaultStream",
      },
      receivedAt: new Date().toISOString(),
    });
  }

  private createStreamSessionTools(streamId: string): FlitterbotTool[] {
    const stream = getStreamById(this.blackboard, streamId);
    return this.createCustomTools(
      stream?.type === "defaultStream" ? "default" : "orchestrator",
      streamId,
    );
  }

  private persistStreamWhatsAppOwner(
    streamId: string,
    streamName: string,
    piSessionId: string | undefined,
    remoteJid: string,
    content = "WhatsApp stream owner set.",
  ): void {
    try {
      persistInboundMessage(this.blackboard, {
        source: "agent",
        content,
        sender: "system",
        streamId,
        piSessionId,
        metadata: {
          stream_id: streamId,
          stream_name: streamName,
          stream_owner_remote_jid: remoteJid,
        },
      });
    } catch (error) {
      this.log(
        `stream WhatsApp owner persist failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  createCustomTools(
    role: "orchestrator" | "default" = "default",
    streamId?: string,
  ): FlitterbotTool[] {
    const tools: FlitterbotTool[] = [createQueryBlackboardTool(this.blackboard)];

    if (role === "default") {
      tools.push({
        name: "create_swimlane",
        label: "Create Swimlane",
        description:
          "Create a new swimlane and spawn a dedicated orchestrator for it. Use when the user requests any work (features, bugs, investigations, even web research) that might benefit from a dedicated session.",
        parameters: {
          type: "object",
          properties: {
            suggested_name: {
              type: "string",
              description:
                "Your suggested name for the swimlane — 2-4 words, lowercase, dash-separated. Prefix it with intent: 'i-' for investigations, 'wr-' for web research, 'bug-' or 'fix-' for bug fixes, 'bs-' for repo brainstorms (e.g. 'i-wu-lifecycle', 'fix-auth-token-refresh'). The tool normalizes this into a canonical name by stripping the leading intent prefix, so the stored swimlane name, worktree dir, and branch stay tight. The canonical name is returned in the response — use it for any subsequent references.",
            },
            message: {
              type: "string",
              description:
                "Optional agent-authored context appended after the passed-through user message. Use for interpretation, constraints, repo/spec paths, or batch-created swimlane instructions. Do not duplicate the user's request here during normal single-swimlane creation — the runtime passes the user's message through automatically.",
            },
            cwd: {
              type: "string",
              description:
                "Absolute path to use as the working directory for the new swimlane's orchestrator and agents.",
            },
            skipUserMessage: {
              type: "boolean",
              description:
                "Set true only when batch-creating multiple new swimlanes and the message field contains the targeted full prompt for this swimlane. Leave false/omitted for normal swimlane creation so the runtime can pass through the relevant user messages.",
            },
          },
          required: ["suggested_name", "cwd"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const {
            suggested_name: suggestedName,
            message: agentMessage,
            cwd: cwdParam,
            skipUserMessage: skipUserMessageParam,
          } = params as {
            suggested_name: string;
            message?: string;
            cwd: string;
            skipUserMessage?: boolean;
          };
          const name = stripStreamNamePrefix(suggestedName);
          const skipUserMessage = skipUserMessageParam === true;
          if (skipUserMessage && !agentMessage?.trim()) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: skipUserMessage=true is only valid when message contains the targeted batch prompt for this swimlane.",
                },
              ],
              details: { error: true },
            };
          }

          if (!fs.existsSync(cwdParam)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: cwd path "${cwdParam}" does not exist`,
                },
              ],
              details: {},
            };
          }
          const effectiveCwd = cwdParam;

          const nameTrace =
            suggestedName !== name ? `"${name}" (from "${suggestedName}")` : `"${name}"`;
          this.log(`default agent creating swimlane ${nameTrace} cwd=${effectiveCwd}`);

          const parentStream = streamId ? getStreamById(this.blackboard, streamId) : null;
          const streamUser =
            parentStream?.stream_user ?? loadWhatsAppConfig().defaultUser ?? undefined;

          const spawn = await this.spawnStreamWithSession({
            name,
            cwd: effectiveCwd,
            streamUser,
          });

          if (!spawn.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: `Swimlane creation failed before orchestrator spawn: ${spawn.spawnError.message}`,
                },
              ],
              details: {
                streamId: spawn.streamId,
                canonicalName: spawn.streamName,
                suggestedName,
                namePrefixStripped: suggestedName !== name,
                error: true,
              },
            };
          }

          const ws = { id: spawn.streamId, name: spawn.streamName };
          const orchestrator = spawn.managed;

          try {
            const sourceSession = streamId
              ? this.sessionManager.getByStream(streamId)
              : this.sessionManager.getDefault();
            const currentItem = sourceSession?.queue.getCurrentItem();
            const originalText = currentItem?.text;
            const inheritedReplyMetadata = whatsappReplyMetadataFrom(currentItem);
            const inheritedRemoteJid = extractRemoteJid(inheritedReplyMetadata);
            if (inheritedRemoteJid) {
              orchestrator.whatsappRemoteJid = inheritedRemoteJid;
              this.persistStreamWhatsAppOwner(
                ws.id,
                ws.name,
                orchestrator.piSessionId,
                inheritedRemoteJid,
              );
            }
            const currentUserText = originalText
              ? stripInjectedDatetimeBlocks(originalText)
              : undefined;

            const tmuxBootstrapMessage = resolveTmuxBootstrapMessage(
              this.config.tmuxEnabled,
              this.config.tmuxBootstrapMessage,
            );

            if (currentUserText && !skipUserMessage) {
              let prompt: string;
              try {
                const { getRecentDefaultMessages } = await import("./blackboard/query-messages.ts");
                const { getPreviousStreamCreatedAt } = await import(
                  "./blackboard/query-streams.ts"
                );
                const { resolveGroqApiKey } = await import("./classifier/groq-client.ts");
                const { classifyContextRelevance } = await import(
                  "./classifier/context-relevance.ts"
                );
                const { formatStreamPrompt } = await import("./streams/format-stream-prompt.ts");
                const apiKey = resolveGroqApiKey();

                const boundary = getPreviousStreamCreatedAt(this.blackboard, ws.id);
                const recentMessages = getRecentDefaultMessages(this.blackboard, 10, boundary);

                if (role === "default" && apiKey && recentMessages.length > 1) {
                  const relevance = await classifyContextRelevance(
                    recentMessages,
                    ws.name,
                    apiKey,
                    agentMessage,
                    this.log.bind(this),
                  );
                  const relevantTexts = recentMessages
                    .filter((_, i) => relevance[i])
                    .map((m) => m.content);

                  if (relevantTexts.length > 1) {
                    if (!relevantTexts.includes(currentUserText)) {
                      relevantTexts.push(currentUserText);
                    }
                    prompt = formatStreamPrompt(
                      relevantTexts,
                      ws.name,
                      ws.id,
                      agentMessage,
                      tmuxBootstrapMessage,
                    );
                    this.log(
                      `context classifier: ${relevantTexts.length}/${recentMessages.length} messages relevant for "${ws.name}"`,
                    );
                  } else {
                    prompt = this.sessionManager.buildStreamPrompt(
                      currentUserText,
                      ws.name,
                      ws.id,
                      agentMessage,
                      tmuxBootstrapMessage,
                    );
                  }
                } else {
                  prompt = this.sessionManager.buildStreamPrompt(
                    currentUserText,
                    ws.name,
                    ws.id,
                    agentMessage,
                    tmuxBootstrapMessage,
                  );
                }
              } catch (error) {
                this.log(
                  `context classifier failed, falling back to single message: ${error instanceof Error ? error.message : String(error)}`,
                );
                this.wsHub.broadcast({
                  type: "error",
                  message:
                    "Context classification failed — swimlane context limited to current message.",
                });
                prompt = this.sessionManager.buildStreamPrompt(
                  currentUserText,
                  ws.name,
                  ws.id,
                  agentMessage,
                  tmuxBootstrapMessage,
                );
              }

              orchestrator.queue.enqueue({
                id: `ws-init-${ws.id}`,
                text: prompt,
                source: "web",
                sender: "system",
                metadata: {
                  stream_id: ws.id,
                  stream_name: ws.name,
                  ...inheritedReplyMetadata,
                },
                receivedAt: new Date().toISOString(),
              });
              this.log(`enqueued original user message onto swimlane "${ws.name}" (${ws.id})`);
            } else if (skipUserMessage && agentMessage) {
              const { formatStreamPrompt } = await import("./streams/format-stream-prompt.ts");
              const prompt = formatStreamPrompt(
                [],
                ws.name,
                ws.id,
                agentMessage,
                tmuxBootstrapMessage,
              );
              orchestrator.queue.enqueue({
                id: `ws-init-${ws.id}`,
                text: prompt,
                source: "web",
                sender: "system",
                metadata: {
                  stream_id: ws.id,
                  stream_name: ws.name,
                  ...inheritedReplyMetadata,
                },
                receivedAt: new Date().toISOString(),
              });
              this.log(
                `enqueued agent-only message onto swimlane "${ws.name}" (${ws.id}) [batch mode]`,
              );
            }

            const passthroughNote = skipUserMessage
              ? agentMessage
                ? " with agent-authored context (batch mode)"
                : ""
              : currentUserText
                ? " and user message passed through"
                : "";
            const normalizationNote =
              suggestedName !== name
                ? ` Suggested name "${suggestedName}" normalized to canonical "${name}".`
                : "";
            return {
              content: [
                {
                  type: "text",
                  text: `Swimlane created (ID: ${ws.id}, canonical name: "${ws.name}"). Orchestrator spawned${passthroughNote}.${normalizationNote} Use the canonical name for any subsequent references.`,
                },
              ],
              details: {
                streamId: ws.id,
                canonicalName: ws.name,
                suggestedName,
                namePrefixStripped: suggestedName !== name,
              },
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Swimlane "${ws.name}" (ID: ${ws.id}) created and orchestrator spawned, but bootstrap prompt enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              details: {
                streamId: ws.id,
                canonicalName: ws.name,
                suggestedName,
                namePrefixStripped: suggestedName !== name,
                error: true,
              },
            };
          }
        },
      });

      tools.push({
        name: "enqueue_message",
        label: "Enqueue Message",
        description:
          "Send a message to an existing orchestrator or stream. Use ONLY when the intended target is clearly the existing stream based on context, or explicit call out. Can be used to nudge an orchestrator or provide additional context that was missing the first time around. Note that even for connected matters, the user's intent is likely to create a stream or spawn an orchestrator — use create_swimlane for that. You can default to creating a new swimlane unless it is very clearly meant for the same stream",
        parameters: {
          type: "object",
          properties: {
            stream_id: {
              type: "string",
              description: "ID of the target stream",
            },
            message: {
              type: "string",
              description:
                "Message content to deliver to the orchestrator. Include relevant context.",
            },
          },
          required: ["stream_id", "message"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const { stream_id, message } = params as { stream_id: string; message: string };
          const { getStreamById } = await import("./blackboard/query-streams.ts");
          const ws = getStreamById(this.blackboard, stream_id);
          if (!ws) {
            return {
              content: [{ type: "text", text: `Stream not found: ${stream_id}` }],
              details: { error: true },
            };
          }
          if (ws.status !== "open") {
            return {
              content: [{ type: "text", text: `Stream is closed: ${ws.name}` }],
              details: { error: true },
            };
          }

          const orchestrator = this.sessionManager.getByStream(ws.id);
          if (!orchestrator) {
            return {
              content: [
                {
                  type: "text",
                  text: `No running orchestrator for stream: ${ws.name}`,
                },
              ],
              details: { error: true },
            };
          }

          try {
            orchestrator.queue.assertAccepting();
            const persisted = persistInboundMessage(this.blackboard, {
              source: "agent",
              content: message,
              sender: "system",
              streamId: ws.id,
              piSessionId: orchestrator.piSessionId,
              metadata: {
                stream_id: ws.id,
                stream_name: ws.name,
                enqueued_by: "enqueue_message_tool",
              },
            });
            orchestrator.queue.enqueue({
              id: `enq-msg-${crypto.randomUUID()}`,
              text: message,
              source: "agent",
              sender: "system",
              metadata: {
                stream_id: ws.id,
                stream_name: ws.name,
              },
              receivedAt: new Date().toISOString(),
              serverMessageId: persisted.id,
            });
          } catch (enqueueError) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to enqueue message to stream "${ws.name}": ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}`,
                },
              ],
              details: { error: true },
            };
          }

          this.log(
            `enqueued message onto stream "${ws.name}" (${ws.id}), queue depth: ${orchestrator.queue.getDepth()}`,
          );

          return {
            content: [
              {
                type: "text",
                text: `Message enqueued to stream "${ws.name}" (queue depth: ${orchestrator.queue.getDepth()}).`,
              },
            ],
            details: {
              streamId: ws.id,
              streamName: ws.name,
              queueDepth: orchestrator.queue.getDepth(),
            },
          };
        },
      });
    }

    if (role === "orchestrator") {
      tools.push({
        name: "set_up_worktree",
        label: "Set Up Worktree",
        description:
          "Inspect or apply the current stream's git worktree setup. mode is required. mode:'inspect' accepts no other args and reports the current repo, stream worktree, [flitterbot] config, resolved create base, planned create path, and discovery advisory when config is missing. mode:'apply' creates a new worktree when path is omitted, or attaches an existing worktree when path is provided. Applying requires [flitterbot] bootstrap config; if config is missing, no worktree is created and the agent should run inspect. base_ref chooses the create base, or updates only the recorded merge target when the stream already has a worktree; it never rebases/resets/moves the checkout. Attaching with path requires base_ref so the merge target is explicit. force:true means delink the current stream worktree association and mint a fresh new worktree; force cannot be combined with path. Stream and repo are ambient: the tool is bound to the current stream, and repo is resolved from the orchestrator cwd then anchored on the repo's main worktree.",

        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["inspect", "apply"],
              description:
                "Required. inspect reports config/discovery and makes no changes; apply creates, attaches, or retargets the stream worktree.",
            },
            path: {
              type: "string",
              description:
                "Existing git worktree path to attach. Only valid with mode:'apply', and base_ref is required with path.",
            },
            base_ref: {
              type: "string",
              description:
                "Branch to fork from for create, or recorded merge target for an existing/attached worktree. Does NOT accept SHAs or tags.",
            },
            force: {
              type: "boolean",
              description:
                "Only valid with mode:'apply' and no path. Delink the current stream worktree association and mint a fresh new worktree; old worktree is left on disk.",
            },
          },
          required: ["mode"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const { mode, path, base_ref, force } = params as {
            mode: "inspect" | "apply";
            path?: string;
            base_ref?: string;
            force?: boolean;
          };
          if (!streamId) {
            return {
              content: [
                { type: "text", text: "Error: set_up_worktree is only available on a stream." },
              ],
              details: { ok: false },
            };
          }
          const stream_id = streamId;
          const latestPiSession = getStreamPiSessionRow(this.blackboard, stream_id);
          const orchestratorCwd =
            latestPiSession?.role === "orchestrator" ? latestPiSession.cwd : undefined;
          if (!orchestratorCwd) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: no orchestrator pi_session found for stream ${stream_id} — cannot resolve repo_path / base_ref defaults.`,
                },
              ],
              details: { ok: false, streamId: stream_id },
            };
          }
          const result = await executeSetUpWorktree(
            this.blackboard,
            stream_id,
            orchestratorCwd,
            mode,
            base_ref,
            force,
            path,
          );
          if (result.ok) {
            const worktreePiSessionId = this.sessionManager.getByStream(stream_id)?.piSessionId;
            if (worktreePiSessionId) {
              this.sessionManager.toolDisplayCache.invalidatePiSession(worktreePiSessionId);
              this.wsHub.broadcast({
                type: "worktree_changed",
                piSessionId: worktreePiSessionId,
                streamId: stream_id,
              });
            }
          }
          return { content: [{ type: "text", text: result.message }], details: result };
        },
      });

      const closeSwimlaneId = streamId;
      tools.push({
        name: "close_swimlane",
        label: "Close Swimlane",
        description:
          'Close the current stream. ONLY call when the user explicitly signals finality (e.g., "looks good", "ship it", "done"). Requests like "merge with main" or "rebase" are NOT close signals — run those as git commands directly. Mode is required: "merge" merges the branch and closes the stream; "noop" skips all git operations and just closes the stream record (use only when the user explicitly says don\'t merge). commit_message is required: it is used to commit any uncommitted in-flight work in the worktree before the merge — author it from `git log <base>..HEAD --oneline` and `git diff HEAD` so it describes the actual work, not a placeholder. The merge commit itself uses git\'s default message ("Merge branch \'X\' into Y"). Merge uses a two-call flow: call first without base_branch to get a non-destructive preview (returns current branch + resolved base branch); relay to user as "Merge <current> → <base>. Confirm, or name a different branch." If resolved base is null, ask the user for a branch first. Call again with explicit base_branch to execute. On merge conflicts the tool aborts cleanly, leaves the repo untouched, returns the conflict list, and the stream stays open; resolve each file intelligently (retain both sides when additive/non-overlapping, pick the superseding side when one replaces the other, stop and ask the user if ambiguous — never silently discard), then call close_swimlane again. Don\'t autonomously open PRs. Don\'t autonomously merge into main unless the user named it.',
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["merge", "noop"],
              description:
                '"merge" commits uncommitted changes, merges branch to the stream\'s base branch, and pushes. On the first merge call without base_branch, returns a non-destructive preview with the current branch and resolved base branch for user confirmation; pass explicit base_branch on the follow-up call to actually execute. "noop" skips all git operations — just closes the stream and ends the session.',
            },
            commit_message: {
              type: "string",
              description:
                'Commit message used when auto-committing any uncommitted in-flight work in the worktree before the merge. Required. Must describe the actual work in this stream — do NOT use placeholder/chore filler. Ignored for noop mode and on preview calls, but still required (write a short reason like "closing: <why>").',
            },
            base_branch: {
              type: "string",
              description:
                "Target branch to merge into. Supersedes the stream's recorded base_branch AND skips the preview step — passing this executes the merge directly. Omit it on the first call to get a preview; pass it on the confirming call to execute. Ignored in noop mode.",
            },
          },
          required: ["mode", "commit_message"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const { mode, commit_message, base_branch } = params as {
            mode: "merge" | "noop";
            commit_message: string;
            base_branch?: string;
          };
          if (!closeSwimlaneId) {
            return {
              content: [{ type: "text", text: "Error: close_swimlane is not bound to a stream" }],
              details: { ok: false },
            };
          }
          const managed = this.sessionManager.getByStream(closeSwimlaneId);
          const streamsSessId = managed?.piSessionId;
          if (!streamsSessId) {
            return {
              content: [{ type: "text", text: "Error: Orchestrator session not found" }],
              details: {},
            };
          }
          if (managed.closeRequested) {
            return {
              content: [{ type: "text", text: "Stream close is already in progress" }],
              details: { ok: false, streamId: closeSwimlaneId },
            };
          }
          managed.queue.freezeAdmission();
          try {
            const result = await executeCloseSwimlane(
              this.blackboard,
              closeSwimlaneId,
              mode,
              commit_message,
              base_branch,
            );
            if (result.ok) {
              this.sessionManager.requestStreamClose(closeSwimlaneId, streamsSessId, "tool");
            } else {
              managed.queue.restoreAdmission();
            }
            return { content: [{ type: "text", text: result.message }], details: result };
          } catch (error) {
            managed.queue.restoreAdmission();
            throw error;
          }
        },
      });
    }

    return tools;
  }

  private async sendWhatsAppCommand(command: DaemonCommand): Promise<DaemonResponse> {
    if (!this.whatsappEnabled) return { ok: false, status: "disabled" };
    try {
      const response = await sendDaemonCommand(command);
      if (response.daemon) {
        this.whatsappStatusCache = this.mapDaemonStatus(response.daemon);
      }
      return response;
    } catch {
      await this.startWhatsAppDaemon();
      const response = await sendDaemonCommand(command);
      if (response.daemon) {
        this.whatsappStatusCache = this.mapDaemonStatus(response.daemon);
      }
      return response;
    }
  }

  private getWhatsAppStatusSnapshot(): {
    status: ControlSurfaceWhatsAppStatus;
    pid?: number;
    managedByControlSurface: true;
    requiresManualAuth?: boolean;
  } {
    return this.whatsappStatusCache;
  }

  private mapDaemonStatus(daemon?: {
    status: ControlSurfaceWhatsAppStatus;
    pid?: number;
    requiresManualAuth?: boolean;
  }): {
    status: ControlSurfaceWhatsAppStatus;
    pid?: number;
    managedByControlSurface: true;
    requiresManualAuth?: boolean;
  } {
    if (!daemon) {
      return { status: "stopped", managedByControlSurface: true };
    }

    return {
      status: daemon.status,
      pid: daemon.pid,
      managedByControlSurface: true,
      requiresManualAuth: daemon.requiresManualAuth,
    };
  }

  private async refreshWhatsAppStatus(): Promise<void> {
    if (!this.whatsappEnabled) return;
    const prev = this.whatsappStatusCache.status;
    this.whatsappStatusCache = this.mapDaemonStatus(await getDaemonStatus());
    if (this.whatsappStatusCache.status !== prev) {
      this.broadcastStatusChanged("whatsapp");
    }
  }

  private watchWhatsAppStatusSignal(): void {
    this.unwatchWhatsAppStatusSignal();
    const signalPath = getWhatsAppStatusSignalPath();
    const dir = path.dirname(signalPath);
    const basename = path.basename(signalPath);
    try {
      this.whatsappStatusWatcher = fs.watch(dir, (_, filename) => {
        if (filename !== basename) return;
        void this.refreshWhatsAppStatus();
      });
      this.whatsappStatusWatcher.on("error", () => {
        this.unwatchWhatsAppStatusSignal();
      });
    } catch {}
  }

  private unwatchWhatsAppStatusSignal(): void {
    if (this.whatsappStatusWatcher) {
      this.whatsappStatusWatcher.close();
      this.whatsappStatusWatcher = undefined;
    }
  }

  private broadcastStatusChanged(subsystem: string): void {
    this.wsHub.broadcast({
      type: "status_changed",
      subsystem,
      timestamp: new Date().toISOString(),
    });
  }

  private async ensureWhatsAppDaemon(): Promise<void> {
    if (!this.whatsappEnabled) {
      this.log("whatsapp daemon disabled via WHATSAPP_ENABLED");
      return;
    }
    await this.refreshWhatsAppStatus();
    if (this.whatsappStatusCache.status !== "stopped") return;
    try {
      await this.startWhatsAppDaemon();
    } catch (error) {
      this.log(`whatsapp start skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startMaintenanceLoop(): void {
    this.maintenanceTimer = setInterval(async () => {
      try {
        pingBlackboard(this.blackboard);
        await this.refreshWhatsAppStatus();
        markStaleSessions(
          this.blackboard,
          this.config.stallMinutes,
          this.config.toolTimeoutMinutes,
        );
        const idleBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const oldSessions = findIdleCleanupCandidates(this.blackboard, idleBefore);
        for (const session of oldSessions) {
          if (session.tmuxSession) {
            try {
              await killTmuxSession(session.tmuxSession);
            } catch {}
          }
          markSessionEnded(this.blackboard, session.sessionId, "idle_timeout");
        }
        const defaultManaged = this.sessionManager.getDefault();
        const allManaged = [
          ...(defaultManaged ? [defaultManaged] : []),
          ...this.sessionManager.listStreamSessions(),
        ];
        for (const managed of allManaged) {
          const snapshot = managed.state.getSnapshot();
          if (snapshot.busy && snapshot.currentTurnStartedAt) {
            const age = Date.now() - Date.parse(snapshot.currentTurnStartedAt);
            if (age > this.config.toolTimeoutMinutes * 60_000) {
              const label = `${managed.role}${managed.streamId ? ` ws=${managed.streamId}` : ""}`;
              const ageSeconds = Math.round(age / 1000);
              this.log(`queue turn appears stuck for ${ageSeconds}s (${label})`);
              setHealthFlag(
                this.blackboard,
                "stuck_turn",
                `Turn stuck for ${ageSeconds}s (${label})`,
                30,
              );
              const targetUserId = managed.streamId
                ? whatsappUserIdFromStreamName(managed.streamName)
                : metadataString(snapshot.currentItem?.metadata, "whatsapp_user_id");
              const remoteJid = extractRemoteJid(snapshot.currentItem?.metadata);
              if (!targetUserId && !remoteJid) {
                this.log(`stuck-turn WhatsApp alert skipped: no WhatsApp reply target (${label})`);
                continue;
              }
              this.sendWhatsAppCommand({
                command: "send",
                text: `⚠️ Stuck turn detected: ${label} — stuck for ${Math.round(age / 60_000)}min. Cron paused via circuit breaker (30min TTL).`,
                contextRef: undefined,
                ...(targetUserId ? { targetUserId } : { remoteJid }),
              }).catch((err) => {
                this.log(
                  `stuck-turn WhatsApp alert failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            }
          }
        }
      } catch (error) {
        this.log(`maintenance error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 60_000);
  }

  private ensurePidFile(): void {
    const existingPid = readPid(this.config.controlSurfacePidPath);
    if (existingPid && isPidRunning(existingPid)) {
      throw new Error(`control surface already running with pid ${existingPid}`);
    }
    fs.mkdirSync(path.dirname(this.config.controlSurfacePidPath), { recursive: true });
    fs.writeFileSync(this.config.controlSurfacePidPath, `${process.pid}\n`, "utf8");
  }

  log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    fs.appendFileSync(this.config.controlSurfaceLogPath, `${line}\n`, "utf8");
  }

  private async handleWebSocketMessage(
    client: WebSocketClient,
    data: ControlSurfaceWebSocketClientEvent | unknown,
  ): Promise<void> {
    if (!data || typeof data !== "object") {
      console.warn("[ws] Dropping non-object WebSocket message (type=%s)", typeof data);
      return;
    }
    const payload = data as ControlSurfaceWebSocketClientEvent;
    if (payload.type === "ping") {
      this.wsHub.send(client.id, { type: "pong" });
      return;
    }
    if (payload.type === "subscribe" && typeof payload.piSessionId === "string") {
      this.wsHub.subscribeClient(
        client.id,
        payload.piSessionId,
        Array.isArray(payload.eventTypes) ? payload.eventTypes : undefined,
        payload.after,
      );
      return;
    }
    if (payload.type === "unsubscribe" && typeof payload.piSessionId === "string") {
      this.wsHub.unsubscribeClient(client.id, payload.piSessionId);
      return;
    }
    if (payload.type === "message" && typeof payload.text === "string") {
      const targetPiSessionId =
        typeof payload.targetPiSessionId === "string" ? payload.targetPiSessionId : undefined;

      const clientMessageId =
        typeof payload.clientMessageId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          payload.clientMessageId,
        )
          ? payload.clientMessageId
          : undefined;
      const serverMessageId = clientMessageId ?? crypto.randomUUID();
      let routerMeta: StreamRoutingMeta = {};
      if (targetPiSessionId) {
        routerMeta._targetSessionId = targetPiSessionId;
        const targetSession = this.sessionManager.getByPiSessionId(targetPiSessionId);
        if (targetSession?.streamId) {
          routerMeta.stream_id = targetSession.streamId;
          routerMeta.stream_name = targetSession.streamName ?? undefined;
        }
      } else {
        try {
          const { classifyMessage } = await import("./classifier/classify.ts");
          const { resolveGroqApiKey } = await import("./classifier/groq-client.ts");
          const apiKey = resolveGroqApiKey();
          if (!apiKey) throw new Error("No Groq API key available");
          const defaultPiSessionId = this.sessionManager.getDefault()?.piSessionId;
          const result = await classifyMessage(
            payload.text,
            this.blackboard,
            apiKey,
            defaultPiSessionId,
            loadWhatsAppConfig().defaultUser ?? undefined,
          );
          routerMeta = { router_action: result.action };
          if (result.stream) {
            routerMeta.stream_id = result.stream.id;
            routerMeta.stream_name = result.stream.name;
          }
        } catch (error) {
          this.log(
            `router classification failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      try {
        this.enqueue({
          text: payload.text,
          source: "web",
          metadata: { via: "ws", ...routerMeta },
          webClientId: client.id,
          images: Array.isArray(payload.images) ? payload.images : undefined,
          serverMessageId,
        });

        const MAX_USER_WA_LENGTH = 30_000;
        try {
          const wsLabel = routerMeta.stream_name ? `*[${routerMeta.stream_name}]* ` : "";
          const userText =
            payload.text.length > MAX_USER_WA_LENGTH
              ? `${payload.text.slice(0, MAX_USER_WA_LENGTH)}\n\n[...truncated — full message in web client]`
              : payload.text;
          await this.sendWhatsAppCommand({
            command: "send",
            text: `${wsLabel}*User (web):*\n---\n${userText}`,
            contextRef: undefined,
          });
        } catch (error) {
          this.log(
            `mirror web message to WhatsApp failed (len=${payload.text.length}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.log(`WS message enqueue failed for client ${client.id}: ${reason}`);
        this.wsHub.send(client.id, {
          type: "error",
          message: `Failed to deliver message — ${reason}`,
        });
      }
    }
  }
}

function extractFinalAssistantMessage(
  session: AgentSession,
): { text: string; messageId?: string } | undefined {
  if (!session.messages.length) return undefined;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg?.role !== "assistant") continue;
    const assistantMsg = msg as AssistantMessage;
    const messageId = assistantMsg.responseId?.trim() || undefined;
    const textParts = assistantMsg.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (textParts.trim()) return { text: textParts.trim(), messageId };
    return undefined;
  }
  return undefined;
}

function formatHookMessage(eventName: string, payload: Record<string, unknown>): string {
  const sessionId = pickString(payload, ["session_id", "sessionId"]);
  const cwd = pickString(payload, ["cwd"]);
  const transcript = pickString(payload, ["transcript_path", "transcriptPath"]);
  const tmuxSession = pickString(payload, [
    "tmux_session",
    "tmuxSession",
    "FLITTERBOT_TMUX_SESSION",
  ]);
  const project = pickString(payload, ["project", "project_label", "projectLabel"]);
  const reason = pickString(payload, ["reason", "stop_reason", "session_end_reason"]);
  const agentManaged =
    payload.agent_managed === true ||
    payload.agentManaged === true ||
    payload.agent_managed === 1 ||
    payload.agentManaged === 1;
  const lastAssistantText = pickString(payload, [
    "lastAssistantText",
    "last_assistant_message",
    "lastAssistantMessage",
  ]);
  const lines = [
    `${humanizeHookEvent(eventName)}: ${hookVerb(eventName, pickString(payload, ["harness"]))}`,
    sessionId ? `Session ID: ${sessionId}` : undefined,
    project ? `Project: ${project}` : undefined,
    cwd ? `CWD: ${cwd}` : undefined,
    transcript ? `Transcript: ${transcript}` : undefined,
    eventName === "session-start" ? `Agent managed: ${agentManaged ? "yes" : "no"}` : undefined,
    tmuxSession ? `Tmux session: ${tmuxSession}` : undefined,
    reason ? `Reason: ${reason}` : undefined,
    lastAssistantText ? `Last output: "${lastAssistantText}"` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

function metadataString(metadata: MessageMetadata | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function whatsappUserIdFromStreamName(streamName: string | null | undefined): string | undefined {
  const prefix = "flitterbot: ";
  return streamName?.startsWith(prefix) ? streamName.slice(prefix.length).trim() : undefined;
}

function extractRemoteJid(metadata?: MessageMetadata): string | undefined {
  return metadataString(metadata, "remote_jid");
}

function whatsappReplyMetadataFrom(item?: QueueItem): MessageMetadata {
  const remoteJid = extractRemoteJid(item?.metadata);
  const contextRef = metadataString(item?.metadata, "context_ref");
  return {
    ...(remoteJid ? { remote_jid: remoteJid } : {}),
    ...(contextRef ? { context_ref: contextRef } : {}),
  };
}

function pickString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function humanizeHookEvent(eventName: string): string {
  return eventName
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function hookVerb(eventName: string, harness?: string): string {
  const agentName = harness === "codex" ? "Codex" : "Claude Code";
  switch (eventName) {
    case "session-start":
      return `${agentName} session started.`;
    case "stop":
      return `${agentName} session stopped.`;
    case "session-end":
      return `${agentName} session ended.`;
    case "subagent-start":
      return `${agentName} subagent started.`;
    case "subagent-stop":
      return `${agentName} subagent stopped.`;
    default:
      return "Hook event received.";
  }
}

function readPid(pidPath: string): number | undefined {
  try {
    if (!fs.existsSync(pidPath)) return undefined;
    const value = Number(fs.readFileSync(pidPath, "utf8").trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
