import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import type net from "node:net";
import path from "node:path";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import {
  type BlackboardDatabase,
  openBlackboard,
  pingBlackboard,
  resolveServerId,
} from "./blackboard/db.ts";
import { touchPiPrompt, updatePiSessionStatus } from "./blackboard/pi-sessions.ts";
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
  listOpenWorkstreams,
  listRecentlyClosedWorkstreams,
  resetAllWorkstreams,
} from "./blackboard/query-workstreams.ts";
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
  WorkstreamRoutingMeta,
} from "./contracts/index.ts";
import { executeCloseWorkstream } from "./custom-tools/close-workstream.ts";
import { executeCreateWorktree } from "./custom-tools/create-worktree.ts";
import { directSessionMessage } from "./custom-tools/manage-session.ts";
import { formatPromptWithContext } from "./pi/format-prompt.ts";
import { type ManagedPiSession, PiSessionManager } from "./pi/session-manager.ts";
import type { QueueItem, QueueSource } from "./pi/turn-queue.ts";
import { extractLastAssistantText } from "./transcript/reader.ts";
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

    if (this.config.wipeWorkstreamsOnStart) {
      const closed = resetAllWorkstreams(this.blackboard);
      if (closed > 0)
        this.log(`wiped ${closed} open workstream(s) on startup (wipeWorkstreamsOnStart=true)`);
    }

    await this.sessionManager.createDefault(this.createCustomTools("default"));

    // Rehydrate orchestrator sessions for open workstreams persisted in SQLite
    const openWorkstreams = listOpenWorkstreams(this.blackboard);
    for (const ws of openWorkstreams) {
      await this.sessionManager.createOrchestrator(
        ws.id,
        ws.name,
        ws.repo_path ?? undefined,
        this.createCustomTools("orchestrator", ws.id),
      );
    }
    if (openWorkstreams.length > 0) {
      this.log(`rehydrated ${openWorkstreams.length} orchestrator(s) for open workstreams`);
    }

    await this.ensureWhatsAppDaemon();
    await this.refreshWhatsAppStatus();
    this.watchWhatsAppStatusSignal();
    this.startMaintenanceLoop();
    clearAllHealthFlags(this.blackboard);
    this.log(
      `runtime started on ${this.config.controlSurfaceHost}:${this.config.controlSurfacePort}`,
    );

    // Bootstrap Pi agent with startup skills
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
   * Route a message to the correct Pi session's queue based on classification metadata.
   */
  enqueue(input: EnqueueInput): { ok: true; item: QueueItem } {
    const images = input.images?.map((img) => ({
      type: "image" as const,
      data: img.data,
      mimeType: img.mimeType,
    }));
    const item: QueueItem = {
      id: crypto.randomUUID(),
      source: input.source,
      text: input.text,
      metadata: input.metadata,
      receivedAt: new Date().toISOString(),
      webClientId: input.webClientId,
      deliveryMode: input.deliveryMode ?? "followUp",
      images: images?.length ? images : undefined,
    };

    // Generate server UUID for this message and persist
    const messageUuid = crypto.randomUUID();
    item.metadata = { ...item.metadata, serverMessageId: messageUuid };
    try {
      const source = item.source as "whatsapp" | "web" | "hook" | "cron";
      const workstreamId = (input.metadata?.workstream_id as string) ?? undefined;
      persistInboundMessage(this.blackboard, {
        id: messageUuid,
        source,
        content: input.text,
        sender: source === "hook" ? "system" : "user",
        workstreamId,
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

    // Steer bypass: if the queue is busy, deliver directly via session.prompt() with
    // streamingBehavior: "steer". The Pi SDK handles both streaming and non-streaming states.
    if (item.deliveryMode === "steer" && target.queue.isBusy()) {
      this.log(`steer bypass: delivering ${item.id} directly to ${target.role} (queue busy)`);
      void target.session.prompt(formatPromptWithContext(item), {
        streamingBehavior: "steer",
        images: item.images,
      });
      return { ok: true, item };
    }

    item.workstreamId = target.workstreamId ?? undefined;
    item.workstreamName = target.workstreamName ?? undefined;
    target.queue.enqueue(item);
    this.log(
      `enqueued ${item.source} item ${item.id} → ${target.role}${target.workstreamId ? ` ws=${target.workstreamId}` : ""}`,
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

    // Check if this session belongs to any of our Pi sessions
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
      let workstreamIdValue = pickString(payload, [
        "workstream_id",
        "workstreamId",
        "AUTONOMA_WORKSTREAM_ID",
      ]);
      if (cwd && !piSessionIdValue && !workstreamIdValue) {
        const openWorkstreams = listOpenWorkstreams(this.blackboard);
        const matchingWs = openWorkstreams.find(
          (ws) => ws.worktree_path && cwd.startsWith(ws.worktree_path),
        );
        if (matchingWs) {
          const orchestrator = this.sessionManager.getByWorkstream(matchingWs.id);
          if (orchestrator) {
            piSessionIdValue = orchestrator.piSessionId;
            workstreamIdValue = matchingWs.id;
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
        workstream_id: workstreamIdValue,
      });
    } else {
      if (!isOwnPiSession) {
        const known = getSessionById(this.blackboard, sessionId);
        if (!known) {
          return { ok: true, filtered: true };
        }
      }

      if (normalized === "stop") {
        updateSessionStop(this.blackboard, sessionId);
      } else if (normalized === "session-end") {
        const reason =
          pickString(payload, ["reason", "stop_reason", "session_end_reason"]) || "ended";
        markSessionEnded(this.blackboard, sessionId, reason);
      }
    }

    if (normalized !== "stop") {
      return { ok: true, bookkeeping: true };
    }

    // Extract last assistant message from the CC session transcript for Pi context
    const transcriptPath = pickString(payload, ["transcript_path", "transcriptPath"]);
    if (transcriptPath) {
      const lastOutput = extractLastAssistantText(transcriptPath);
      if (lastOutput) {
        payload.lastAssistantText = lastOutput;
      }
    }

    // Route stop event to the Pi session that owns this CC session
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
        const openWorkstreams = listOpenWorkstreams(this.blackboard);
        const matchingWs = openWorkstreams.find(
          (ws) => ws.worktree_path && ccCwd.startsWith(ws.worktree_path),
        );
        if (matchingWs) {
          targetQueue = this.sessionManager.getByWorkstream(matchingWs.id);
          if (targetQueue) resolvedVia = `cwd-match:${matchingWs.id}`;
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
      workstreamId: targetQueue.workstreamId ?? undefined,
      workstreamName: targetQueue.workstreamName ?? undefined,
    };

    // Persist inbound
    try {
      persistInboundMessage(this.blackboard, {
        source: "hook",
        content: text,
        sender: "system",
        workstreamId: targetQueue.workstreamId ?? undefined,
        metadata: { event: normalized, ...payload },
      });
    } catch (error) {
      this.log(`message persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    targetQueue.queue.enqueue(hookItem);
    this.log(
      `hook stop: session_id=${sessionId} → ${targetQueue.role}${targetQueue.workstreamId ? ` ws=${targetQueue.workstreamId}` : ""} (via ${resolvedVia})`,
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
        sessionId: o.piSessionId,
        workstreamId: o.workstreamId!,
        workstreamName: o.workstreamName,
        messageCount: o.session?.messages?.length ?? snap.messageCount,
        busy: snap.busy,
      };
    });

    const openWorkstreams = listOpenWorkstreams(this.blackboard);
    const closedWorkstreams = listRecentlyClosedWorkstreams(this.blackboard, 24);
    const sessionCountByWorkstream = new Map<string, number>();
    for (const session of this.getSessionList()) {
      if (session.workstreamId) {
        sessionCountByWorkstream.set(
          session.workstreamId,
          (sessionCountByWorkstream.get(session.workstreamId) ?? 0) + 1,
        );
      }
    }

    return {
      ok: true,
      pid: process.pid,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      pi: {
        default: defSnapshot
          ? {
              sessionId: defSnapshot.sessionId!,
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
      workstreams: [
        ...openWorkstreams.map((ws) => ({
          id: ws.id,
          name: ws.name,
          status: "open" as const,
          repoPath: ws.repo_path ?? undefined,
          worktreePath: ws.worktree_path ?? undefined,
          piSessionId: getActivePiSessionId(this.blackboard, ws.id),
          sessionCount: sessionCountByWorkstream.get(ws.id) ?? 0,
          createdAt: ws.created_at,
        })),
        ...closedWorkstreams.map((ws) => ({
          id: ws.id,
          name: ws.name,
          status: "closed" as const,
          closedAt: ws.closed_at ?? undefined,
          repoPath: ws.repo_path ?? undefined,
          worktreePath: ws.worktree_path ?? undefined,
          piSessionId: getLatestPiSessionId(this.blackboard, ws.id),
          sessionCount: sessionCountByWorkstream.get(ws.id) ?? 0,
          createdAt: ws.created_at,
        })),
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

    // Router matched an existing workstream — route to its orchestrator if running
    const workstreamId = meta?.workstream_id as string | undefined;
    if (workstreamId && meta?.router_action === "matched") {
      const existing = this.sessionManager.getByWorkstream(workstreamId);
      if (existing) return existing;
    }

    // Everything else goes to the default agent (which can create workstreams via tool)
    return this.sessionManager.getDefault();
  }

  /**
   * Per-session queue processing callback.
   */
  private async processQueueItem(managed: ManagedPiSession, item: QueueItem): Promise<void> {
    const session = managed.session;
    if (!session) throw new Error("Pi session not initialized");

    const piSessionId = session.sessionId;

    this.log(
      `processing queue item ${item.id} source=${item.source} role=${managed.role}${managed.workstreamId ? ` ws=${managed.workstreamId}` : ""} text=${item.text.slice(0, 80)}...`,
    );

    // Turn starts → set Pi status to 'active'
    const promptAt = managed.state.notePrompt(session.messages.length);
    touchPiPrompt(this.blackboard, piSessionId, promptAt, "active");

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
      if (assistantMsg.stopReason === "error" || assistantMsg.errorMessage) {
        this.log(`queue item ${item.id} API error: ${assistantMsg.errorMessage ?? "unknown"}`);
        throw new Error(`Pi API error: ${assistantMsg.errorMessage ?? assistantMsg.stopReason}`);
      }
    }

    managed.state.noteEvent(session.messages.length);

    // Turn ends → transition state
    this.transitionPiAfterTurn(piSessionId);

    // Auto-surface final assistant message
    const finalAssistant = extractFinalAssistantMessage(session);
    if (finalAssistant) {
      const { text: finalText, messageId: finalMessageId } = finalAssistant;

      // Resolve agent message ID → server UUID via mapping table.
      // When the agent message has no ID, we can't reliably match this pi_surfaced
      // event to the message_end already broadcast by subscribe.ts, so we skip the
      // WS broadcast (the content was already delivered via message_end).
      const resolvedMessageId = finalMessageId
        ? (resolveServerId(this.blackboard, finalMessageId) ?? finalMessageId)
        : undefined;

      // Persist outbound with resolved server UUID (when available)
      try {
        const workstreamId =
          managed.workstreamId ?? (item.metadata?.workstream_id as string) ?? undefined;
        persistOutboundMessage(this.blackboard, {
          id: resolvedMessageId,
          source: "pi_outbound",
          content: finalText,
          workstreamId,
        });
      } catch (error) {
        this.log(
          `outbound message persist failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Surface with workstream label for orchestrators
      const surfaceText =
        managed.role === "orchestrator" && managed.workstreamName
          ? `[${managed.workstreamName}] ${finalText}`
          : finalText;

      try {
        await this.sendWhatsAppCommand({
          command: "send",
          text: `*B-bot:*\n---\n${surfaceText}`,
          contextRef: undefined,
        });
        // Only broadcast pi_surfaced when we have a resolved ID that matches the
        // message_end already sent by subscribe.ts. Without a resolved ID, the
        // broadcast would create a duplicate with a mismatched UUID.
        if (resolvedMessageId) {
          this.wsHub.broadcast({
            type: "pi_surfaced",
            messageId: resolvedMessageId,
            content: finalText,
            timestamp: new Date().toISOString(),
            sessionId: managed.piSessionId,
            workstreamId: managed.workstreamId ?? undefined,
            workstreamName: managed.workstreamName ?? undefined,
          });
        }
      } catch (error) {
        this.log(
          `auto-surface to WhatsApp failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // If orchestrator just ran close_workstream, destroy it
    if (managed.role === "orchestrator" && managed.workstreamId) {
      const closedWorkstream = this.detectCloseWorkstream(session);
      if (closedWorkstream) {
        this.sessionManager.destroyOrchestrator(managed.workstreamId, "close_workstream");
      }
    }
  }

  /**
   * After a Pi turn ends, check managed CC sessions to determine next state.
   */
  private transitionPiAfterTurn(piSessionId: string): void {
    try {
      const row = this.blackboard
        .prepare(
          `SELECT COUNT(*) as count FROM sessions
				 WHERE pi_session_id = ? AND status IN ('working', 'idle') AND agent_managed = 1`,
        )
        .get(piSessionId) as { count: number } | undefined;
      const activeCount = row?.count ?? 0;

      const nextStatus = activeCount > 0 ? "waiting_for_sessions" : "waiting_for_user";
      updatePiSessionStatus(this.blackboard, piSessionId, nextStatus);
    } catch (error) {
      this.log(
        `pi state transition failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Detect if the last tool call was close_workstream (orchestrator self-destruct).
   */
  private detectCloseWorkstream(session: AgentSession): boolean {
    const messages = session.messages;
    if (!messages.length) return false;
    // Look at recent messages for a close_workstream tool result
    for (let i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
      const msg = messages[i];
      if (!msg) continue;
      if (msg.role === "toolResult") {
        const toolResult = msg as ToolResultMessage;
        if (toolResult.toolName === "close_workstream") {
          return true;
        }
      }
      // Also check content array for tool_use blocks
      if (msg.role === "assistant") {
        const assistantMsg = msg as AssistantMessage;
        for (const block of assistantMsg.content) {
          if (block.type === "toolCall" && block.name === "close_workstream") {
            return true;
          }
        }
      }
    }
    return false;
  }

  createCustomTools(
    role: "orchestrator" | "default" = "default",
    workstreamId?: string,
  ): CustomToolDefinition[] {
    const tools: CustomToolDefinition[] = [
      {
        name: "query_blackboard",
        label: "Query Blackboard",
        description: "Run read-only SQL against the Autonoma blackboard.",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string", description: "SELECT or PRAGMA SQL statement" },
          },
          required: ["sql"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const rows = this.queryBlackboard(String(params.sql));
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
            details: rows,
          };
        },
      },
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
          // Reload the session that owns this tool — find by role/workstream
          const managed = workstreamId
            ? this.sessionManager.getByWorkstream(workstreamId)
            : this.sessionManager.getDefault();
          if (!managed?.session) {
            return {
              content: [{ type: "text", text: "Error: Pi session not initialized" }],
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
        name: "create_workstream",
        label: "Create Workstream",
        description:
          "Create a new workstream and spawn a dedicated orchestrator for it. Use when the user requests engineering work (features, bugs, investigations) that needs a dedicated session. The user's original message is automatically passed through to the new workstream.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Short descriptive name, 2-5 words, lowercase, dash-separated (e.g. 'fix-auth-token-refresh')",
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const { name } = params as { name: string };
          const { insertWorkstream } = await import("./blackboard/query-workstreams.ts");
          const ws = insertWorkstream(this.blackboard, name);
          this.log(`default agent created workstream "${name}" (${ws.id})`);

          try {
            const orchestrator = await this.sessionManager.createOrchestrator(
              ws.id,
              ws.name,
              undefined,
              this.createCustomTools("orchestrator", ws.id),
            );

            this.wsHub.broadcast({
              type: "workstreams_changed",
              reason: "created",
              workstreamId: ws.id,
              workstreamName: ws.name,
            });

            // Pass through the original user message to the new workstream
            const defaultSession = this.sessionManager.getDefault();
            const originalText = defaultSession?.queue.getCurrentItem()?.text;

            if (originalText) {
              const messageText = originalText;
              const prompt = this.sessionManager.buildWorkstreamPrompt(messageText, ws.name, ws.id);
              orchestrator.queue.enqueue({
                id: `ws-init-${ws.id}`,
                text: prompt,
                source: "web",
                metadata: {
                  workstream_id: ws.id,
                  workstream_name: ws.name,
                },
                receivedAt: new Date().toISOString(),
              });
              this.log(`enqueued original user message onto workstream "${ws.name}" (${ws.id})`);
            }

            return {
              content: [
                {
                  type: "text",
                  text: `Workstream "${ws.name}" created (ID: ${ws.id}). Orchestrator spawned${originalText ? " and user message passed through" : ""}.`,
                },
              ],
              details: { workstreamId: ws.id, workstreamName: ws.name },
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Workstream "${ws.name}" created (ID: ${ws.id}) but orchestrator failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              details: { workstreamId: ws.id, error: true },
            };
          }
        },
      });

      tools.push({
        name: "enqueue_message",
        label: "Enqueue Message",
        description:
          "Send a message to an existing orchestrator running on an open workstream. Use to forward user follow-ups, delegate context, or nudge an orchestrator. Does NOT create a workstream or spawn an orchestrator — use create_workstream for that.",
        parameters: {
          type: "object",
          properties: {
            workstream_id: {
              type: "string",
              description: "ID of the target workstream",
            },
            message: {
              type: "string",
              description:
                "Message content to deliver to the orchestrator. Include relevant context.",
            },
          },
          required: ["workstream_id", "message"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const { workstream_id, message } = params as { workstream_id: string; message: string };
          const { getWorkstreamById } = await import("./blackboard/query-workstreams.ts");
          const ws = getWorkstreamById(this.blackboard, workstream_id);
          if (!ws) {
            return {
              content: [{ type: "text", text: `Workstream not found: ${workstream_id}` }],
              details: { error: true },
            };
          }
          if (ws.status !== "open") {
            return {
              content: [{ type: "text", text: `Workstream is closed: ${ws.name}` }],
              details: { error: true },
            };
          }

          const orchestrator = this.sessionManager.getByWorkstream(ws.id);
          if (!orchestrator) {
            return {
              content: [
                {
                  type: "text",
                  text: `No running orchestrator for workstream: ${ws.name}`,
                },
              ],
              details: { error: true },
            };
          }

          const formattedText = `[Workstream: "${ws.name}" (${ws.id})]\n${message}`;

          try {
            orchestrator.queue.enqueue({
              id: `enq-msg-${crypto.randomUUID()}`,
              text: formattedText,
              source: "agent",
              metadata: {
                workstream_id: ws.id,
                workstream_name: ws.name,
              },
              receivedAt: new Date().toISOString(),
            });
          } catch (enqueueError) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to enqueue message to workstream "${ws.name}": ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}`,
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
              workstreamId: ws.id,
              metadata: {
                workstream_id: ws.id,
                workstream_name: ws.name,
                enqueued_by: "enqueue_message_tool",
              },
            });
          } catch (error) {
            this.log(
              `enqueue_message persist failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }

          this.log(
            `enqueued message onto workstream "${ws.name}" (${ws.id}), queue depth: ${orchestrator.queue.getDepth()}`,
          );

          return {
            content: [
              {
                type: "text",
                text: `Message enqueued to workstream "${ws.name}" (queue depth: ${orchestrator.queue.getDepth()}).`,
              },
            ],
            details: {
              workstreamId: ws.id,
              workstreamName: ws.name,
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
          "Create an isolated git worktree for a workstream. Sets up a new branch from origin/main and records the paths on the workstream.",
        parameters: {
          type: "object",
          properties: {
            workstream_id: { type: "string", description: "ID of the workstream" },
            repo_path: { type: "string", description: "Absolute path to the project repository" },
            branch_name: {
              type: "string",
              description: "Branch name (optional, defaults to ws/<workstream-slug>)",
            },
          },
          required: ["workstream_id", "repo_path"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const { workstream_id, repo_path, branch_name } = params as {
            workstream_id: string;
            repo_path: string;
            branch_name?: string;
          };
          const result = executeCreateWorktree(
            this.blackboard,
            workstream_id,
            repo_path,
            branch_name,
          );
          return { content: [{ type: "text", text: result.message }], details: result };
        },
      });

      const closeWsId = workstreamId;
      tools.push({
        name: "close_workstream",
        label: "Close Workstream",
        description:
          "Close the current workstream. Only call when the human explicitly confirms the work is done. Cleans up the git worktree, closes the workstream, and ends this orchestrator session.",
        parameters: {
          type: "object",
          properties: {
            workstream_id: { type: "string", description: "ID of the workstream to close" },
          },
          required: ["workstream_id"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const { workstream_id } = params as { workstream_id: string };
          const managed = closeWsId ? this.sessionManager.getByWorkstream(closeWsId) : undefined;
          const piSessId = managed?.piSessionId;
          if (!piSessId) {
            return {
              content: [{ type: "text", text: "Error: Orchestrator session not found" }],
              details: {},
            };
          }
          const result = await executeCloseWorkstream(this.blackboard, piSessId, workstream_id);
          if (result.ok) {
            this.wsHub.broadcast({
              type: "workstreams_changed",
              reason: "closed",
              workstreamId: workstream_id,
            });
          }
          return { content: [{ type: "text", text: result.message }], details: result };
        },
      });
    }

    return tools;
  }

  private queryBlackboard(sql: string): Array<Record<string, unknown>> {
    const normalized = String(sql ?? "")
      .trim()
      .replace(/;+\s*$/, "");
    if (!normalized) throw new Error("SQL is required");
    if (!/^(select|pragma)\b/i.test(normalized)) {
      throw new Error("query_blackboard only allows SELECT and PRAGMA");
    }
    if (normalized.includes(";")) {
      throw new Error("multiple SQL statements are not allowed");
    }
    return this.blackboard.prepare(normalized).all() as Array<Record<string, unknown>>;
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
              const label = `${managed.role}${managed.workstreamId ? ` ws=${managed.workstreamId}` : ""}`;
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
    if (payload.type === "subscribe" && typeof payload.sessionId === "string") {
      this.wsHub.subscribeClient(client.id, payload.sessionId);
      return;
    }
    if (payload.type === "unsubscribe" && typeof payload.sessionId === "string") {
      this.wsHub.unsubscribeClient(client.id, payload.sessionId);
      return;
    }
    if (payload.type === "message" && typeof payload.text === "string") {
      const targetSessionId =
        typeof payload.targetSessionId === "string" ? payload.targetSessionId : undefined;

      // Skip router when message targets a specific Pi session (direct tab input)
      let routerMeta: WorkstreamRoutingMeta = {};
      if (targetSessionId) {
        routerMeta._targetSessionId = targetSessionId;
      } else {
        try {
          const { classifyMessage } = await import("./classifier/classify.ts");
          const { resolveGroqApiKey } = await import("./classifier/groq-client.ts");
          const apiKey = resolveGroqApiKey();
          if (!apiKey) throw new Error("No Groq API key available");
          const result = await classifyMessage(payload.text, this.blackboard, apiKey);
          routerMeta = { router_action: result.action };
          if (result.workstream) {
            routerMeta.workstream_id = result.workstream.id;
            routerMeta.workstream_name = result.workstream.name;
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
      });

      // Mirror web user message to WhatsApp for complete conversation record
      try {
        const wsLabel = routerMeta.workstream_name ? `[${routerMeta.workstream_name}] ` : "";
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
  const lastAssistantText = pickString(payload, ["lastAssistantText"]);
  const lines = [
    `[hook] ${humanizeHookEvent(eventName)}: ${hookVerb(eventName)}`,
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
