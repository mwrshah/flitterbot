import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import type net from "node:net";
import path from "node:path";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { type BlackboardDatabase, openBlackboard, pingBlackboard } from "./blackboard/db.ts";
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
  getActivePiSessionId,
  getLatestPiSessionId,
  getPiSessionStatus,
  listOpenStreams,
  listRecentlyClosedStreams,
  resetAllStreams,
} from "./blackboard/query-streams.ts";
import {
  getLastDatetimeReportedAt,
  touchDatetimeReportedAt,
  touchPiPrompt,
  updatePiSessionStatus,
} from "./blackboard/pi-sessions.ts";
import { createQueryBlackboardTool } from "./blackboard/tool-query-blackboard.ts";
import { killTmuxSession } from "./claude-sessions/tmux.ts";
import { type AutonomaConfig, loadConfig } from "./config/load-config.ts";
import type {
  ClaudeHookPayload,
  ControlSurfaceWebSocketClientEvent,
  WhatsAppDaemonStatus as ControlSurfaceWhatsAppStatus,
  DaemonCommand,
  DaemonResponse,
  DeliveryMode,
  DirectSessionMessageResponse,
  HookResponse,
  MessageMetadata,
  RuntimeWhatsAppStartResponse,
  RuntimeWhatsAppStopResponse,
  ClaudeSessionListItem as SessionListItem,
  SessionTranscriptResponse,
  StatusResponse,
  StreamRoutingMeta,
} from "./contracts/index.ts";
import { executeCloseStream } from "./custom-tools/close-stream.ts";
import { executeCreateWorktree } from "./custom-tools/create-worktree.ts";
import { directSessionMessage } from "./custom-tools/manage-session.ts";
import { formatDatetimeBlock } from "./prompts/datetime.ts";
import { formatPromptWithContext } from "./streams/format-prompt.ts";
import { type ManagedPiSession, PiSessionManager } from "./streams/pi-session-manager.ts";
import type { QueueItem, QueueSource } from "./streams/turn-queue.ts";
import { readTranscriptPage } from "./transcript/transcript.ts";
import { sendDaemonCommand } from "./whatsapp/ipc.ts";
import { getWhatsAppStatusSignalPath } from "./whatsapp/paths.ts";
import {
  getDaemonStatus,
  startDaemonProcess,
  stopDaemonProcess,
  waitForDaemonReady,
} from "./whatsapp/process.ts";
import { type WebSocketClient, WebSocketHub } from "./ws/hub.ts";

/** Custom tool shape using plain JSON Schema (not TypeBox). Cast to ToolDefinition[] at the SDK boundary. */
type CustomToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    ...rest: unknown[]
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: unknown;
  }>;
};

type EnqueueInput = {
  text: string;
  source: QueueSource;
  metadata?: MessageMetadata;
  deliveryMode?: DeliveryMode;
  webClientId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  serverMessageId?: string;
};

const ACCEPTED_HOOK_EVENTS = new Set(["session-start", "stop", "session-end"]);

export class ControlSurfaceRuntime {
  readonly config: AutonomaConfig;
  readonly blackboard: BlackboardDatabase;
  readonly runtimeInstanceId = crypto.randomUUID();
  readonly startedAt = Date.now();
  readonly wsHub: WebSocketHub;
  readonly sessionManager: PiSessionManager;
  server?: http.Server;
  private stopping = false;
  private maintenanceTimer?: NodeJS.Timeout;
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

  constructor(config: AutonomaConfig = loadConfig()) {
    this.config = config;
    if (!config.whatsappEnabled) {
      this.whatsappStatusCache = { status: "disabled", managedByControlSurface: true };
    }
    this.blackboard = openBlackboard(config.blackboardPath);
    this.wsHub = new WebSocketHub(this.handleWebSocketMessage.bind(this));
    this.sessionManager = new PiSessionManager(
      config,
      this.blackboard,
      this.wsHub,
      this.runtimeInstanceId,
      this.startedAt,
      this.processQueueItem.bind(this),
      this.log.bind(this),
    );
  }

  attachServer(server: http.Server): void {
    this.server = server;
  }

  async start(): Promise<void> {
    this.ensurePidFile();

    if (this.config.wipeStreamsOnStart) {
      const closed = resetAllStreams(this.blackboard);
      if (closed > 0)
        this.log(`wiped ${closed} open stream(s) on startup (wipeStreamsOnStart=true)`);
    }

    await this.sessionManager.createDefault(this.createCustomTools("default"));

    // Rehydrate dormant orchestrators for open streams from the pi sessions DB.
    // No live SDK agent is created — just the in-memory maps are populated so that
    // message lookups find the correct piSessionId. The agent is lazily activated
    // when the first new message arrives for the stream.
    const openStreams = listOpenStreams(this.blackboard);
    for (const ws of openStreams) {
      const streamsRow = this.blackboard.get<{
        pi_session_id: string;
        session_file: string | null;
        started_at: string;
        model_provider: string | null;
        model_id: string | null;
      }>(
        `SELECT pi_session_id, session_file, started_at, model_provider, model_id
         FROM pi_sessions
         WHERE stream_id = ? AND role = 'orchestrator'
           AND status NOT IN ('ended', 'crashed')
         ORDER BY started_at DESC LIMIT 1`,
        ws.id,
      );

      if (streamsRow) {
        this.sessionManager.rehydrateOrchestrator(
          ws.id,
          ws.name,
          streamsRow.pi_session_id,
          streamsRow.session_file,
          streamsRow.started_at,
          streamsRow.model_provider,
          streamsRow.model_id,
        );
      } else {
        // No surviving pi session row — create a fresh orchestrator
        await this.sessionManager.createOrchestrator(
          ws.id,
          ws.name,
          ws.repo_path ?? undefined,
          this.createCustomTools("orchestrator", ws.id),
        );
      }
    }
    if (openStreams.length > 0) {
      this.log(`rehydrated ${openStreams.length} orchestrator(s) for open streams`);
    }

    await this.ensureWhatsAppDaemon();
    await this.refreshWhatsAppStatus();
    this.watchWhatsAppStatusSignal();
    this.startMaintenanceLoop();
    clearAllHealthFlags(this.blackboard);
    this.log(
      `runtime started on ${this.config.controlSurfaceHost}:${this.config.controlSurfacePort}`,
    );

    // Bootstrap default pi session with startup skills
    this.enqueue({
      text: "/load2-w",
      source: "init",
      metadata: { via: "startup" },
    });
  }

  async stop(reason: string = "shutdown", _crash: boolean = false): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`runtime stopping: ${reason}`);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.unwatchWhatsAppStatusSignal();
    this.sessionManager.disposeAll();
    try {
      await this.stopWhatsAppDaemon();
      await this.refreshWhatsAppStatus();
    } catch {
      // ignore
    }
    try {
      this.wsHub.closeAll();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    try {
      if (fs.existsSync(this.config.controlSurfacePidPath))
        fs.unlinkSync(this.config.controlSurfacePidPath);
    } catch {
      // ignore
    }
    this.blackboard.close();
  }

  /**
   * Route a message to the correct pi session's queue based on classification metadata.
   */
  enqueue(input: EnqueueInput): { ok: true; item: QueueItem } {
    const images = input.images?.map((img) => ({
      type: "image" as const,
      data: img.data,
      mimeType: img.mimeType,
    }));
    // Use pre-generated serverMessageId if provided (e.g. from WS handler), else generate one
    const messageUuid = input.serverMessageId ?? crypto.randomUUID();
    const item: QueueItem = {
      id: crypto.randomUUID(),
      source: input.source,
      text: input.text,
      metadata: input.metadata,
      receivedAt: new Date().toISOString(),
      webClientId: input.webClientId,
      deliveryMode: input.deliveryMode ?? "followUp",
      images: images?.length ? images : undefined,
      serverMessageId: messageUuid,
    };

    try {
      const source = item.source as "whatsapp" | "web" | "cron";
      const streamId = (input.metadata?.stream_id as string) ?? undefined;
      const targetSessionId = (input.metadata?._targetSessionId as string) ?? undefined;
      const piSessionId = targetSessionId
        ? targetSessionId
        : streamId
          ? this.sessionManager.getByStream(streamId)?.piSessionId
          : this.sessionManager.getDefault()?.piSessionId;
      persistInboundMessage(this.blackboard, {
        id: messageUuid,
        source,
        content: input.text,
        sender: "user",
        streamId,
        piSessionId: piSessionId,
        metadata: input.metadata,
      });
    } catch (error) {
      this.log(`message persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Route to the correct session's queue
    const target = this.resolveTargetSession(input, item);
    if (!target) {
      throw new Error("No target session available");
    }

    // Datetime injection: append current date+time context to user messages when >= 1 hour
    // has elapsed since we last told this pi session what time it is. Injecting via turns
    // (not the system prompt) keeps the system prompt stable and cache-friendly.
    if (item.source === "web" || item.source === "whatsapp") {
      item.text = this.maybeInjectDatetime(target.piSessionId, item.text);
    }

    // Steer bypass: if the queue is busy, deliver directly via session.prompt() with
    // streamingBehavior: "steer". The SDK handles both streaming and non-streaming states.
    // Skip for dormant sessions (no live SDK agent) — the message will go through the queue
    // and trigger lazy activation instead.
    if (item.deliveryMode === "steer" && target.queue.isBusy() && target.session) {
      this.log(`steer bypass: delivering ${item.id} directly to ${target.role} (queue busy)`);
      void target.session.prompt(formatPromptWithContext(item), {
        streamingBehavior: "steer",
        images: item.images,
      });
      return { ok: true, item };
    }

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

    // Check if this session belongs to any of our pi sessions
    const isOwnPiSession = this.sessionManager.getByPiSessionId(sessionId) !== undefined;

    if (normalized === "session-start") {
      const agentManaged = payload.agent_managed === true || payload.agent_managed === 1;
      if (!agentManaged && !isOwnPiSession) {
        return { ok: true, filtered: true };
      }
      const cwd = pickString(payload, ["cwd"]);
      let piSessionIdValue = pickString(payload, [
        "pi_session_id",
        "piSessionId",
        "AUTONOMA_PI_SESSION_ID",
      ]);
      let streamIdValue = pickString(payload, ["stream_id", "streamId", "AUTONOMA_STREAM_ID"]);
      if (cwd && !piSessionIdValue && !streamIdValue) {
        const openStreams = listOpenStreams(this.blackboard);
        const matchingStream = openStreams.find(
          (ws) => ws.worktree_path && cwd.startsWith(ws.worktree_path),
        );
        if (matchingStream) {
          const orchestrator = this.sessionManager.getByStream(matchingStream.id);
          if (orchestrator) {
            piSessionIdValue = orchestrator.piSessionId;
            streamIdValue = matchingStream.id;
          }
        }
      }
      insertSession(this.blackboard, {
        session_id: sessionId,
        cwd,
        model: pickString(payload, ["model"]),
        permission_mode: pickString(payload, ["permission_mode", "permissionMode"]),
        source: pickString(payload, ["source"]),
        transcript_path: pickString(payload, ["transcript_path", "transcriptPath"]),
        agent_managed: agentManaged,
        tmux_session: pickString(payload, ["tmux_session", "tmuxSession", "AUTONOMA_TMUX_SESSION"]),
        task_description: pickString(payload, [
          "task_description",
          "taskDescription",
          "AUTONOMA_TASK_DESCRIPTION",
        ]),
        todoist_task_id: pickString(payload, [
          "todoist_task_id",
          "todoistTaskId",
          "AUTONOMA_TODOIST_TASK_ID",
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

    // Use Claude Code's native last_assistant_message from the stop hook payload
    const lastAssistantText = pickString(payload, [
      "last_assistant_message",
      "lastAssistantMessage",
    ]);
    if (lastAssistantText) {
      payload.lastAssistantText = lastAssistantText;
    }

    // Route stop event to the pi session that owns this CC session
    const piSessionIdFromPayload = pickString(payload, [
      "pi_session_id",
      "piSessionId",
      "AUTONOMA_PI_SESSION_ID",
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
      text,
      metadata: { event: normalized, ...payload },
      receivedAt: new Date().toISOString(),
      deliveryMode: "followUp",
      streamId: targetQueue.streamId ?? undefined,
      streamName: targetQueue.streamName ?? undefined,
    };

    // Persist inbound
    try {
      persistInboundMessage(this.blackboard, {
        source: "hook",
        content: text,
        sender: "system",
        streamId: targetQueue.streamId ?? undefined,
        piSessionId: targetQueue.piSessionId,
        metadata: { event: normalized, ...payload },
      });
    } catch (error) {
      this.log(`message persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    targetQueue.queue.enqueue(hookItem);
    this.log(
      `hook stop: session_id=${sessionId} → ${targetQueue.role}${targetQueue.streamId ? ` ws=${targetQueue.streamId}` : ""} (via ${resolvedVia})`,
    );
    return { ok: true };
  }

  getStatus(): StatusResponse {
    const def = this.sessionManager.getDefault();
    const defSnapshot = def?.state.getSnapshot();
    const whatsapp = this.getWhatsAppStatusSnapshot();
    const blackboardStatus = pingBlackboard(this.blackboard) ? "ok" : "error";

    const orchestratorStatuses = this.sessionManager.listOrchestrators().map((o) => {
      const snap = o.state.getSnapshot();
      return {
        piSessionId: o.piSessionId,
        streamId: o.streamId!,
        streamName: o.streamName,
        messageCount: o.session?.messages?.length ?? snap.messageCount,
        busy: snap.busy,
      };
    });

    const openStreams = listOpenStreams(this.blackboard);
    const closedStreams = listRecentlyClosedStreams(this.blackboard, 24);
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
              messageCount: def!.session?.messages?.length ?? defSnapshot.messageCount,
              lastPromptAt: defSnapshot.lastPromptAt ?? null,
              busy: defSnapshot.busy,
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
      streams: [
        ...openStreams.map((ws) => {
          const piSessionId = getActivePiSessionId(this.blackboard, ws.id);
          return {
            id: ws.id,
            name: ws.name,
            status: "open" as const,
            repoPath: ws.repo_path ?? undefined,
            worktreePath: ws.worktree_path ?? undefined,
            piSessionId,
            piSessionStatus: piSessionId
              ? getPiSessionStatus(this.blackboard, piSessionId)
              : undefined,
            sessionCount: sessionCountByStream.get(ws.id) ?? 0,
            createdAt: ws.created_at,
          };
        }),
        ...closedStreams.map((ws) => {
          const piSessionId = getLatestPiSessionId(this.blackboard, ws.id);
          return {
            id: ws.id,
            name: ws.name,
            status: "closed" as const,
            closedAt: ws.closed_at ?? undefined,
            repoPath: ws.repo_path ?? undefined,
            worktreePath: ws.worktree_path ?? undefined,
            piSessionId,
            piSessionStatus: piSessionId
              ? getPiSessionStatus(this.blackboard, piSessionId)
              : undefined,
            sessionCount: sessionCountByStream.get(ws.id) ?? 0,
            createdAt: ws.created_at,
          };
        }),
      ],
    };
  }

  getSessionList(): SessionListItem[] {
    return listSessions(this.blackboard);
  }

  async getTranscript(
    sessionId: string,
    cursor?: string,
    limit: number = 50,
  ): Promise<SessionTranscriptResponse> {
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

  async startWhatsAppDaemon(): Promise<RuntimeWhatsAppStartResponse> {
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

  async stopWhatsAppDaemon(): Promise<RuntimeWhatsAppStopResponse> {
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

  private static readonly DATETIME_INJECTION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  /**
   * Append a datetime context block to `text` if >= 1 hour has elapsed since the last
   * injection for this pi session, then update the timestamp in SQLite.
   */
  private maybeInjectDatetime(piSessionId: string, text: string): string {
    const lastReportedAt = getLastDatetimeReportedAt(this.blackboard, piSessionId);
    const now = Date.now();
    const lastMs = lastReportedAt ? new Date(lastReportedAt).getTime() : 0;
    if (now - lastMs < ControlSurfaceRuntime.DATETIME_INJECTION_INTERVAL_MS) {
      return text;
    }

    const nowIso = new Date(now).toISOString();
    touchDatetimeReportedAt(this.blackboard, piSessionId, nowIso);

    return `${formatDatetimeBlock()}\n${text}`;
  }

  /**
   * Resolve which ManagedPiSession should handle this message.
   * May lazily create an orchestrator if needed.
   */
  private resolveTargetSession(
    input: EnqueueInput,
    _item: QueueItem,
  ): ManagedPiSession | undefined {
    const meta = input.metadata;

    // Direct-targeted session (web UI tab input) — bypass all routing
    const targetSessionId = meta?._targetSessionId as string | undefined;
    if (targetSessionId) {
      const target = this.sessionManager.getByPiSessionId(targetSessionId);
      if (target) return target;
    }

    // Cron always goes to default
    if (input.source === "cron") {
      return this.sessionManager.getDefault();
    }

    // Router matched an existing stream — route to its orchestrator if running
    const streamId = meta?.stream_id as string | undefined;
    if (streamId && meta?.router_action === "matched") {
      const existing = this.sessionManager.getByStream(streamId);
      if (existing) return existing;
    }

    // Everything else goes to the default agent (which can create streams via tool)
    return this.sessionManager.getDefault();
  }

  /**
   * Per-session queue processing callback.
   */
  private async processQueueItem(managed: ManagedPiSession, item: QueueItem): Promise<void> {
    // Lazily activate dormant orchestrators on first message after restart
    if (!managed.session && managed.role === "orchestrator" && managed.streamId) {
      this.log(`activating dormant orchestrator for stream ${managed.streamId}`);
      await this.sessionManager.activateOrchestrator(
        managed,
        this.createCustomTools("orchestrator", managed.streamId),
      );
    }

    const session = managed.session;
    if (!session) throw new Error("pi session not initialized");

    const piSessionId = session.sessionId;

    this.log(
      `processing queue item ${item.id} source=${item.source} role=${managed.role}${managed.streamId ? ` ws=${managed.streamId}` : ""} text=${item.text.slice(0, 80)}...`,
    );

    // Turn starts → set streams status to 'active'
    const promptAt = managed.state.notePrompt(session.messages.length);
    touchPiPrompt(this.blackboard, piSessionId, promptAt, "active");
    this.broadcastStatusChanged("pi_session");

    const promptText = formatPromptWithContext(item);

    if (session.isStreaming) {
      await session.prompt(promptText, {
        streamingBehavior: item.deliveryMode ?? "followUp",
        images: item.images,
      });
    } else {
      await session.prompt(promptText, { images: item.images });
    }

    // Stamp the user message in the SDK's messages array with the server UUID
    // so the history API returns IDs matching WS events (prevents duplicate rendering).
    // The SDK user message has no `id` field, so history.ts falls back to `memory-N` —
    // a positional ID that differs from the server UUID used in WS message_end events.
    const serverMsgId = item.metadata?.serverMessageId as string | undefined;
    if (serverMsgId) {
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const msg = session.messages[i] as Record<string, unknown> | undefined;
        if (msg?.role === "user") {
          msg.id = serverMsgId;
          break;
        }
      }
    }

    this.log(`queue item ${item.id} prompt completed, messages=${session.messages.length}`);

    // Check for API errors
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

    // Turn ends → transition state
    this.transitionStreamsAfterTurn(piSessionId);

    // Auto-surface final assistant message
    const finalAssistant = extractFinalAssistantMessage(session);
    if (finalAssistant) {
      const { text: finalText, messageId: finalMessageId } = finalAssistant;

      // Persist outbound with resolved server UUID (when available)
      try {
        const streamId = managed.streamId ?? (item.metadata?.stream_id as string) ?? undefined;
        persistOutboundMessage(this.blackboard, {
          id: finalMessageId,
          source: "stream_outbound",
          content: finalText,
          streamId,
          piSessionId: managed.piSessionId,
        });
      } catch (error) {
        this.log(
          `outbound message persist failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Surface with stream label for orchestrators
      const surfaceText =
        managed.role === "orchestrator" && managed.streamName
          ? `[${managed.streamName}] ${finalText}`
          : finalText;

      try {
        await this.sendWhatsAppCommand({
          command: "send",
          text: `*B-bot:*\n---\n${surfaceText}`,
          contextRef: undefined,
        });
      } catch (error) {
        this.log(
          `auto-surface to WhatsApp failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // If orchestrator just ran close_stream, destroy it
    if (managed.role === "orchestrator" && managed.streamId) {
      const closedStream = this.detectCloseStream(session);
      if (closedStream) {
        this.sessionManager.destroyOrchestrator(managed.streamId, "close_stream");
      }
    }
  }

  /**
   * After a pi session turn ends, check managed downstream sessions to determine next state.
   */
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

  /**
   * Detect if the last tool call was close_stream (orchestrator self-destruct).
   */
  private detectCloseStream(session: AgentSession): boolean {
    const messages = session.messages;
    if (!messages.length) return false;
    // Look at recent messages for a close_stream tool result
    for (let i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
      const msg = messages[i];
      if (!msg) continue;
      if (msg.role === "toolResult") {
        const toolResult = msg as ToolResultMessage;
        if (toolResult.toolName === "close_stream") {
          return true;
        }
      }
      // Also check content array for tool_use blocks
      if (msg.role === "assistant") {
        const assistantMsg = msg as AssistantMessage;
        for (const block of assistantMsg.content) {
          if (block.type === "toolCall" && block.name === "close_stream") {
            return true;
          }
        }
      }
    }
    return false;
  }

  async reopenStream(streamId: string): Promise<{ ok: boolean; streamId: string }> {
    const { reopenStream, getStreamById } = await import("./blackboard/query-streams.ts");

    const ws = getStreamById(this.blackboard, streamId);
    if (!ws) throw new Error("Stream not found");
    if (ws.status !== "closed") throw new Error("Stream is not closed");

    // 1. Reopen the stream and clear stale worktree_path
    reopenStream(this.blackboard, streamId);
    this.blackboard.prepare(`UPDATE streams SET worktree_path = NULL WHERE id = ?`).run(streamId);

    // 2. Revive the pi session: clear ended_at/end_reason, set status back to waiting_for_user
    const streamsRow = this.blackboard.get<{
      pi_session_id: string;
      session_file: string | null;
      started_at: string;
      model_provider: string | null;
      model_id: string | null;
    }>(
      `SELECT pi_session_id, session_file, started_at, model_provider, model_id
       FROM pi_sessions
       WHERE stream_id = ? AND role = 'orchestrator'
       ORDER BY started_at DESC LIMIT 1`,
      streamId,
    );

    if (streamsRow) {
      this.blackboard
        .prepare(
          `UPDATE pi_sessions
           SET status = 'waiting_for_user',
               ended_at = NULL,
               end_reason = NULL,
               last_event_at = ?
           WHERE pi_session_id = ?`,
        )
        .run(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), streamsRow.pi_session_id);

      // 3. Rehydrate the orchestrator in-memory
      this.sessionManager.rehydrateOrchestrator(
        streamId,
        ws.name,
        streamsRow.pi_session_id,
        streamsRow.session_file,
        streamsRow.started_at,
        streamsRow.model_provider,
        streamsRow.model_id,
      );
    }

    // 4. Broadcast so frontend updates
    this.wsHub.broadcast({
      type: "streams_changed",
      reason: "reopened",
      streamId,
      streamName: ws.name,
    });

    this.log(`reopened stream "${ws.name}" (${streamId})`);
    return { ok: true, streamId };
  }

  createCustomTools(
    role: "orchestrator" | "default" = "default",
    streamId?: string,
  ): CustomToolDefinition[] {
    const tools: CustomToolDefinition[] = [
      createQueryBlackboardTool(this.blackboard),
      {
        name: "reload_resources",
        label: "Reload Resources",
        description:
          "Reload skills, extensions, prompts, context files, and system prompt. Use after skills or AGENTS.md files have been added or changed on disk.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          // Reload the session that owns this tool — find by role/stream
          const managed = streamId
            ? this.sessionManager.getByStream(streamId)
            : this.sessionManager.getDefault();
          if (!managed?.session) {
            return {
              content: [{ type: "text", text: "Error: pi session not initialized" }],
              details: {},
            };
          }
          await managed.session.reload();
          return {
            content: [
              {
                type: "text",
                text: "Resources reloaded. Skills, extensions, prompts, context files, and system prompt have been refreshed.",
              },
            ],
            details: { reloadedAt: new Date().toISOString() },
          };
        },
      },
    ];

    if (role === "default") {
      tools.push({
        name: "create_stream",
        label: "Create Stream",
        description:
          "Create a new stream and spawn a dedicated orchestrator for it. Use when the user requests engineering work (features, bugs, investigations) that needs a dedicated session. The user's original message is automatically passed through to the new stream.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Short descriptive name, 2-5 words, lowercase, dash-separated (e.g. 'fix-auth-token-refresh')",
            },
            message: {
              type: "string",
              description:
                "Optional agent-authored context appended to the stream prompt. Use for supplementary information the orchestrator wouldn't otherwise have: spec paths, constraints, relevant background gathered during triage. Omit if there's nothing to add.",
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const { name, message: agentMessage } = params as { name: string; message?: string };
          const { insertStream } = await import("./blackboard/query-streams.ts");
          const ws = insertStream(this.blackboard, name);
          this.log(`default agent created stream "${name}" (${ws.id})`);

          try {
            const orchestrator = await this.sessionManager.createOrchestrator(
              ws.id,
              ws.name,
              undefined,
              this.createCustomTools("orchestrator", ws.id),
            );

            this.wsHub.broadcast({
              type: "streams_changed",
              reason: "created",
              streamId: ws.id,
              streamName: ws.name,
            });

            // Pass through relevant context messages to the new stream
            const defaultSession = this.sessionManager.getDefault();
            const originalText = defaultSession?.queue.getCurrentItem()?.text;

            if (originalText) {
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

                if (apiKey && recentMessages.length > 1) {
                  const relevance = await classifyContextRelevance(recentMessages, ws.name, apiKey);
                  const relevantTexts = recentMessages
                    .filter((_, i) => relevance[i])
                    .map((m) => m.content);

                  if (relevantTexts.length > 1) {
                    // Ensure the current message is included (it may not be persisted yet)
                    if (!relevantTexts.includes(originalText)) {
                      relevantTexts.push(originalText);
                    }
                    prompt = formatStreamPrompt(relevantTexts, ws.name, ws.id, agentMessage);
                    this.log(
                      `context classifier: ${relevantTexts.length}/${recentMessages.length} messages relevant for "${ws.name}"`,
                    );
                  } else {
                    prompt = this.sessionManager.buildStreamPrompt(
                      originalText,
                      ws.name,
                      ws.id,
                      agentMessage,
                    );
                  }
                } else {
                  prompt = this.sessionManager.buildStreamPrompt(
                    originalText,
                    ws.name,
                    ws.id,
                    agentMessage,
                  );
                }
              } catch (error) {
                this.log(
                  `context classifier failed, falling back to single message: ${error instanceof Error ? error.message : String(error)}`,
                );
                this.wsHub.broadcast({
                  type: "error",
                  message:
                    "Context classification failed — stream context limited to current message.",
                });
                prompt = this.sessionManager.buildStreamPrompt(
                  originalText,
                  ws.name,
                  ws.id,
                  agentMessage,
                );
              }

              orchestrator.queue.enqueue({
                id: `ws-init-${ws.id}`,
                text: prompt,
                source: "web",
                metadata: {
                  stream_id: ws.id,
                  stream_name: ws.name,
                },
                receivedAt: new Date().toISOString(),
              });
              this.log(`enqueued original user message onto stream "${ws.name}" (${ws.id})`);
            }

            return {
              content: [
                {
                  type: "text",
                  text: `Stream "${ws.name}" created (ID: ${ws.id}). Orchestrator spawned${originalText ? " and user message passed through" : ""}.`,
                },
              ],
              details: { streamId: ws.id, streamName: ws.name },
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Stream "${ws.name}" created (ID: ${ws.id}) but orchestrator failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              details: { streamId: ws.id, error: true },
            };
          }
        },
      });

      tools.push({
        name: "enqueue_message",
        label: "Enqueue Message",
        description:
          "Send a message to an existing orchestrator running on an open stream. Use to forward user follow-ups, delegate context, or nudge an orchestrator. Does NOT create a stream or spawn an orchestrator — use create_stream for that.",
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
            orchestrator.queue.enqueue({
              id: `enq-msg-${crypto.randomUUID()}`,
              text: message,
              source: "agent",
              metadata: {
                stream_id: ws.id,
                stream_name: ws.name,
              },
              receivedAt: new Date().toISOString(),
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

          try {
            persistInboundMessage(this.blackboard, {
              source: "agent",
              content: message,
              sender: "system",
              streamId: ws.id,
              piSessionId: this.sessionManager.getByStream(ws.id)?.piSessionId,
              metadata: {
                stream_id: ws.id,
                stream_name: ws.name,
                enqueued_by: "enqueue_message_tool",
              },
            });
          } catch (error) {
            this.log(
              `enqueue_message persist failed: ${error instanceof Error ? error.message : String(error)}`,
            );
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
        name: "create_worktree",
        label: "Create Git Worktree",
        description:
          "Create an isolated git worktree for a stream. Sets up a new branch from origin/main and records the paths on the stream.",
        parameters: {
          type: "object",
          properties: {
            stream_id: { type: "string", description: "ID of the stream" },
            repo_path: { type: "string", description: "Absolute path to the project repository" },
            branch_name: {
              type: "string",
              description: "Branch name (optional, defaults to NNN-<slug>)",
            },
            update_repo_path: {
              type: "string",
              description:
                "Update only the repo_path field without creating a worktree. Skips all git operations.",
            },
            update_worktree_path: {
              type: "string",
              description:
                "Update only the worktree_path field without creating a worktree. Skips all git operations.",
            },
          },
          required: ["stream_id", "repo_path"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const { stream_id, repo_path, branch_name, update_repo_path, update_worktree_path } =
            params as {
              stream_id: string;
              repo_path: string;
              branch_name?: string;
              update_repo_path?: string;
              update_worktree_path?: string;
            };
          const result = await executeCreateWorktree(
            this.blackboard,
            stream_id,
            repo_path,
            branch_name,
            update_repo_path,
            update_worktree_path,
          );
          if (result.ok) {
            const worktreePiSessionId =
              this.sessionManager.getByStream(stream_id)?.piSessionId;
            if (worktreePiSessionId) {
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

      const closeStreamId = streamId;
      tools.push({
        name: "close_stream",
        label: "Close Stream",
        description:
          'Close the current stream. Mode is required: "merge" merges branch into main, pushes, and closes. "noop" skips all git operations and just closes the stream record. Only call when the human explicitly confirms the work is done.',
        parameters: {
          type: "object",
          properties: {
            stream_id: { type: "string", description: "ID of the stream to close" },
            mode: {
              type: "string",
              enum: ["merge", "noop"],
              description:
                '"merge" commits uncommitted changes, merges branch to main, and pushes. "noop" skips all git operations — just closes the stream and ends the session.',
            },
          },
          required: ["stream_id", "mode"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const { stream_id, mode } = params as {
            stream_id: string;
            mode: "merge" | "noop";
          };
          const managed = closeStreamId
            ? this.sessionManager.getByStream(closeStreamId)
            : undefined;
          const streamsSessId = managed?.piSessionId;
          if (!streamsSessId) {
            return {
              content: [{ type: "text", text: "Error: Orchestrator session not found" }],
              details: {},
            };
          }
          const result = await executeCloseStream(this.blackboard, streamsSessId, stream_id, mode);
          if (result.ok) {
            this.wsHub.broadcast({
              type: "streams_changed",
              reason: "closed",
              streamId: stream_id,
            });
          }
          return { content: [{ type: "text", text: result.message }], details: result };
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
        // directory may not exist yet — watcher will be retried on next daemon start
        this.unwatchWhatsAppStatusSignal();
      });
    } catch {
      // directory doesn't exist yet — will be created when daemon starts
    }
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
            } catch {
              // ignore
            }
          }
          markSessionEnded(this.blackboard, session.sessionId, "idle_timeout");
        }
        // Check all active sessions for stuck turns
        const defaultManaged = this.sessionManager.getDefault();
        const allManaged = [
          ...(defaultManaged ? [defaultManaged] : []),
          ...this.sessionManager.listOrchestrators(),
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
              this.sendWhatsAppCommand({
                command: "send",
                text: `⚠️ Stuck turn detected: ${label} — stuck for ${Math.round(age / 60_000)}min. Cron paused via circuit breaker (30min TTL).`,
                contextRef: undefined,
              }).catch(() => {});
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
    if (!data || typeof data !== "object") return;
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

      // Generate server message ID immediately and ACK the client before classification
      const serverMessageId = crypto.randomUUID();
      // TEMPORARILY DISABLED — message_ack ws event
      // this.wsHub.send(client.id, {
      //   type: "message_ack",
      //   serverMessageId,
      //   text: payload.text,
      //   source: "web",
      // });

      // Skip router when message targets a specific pi session (direct tab input)
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

      this.enqueue({
        text: payload.text,
        source: "web",
        metadata: { via: "ws", ...routerMeta },
        webClientId: client.id,
        deliveryMode: payload.deliveryMode === "steer" ? "steer" : "followUp",
        images: Array.isArray(payload.images) ? payload.images : undefined,
        serverMessageId,
      });

      // Mirror web user message to WhatsApp for complete conversation record
      try {
        const wsLabel = routerMeta.stream_name ? `[${routerMeta.stream_name}] ` : "";
        await this.sendWhatsAppCommand({
          command: "send",
          text: `${wsLabel}*User (web):*\n---\n${payload.text}`,
          contextRef: undefined,
        });
      } catch (error) {
        this.log(
          `mirror web message to WhatsApp failed: ${error instanceof Error ? error.message : String(error)}`,
        );
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
    if (!msg || msg.role !== "assistant") continue;
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
  const tmuxSession = pickString(payload, ["tmux_session", "tmuxSession", "AUTONOMA_TMUX_SESSION"]);
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
    `${humanizeHookEvent(eventName)}: ${hookVerb(eventName)}`,
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

function hookVerb(eventName: string): string {
  switch (eventName) {
    case "session-start":
      return "Claude Code session started.";
    case "stop":
      return "Claude Code session stopped.";
    case "session-end":
      return "Claude Code session ended.";
    case "subagent-start":
      return "Claude subagent started.";
    case "subagent-stop":
      return "Claude subagent stopped.";
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
