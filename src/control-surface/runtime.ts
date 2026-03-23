import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import type net from "node:net";
import path from "node:path";
import { type BlackboardDatabase, openBlackboard, pingBlackboard } from "../blackboard/db.ts";
import { clearAllHealthFlags } from "../blackboard/queries/health-flags.ts";
import { persistInboundMessage, persistOutboundMessage } from "../blackboard/queries/messages.ts";
import { touchPiPrompt, updatePiSessionStatus } from "../blackboard/queries/pi-sessions.ts";
import {
  findIdleCleanupCandidates,
  getSessionById,
  insertSession,
  listSessions,
  markSessionEnded,
  markStaleSessions,
  updateSessionStop,
} from "../blackboard/queries/sessions.ts";
import {
  getActivePiSessionId,
  listOpenWorkstreams,
  listRecentlyClosedWorkstreams,
  resetAllWorkstreams,
} from "../blackboard/queries/workstreams.ts";
import { killTmuxSession } from "../claude-sessions/tmux.ts";
import { type AutonomaConfig, loadConfig } from "../config/load-config.ts";
import type {
  ControlSurfaceWebSocketClientEvent,
  WhatsAppDaemonStatus as ControlSurfaceWhatsAppStatus,
  DeliveryMode,
  DirectSessionMessageResponse,
  HookResponse,
  RuntimeWhatsAppStartResponse,
  RuntimeWhatsAppStopResponse,
  ClaudeSessionListItem as SessionListItem,
  SessionTranscriptResponse,
  StatusResponse,
} from "../contracts/index.ts";
import { sendDaemonCommand } from "../whatsapp/ipc.ts";
import {
  getDaemonStatus,
  startDaemonProcess,
  stopDaemonProcess,
  waitForDaemonReady,
} from "../whatsapp/process.ts";
import { formatPromptWithContext } from "./pi/format-prompt.ts";
import { type ManagedPiSession, PiSessionManager } from "./pi/session-manager.ts";
import { formatSourcePrefix } from "./pi/source-prefix.ts";
import type { QueueItem, QueueSource } from "./queue/turn-queue.ts";
import { executeCloseWorkstream } from "./tools/close-workstream.ts";
import { executeCreateWorktree } from "./tools/create-worktree.ts";
import { directSessionMessage } from "./tools/manage-session.ts";
import { readTranscriptPage } from "./transcript.ts";
import { extractLastAssistantText } from "./transcript-reader.ts";
import { type WebSocketClient, WebSocketHub } from "./ws/hub.ts";

type EnqueueInput = {
  text: string;
  source: QueueSource;
  metadata?: Record<string, unknown>;
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
  private whatsappStatusCache: {
    status: ControlSurfaceWhatsAppStatus;
    pid?: number;
    managedByControlSurface: true;
    requiresManualAuth?: boolean;
  } = {
    status: "stopped",
    managedByControlSurface: true,
  };

  constructor(config: AutonomaConfig = loadConfig()) {
    this.config = config;
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

    // Persist to unified messages table
    try {
      const source = item.source as "whatsapp" | "web" | "hook" | "cron";
      const workstreamId = (input.metadata?.workstream_id as string) ?? undefined;
      persistInboundMessage(this.blackboard, {
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

    // Steer bypass: if the queue is busy and the session is actively streaming,
    // deliver the steer directly to the running session instead of waiting in the queue.
    if (item.deliveryMode === "steer" && target.queue.isBusy() && target.session.isStreaming) {
      this.log(
        `steer bypass: delivering ${item.id} directly to ${target.role} (queue busy, session streaming)`,
      );
      void target.session.prompt(formatPromptWithContext(item, target.role), {
        streamingBehavior: "steer",
        images: item.images,
      });
      return { ok: true, item };
    }

    target.queue.enqueue(item);
    this.log(
      `enqueued ${item.source} item ${item.id} → ${target.role}${target.workstreamId ? ` ws=${target.workstreamId}` : ""}`,
    );

    return { ok: true, item };
  }

  handleHook(eventName: string, payload: Record<string, unknown>): HookResponse {
    const normalized = eventName.toLowerCase();
    if (!ACCEPTED_HOOK_EVENTS.has(normalized)) {
      return { ok: true, filtered: true };
    }

    const sessionId = pickString(payload, ["session_id", "sessionId"]);
    if (!sessionId) {
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
        (payload as Record<string, unknown>).lastAssistantText = lastOutput;
      }
    }

    // Route stop event to the Pi session that owns this CC session
    const piSessionIdFromPayload = pickString(payload, [
      "pi_session_id",
      "piSessionId",
      "AUTONOMA_PI_SESSION_ID",
    ]);
    let targetQueue: ManagedPiSession | undefined;
    if (piSessionIdFromPayload) {
      targetQueue = this.sessionManager.getByPiSessionId(piSessionIdFromPayload);
    }
    const ccSession = !targetQueue ? getSessionById(this.blackboard, sessionId) : undefined;
    if (!targetQueue) {
      // Fall back: look up pi_session_id from the sessions table
      if (ccSession?.piSessionId) {
        targetQueue = this.sessionManager.getByPiSessionId(ccSession.piSessionId);
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
        }
      }
    }
    if (!targetQueue) {
      targetQueue = this.sessionManager.getDefault();
    }

    const text = formatHookMessage(normalized, payload);
    const hookItem: QueueItem = {
      id: crypto.randomUUID(),
      source: "hook",
      text,
      metadata: { event: normalized, ...payload },
      receivedAt: new Date().toISOString(),
      deliveryMode: "followUp",
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
      `enqueued hook stop item ${hookItem.id} → ${targetQueue.role}${targetQueue.workstreamId ? ` ws=${targetQueue.workstreamId}` : ""}`,
    );
    return { ok: true };
  }

  getStatus(): StatusResponse {
    const def = this.sessionManager.getDefault();
    const defSnapshot = def.state.getSnapshot();
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
        default: {
          sessionId: defSnapshot.sessionId!,
          sessionFile: defSnapshot.sessionFile ?? null,
          messageCount: def.session?.messages?.length ?? defSnapshot.messageCount,
          lastPromptAt: defSnapshot.lastPromptAt ?? null,
          busy: defSnapshot.busy,
        },
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
          piSessionId: getActivePiSessionId(this.blackboard, ws.id),
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
    const existing = await getDaemonStatus();
    if (existing) {
      this.whatsappStatusCache = this.mapDaemonStatus(existing);
      return { ok: true, ...this.whatsappStatusCache };
    }
    await startDaemonProcess();
    const daemon = await waitForDaemonReady();
    this.whatsappStatusCache = this.mapDaemonStatus(daemon);
    return { ok: true, ...this.whatsappStatusCache };
  }

  async stopWhatsAppDaemon(): Promise<RuntimeWhatsAppStopResponse> {
    const daemon = await stopDaemonProcess();
    this.whatsappStatusCache = this.mapDaemonStatus(daemon);
    return { ok: true, ...this.whatsappStatusCache };
  }

  handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer | undefined): boolean {
    return this.wsHub.handleUpgrade(req, socket, head, this.config.controlSurfaceToken);
  }

  /**
   * Resolve which ManagedPiSession should handle this message.
   * May lazily create an orchestrator if needed.
   */
  private resolveTargetSession(input: EnqueueInput, item: QueueItem): ManagedPiSession {
    const meta = input.metadata;

    // Direct-targeted session (web UI tab input) — bypass all routing
    const targetSessionId = meta?._targetSessionId as string | undefined;
    if (targetSessionId) {
      const target = this.sessionManager.getByPiSessionId(targetSessionId);
      if (target) return target;
      // Session not found — fall through to normal routing
    }

    // Cron always goes to default
    if (input.source === "cron") {
      return this.sessionManager.getDefault();
    }

    // Non-work messages go to default
    if (!meta?.router_is_work || meta.router_action === "none") {
      return this.sessionManager.getDefault();
    }

    const workstreamId = meta.workstream_id as string | undefined;
    if (!workstreamId) {
      return this.sessionManager.getDefault();
    }

    const action = meta.router_action as string;
    const workstreamName = (meta.workstream_name as string) ?? workstreamId;

    // Check for existing orchestrator
    const existing = this.sessionManager.getByWorkstream(workstreamId);
    if (existing) {
      return existing;
    }

    // Need to spawn orchestrator — but we can't await here since resolveTargetSession is sync.
    // Instead, enqueue to default and spawn async. The next message will route correctly.
    // Actually, we need to handle this properly. Let's spawn synchronously by queuing
    // a special first message after creation. We'll use a different approach:
    // queue to default now, but trigger orchestrator creation and re-route.
    //
    // Better approach: since enqueue is called from async contexts (handleWebSocketMessage,
    // handleMessageRoute), we can make spawning lazy. For now, route to default and
    // the processQueueItem will check and spawn if needed.
    //
    // Store spawn intent in item metadata for processQueueItem to handle
    if (action === "created" || action === "reopened" || action === "matched") {
      item.metadata = {
        ...item.metadata,
        _spawnOrchestrator: true,
        _workstreamId: workstreamId,
        _workstreamName: workstreamName,
      };
    }

    return this.sessionManager.getDefault();
  }

  /**
   * Per-session queue processing callback.
   */
  private async processQueueItem(managed: ManagedPiSession, item: QueueItem): Promise<void> {
    const session = managed.session;
    if (!session) throw new Error("Pi session not initialized");

    // Check if this item needs to spawn an orchestrator and re-route
    if (item.metadata?._spawnOrchestrator) {
      const wsId = item.metadata._workstreamId as string;
      const wsName = item.metadata._workstreamName as string;

      // Clean spawn metadata
      const cleanMeta = { ...item.metadata };
      delete cleanMeta._spawnOrchestrator;
      delete cleanMeta._workstreamId;
      delete cleanMeta._workstreamName;
      item.metadata = cleanMeta;

      try {
        const orchestrator = await this.sessionManager.createOrchestrator(
          wsId,
          wsName,
          undefined,
          this.createCustomTools("orchestrator", wsId),
        );

        // Build context-transfer prompt and enqueue to orchestrator
        const contextPrompt = this.sessionManager.buildContextTransferPrompt(
          item.text,
          wsName,
          wsId,
        );

        const reroutedItem: QueueItem = {
          ...item,
          text: contextPrompt,
          metadata: { ...item.metadata },
        };

        orchestrator.queue.enqueue(reroutedItem);
        this.log(
          `re-routed item ${item.id} to new orchestrator for workstream "${wsName}" (${wsId})`,
        );
        return; // Don't process on default agent
      } catch (error) {
        this.log(
          `orchestrator spawn failed for ${wsId}, falling through to default: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Fall through to process on default agent
      }
    }

    const piSessionId = session.sessionId;

    this.log(
      `processing queue item ${item.id} source=${item.source} role=${managed.role}${managed.workstreamId ? ` ws=${managed.workstreamId}` : ""} text=${item.text.slice(0, 80)}...`,
    );

    // Turn starts → set Pi status to 'active'
    const promptAt = managed.state.notePrompt(session.messages.length);
    touchPiPrompt(this.blackboard, piSessionId, promptAt, "active");

    const promptText = formatPromptWithContext(item, managed.role);

    if (session.isStreaming) {
      await session.prompt(promptText, {
        streamingBehavior: item.deliveryMode ?? "followUp",
        images: item.images,
      });
    } else {
      await session.prompt(promptText, { images: item.images });
    }
    this.log(`queue item ${item.id} prompt completed, messages=${session.messages.length}`);

    // Check for API errors
    const lastMsg = session.messages[session.messages.length - 1] as
      | Record<string, unknown>
      | undefined;
    if (lastMsg?.role === "assistant") {
      const stopReason = (lastMsg as any).stopReason ?? (lastMsg as any).stop_reason;
      const errorMessage = (lastMsg as any).errorMessage ?? (lastMsg as any).error_message;
      if (stopReason === "error" || errorMessage) {
        this.log(`queue item ${item.id} API error: ${errorMessage ?? "unknown"}`);
        throw new Error(`Pi API error: ${errorMessage ?? stopReason}`);
      }
    }

    managed.state.noteEvent(session.messages.length);

    // Turn ends → transition state
    this.transitionPiAfterTurn(piSessionId);

    // Auto-surface final assistant message
    const finalText = extractFinalAssistantText(session);
    if (finalText) {
      // Persist outbound
      try {
        const workstreamId =
          managed.workstreamId ?? (item.metadata?.workstream_id as string) ?? undefined;
        persistOutboundMessage(this.blackboard, {
          source: "pi_outbound" as any,
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
          contextRef: null,
        });
        this.wsHub.broadcast({
          type: "pi_surfaced",
          content: finalText,
          timestamp: new Date().toISOString(),
          sessionId: managed.piSessionId,
          workstreamId: managed.workstreamId ?? undefined,
          workstreamName: managed.workstreamName ?? undefined,
        });
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
  private detectCloseWorkstream(session: any): boolean {
    const messages = session.messages;
    if (!messages?.length) return false;
    // Look at recent messages for a close_workstream tool result
    for (let i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
      const msg = messages[i] as Record<string, unknown> | undefined;
      if (!msg) continue;
      if (msg.role === "toolResult" && (msg as any).toolName === "close_workstream") {
        return true;
      }
      // Also check content array for tool_use blocks
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content as any[]) {
          if (block?.type === "toolCall" && block?.name === "close_workstream") {
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
  ): Array<any> {
    const tools: Array<any> = [
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
        execute: async (_toolCallId: string, params: any) => {
          const rows = this.queryBlackboard(params.sql);
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
      {
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
        execute: async (_toolCallId: string, params: any) => {
          const result = executeCreateWorktree(
            this.blackboard,
            params.workstream_id,
            params.repo_path,
            params.branch_name,
          );
          return { content: [{ type: "text", text: result.message }], details: result };
        },
      },
    ];

    if (role === "orchestrator") {
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
        execute: async (_toolCallId: string, params: any) => {
          const managed = closeWsId ? this.sessionManager.getByWorkstream(closeWsId) : undefined;
          const piSessId = managed?.piSessionId;
          if (!piSessId) {
            return {
              content: [{ type: "text", text: "Error: Orchestrator session not found" }],
              details: {},
            };
          }
          const result = await executeCloseWorkstream(
            this.blackboard,
            piSessId,
            params.workstream_id,
          );
          if (result.ok) {
            this.wsHub.broadcast({
              type: "workstreams_changed",
              reason: "closed",
              workstreamId: params.workstream_id,
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

  private async sendWhatsAppCommand(command: Record<string, unknown>): Promise<any> {
    try {
      const response = await sendDaemonCommand(command as any);
      if (response.daemon) {
        this.whatsappStatusCache = this.mapDaemonStatus(response.daemon);
      }
      return response;
    } catch {
      await this.startWhatsAppDaemon();
      const response = await sendDaemonCommand(command as any);
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
    this.whatsappStatusCache = this.mapDaemonStatus(await getDaemonStatus());
  }

  private async ensureWhatsAppDaemon(): Promise<void> {
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
        const allManaged = [
          this.sessionManager.getDefault(),
          ...this.sessionManager.listOrchestrators(),
        ];
        for (const managed of allManaged) {
          const snapshot = managed.state.getSnapshot();
          if (snapshot.busy && snapshot.currentTurnStartedAt) {
            const age = Date.now() - Date.parse(snapshot.currentTurnStartedAt);
            if (age > this.config.toolTimeoutMinutes * 60_000) {
              this.log(
                `queue turn appears stuck for ${Math.round(age / 1000)}s (${managed.role}${managed.workstreamId ? ` ws=${managed.workstreamId}` : ""})`,
              );
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
    if (payload.type === "subscribe" && typeof (payload as any).sessionId === "string") {
      this.wsHub.subscribeClient(client.id, (payload as any).sessionId);
      return;
    }
    if (payload.type === "unsubscribe" && typeof (payload as any).sessionId === "string") {
      this.wsHub.unsubscribeClient(client.id, (payload as any).sessionId);
      return;
    }
    if (payload.type === "message" && typeof payload.text === "string") {
      const targetSessionId =
        typeof payload.targetSessionId === "string" ? payload.targetSessionId : undefined;

      // Skip router when message targets a specific Pi session (direct tab input)
      let routerMeta: Record<string, unknown> = {};
      if (targetSessionId) {
        routerMeta._targetSessionId = targetSessionId;
      } else {
        try {
          const { classifyMessage } = await import("./router/classify.ts");
          const { resolveGroqApiKey } = await import("./router/groq-client.ts");
          const apiKey = resolveGroqApiKey();
          if (!apiKey) throw new Error("No Groq API key available");
          const result = await classifyMessage(
            payload.text,
            this.blackboard,
            apiKey,
            this.config.projectsDir,
          );
          routerMeta = { router_action: result.action, router_is_work: result.isWorkMessage };
          if (result.workstream) {
            routerMeta.workstream_id = result.workstream.id;
            routerMeta.workstream_name = result.workstream.name;
            if (result.action === "created" || result.action === "reopened") {
              this.wsHub.broadcast({
                type: "workstreams_changed",
                reason: result.action,
                workstreamId: result.workstream.id,
                workstreamName: result.workstream.name,
              });
            }
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
          contextRef: null,
        });
      } catch (error) {
        this.log(
          `mirror web message to WhatsApp failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

function extractFinalAssistantText(session: any): string | undefined {
  if (!session?.messages?.length) return undefined;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i] as Record<string, unknown> | undefined;
    if (!msg || msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const textParts = content
        .filter((block: any) => block?.type === "text" && typeof block.text === "string")
        .map((block: any) => block.text)
        .join("");
      if (textParts.trim()) return textParts.trim();
    }
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
    `${formatSourcePrefix("hook", false)}${humanizeHookEvent(eventName)}: ${hookVerb(eventName)}`,
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
