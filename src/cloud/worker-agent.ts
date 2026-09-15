import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createQueryBlackboardTool } from "../blackboard/tool-query-blackboard.ts";
import { isThinkingLevel, loadConfig } from "../config/load-config.ts";
import { resolveModelEntry, resolveModelEntryId } from "../config/models.ts";
import { git } from "../git.ts";
import { findConversationEntry } from "../streams/conversation-identity.ts";
import { createFlitterbotAgent } from "../streams/create-agent.ts";
import { formatPromptWithContext } from "../streams/format-prompt.ts";
import { PiSessionState } from "../streams/pi-session-state.ts";
import { subscribeToPiSession } from "../streams/pi-subscribe.ts";
import { rewriteSessionHeaderCwd } from "../streams/session-file-cwd.ts";
import { createToolPathFormatter } from "../streams/tool-display.ts";
import type { QueueItem } from "../streams/turn-queue.ts";
import { WebSocketHub } from "../ws/hub.ts";
import { CloudClient, type WorkerIdentity } from "./client.ts";
import { WorkerHooks } from "./hooks.ts";
import { DurableOutbox } from "./publisher.ts";
import { captureRepository } from "./repository.ts";
import { createCloudTools } from "./tools.ts";
import type { CloudStart } from "./workspace.ts";

export type WorkerBootstrap = WorkerIdentity & {
  piSessionId: string;
  controllerVm: string;
  streamName: string;
  cwd: string;
  baseRef?: string;
  sessionFile: string;
  checkpointVersion: number;
  outbox: string;
  start?: CloudStart;
};

export async function createCloudWorkerAgent(
  bootstrap: WorkerBootstrap,
  report: (error: unknown) => void,
) {
  const client = new CloudClient(bootstrap);
  const assignment = await client.request<{ checkpointVersion: number; phase: string }>(
    "assignment",
  );
  await client.request("restart", {});
  const created = await createFlitterbotAgent({
    role: "orchestrator",
    cwd: bootstrap.cwd,
    expectedPiSessionId: bootstrap.piSessionId,
    resumeSessionFile: bootstrap.sessionFile,
    orchestratorContext: {
      streamId: bootstrap.streamId,
      streamName: bootstrap.streamName,
      repoPath: bootstrap.cwd,
    },
    customTools: [
      createQueryBlackboardTool((sql, mode) => client.query(sql, mode)),
      ...createCloudTools(
        client,
        bootstrap,
        async () => {
          await hooks.publish();
          await capture();
          await publisher.flush();
        },
        () => hooks.settle(),
        () =>
          session.sessionManager
            .getBranch()
            .slice()
            .reverse()
            .find((entry) => entry.type === "message" && entry.message.role === "user")?.id,
      ),
    ],
  });
  let session = created.runtime.session;
  const state = new PiSessionState();
  state.initialize(session.sessionId, session.sessionFile, session.messages.length);
  const hub = new WebSocketHub((socket, value) => {
    if (!value || typeof value !== "object") return;
    const event = value as { type?: string; piSessionId?: string };
    if (event.type === "subscribe" && event.piSessionId === bootstrap.piSessionId) {
      hub.subscribeClient(socket.id, event.piSessionId);
    }
  });
  let formatter = createToolPathFormatter({ cwd: bootstrap.cwd, homeDir: os.homedir() });
  const publisher = new DurableOutbox(
    bootstrap.outbox,
    (checkpoint) => client.checkpoint(checkpoint),
    report,
  );
  const hooks = new WorkerHooks(client, bootstrap, report);
  let version = Math.max(bootstrap.checkpointVersion, assignment.checkpointVersion);
  if (fs.existsSync(bootstrap.outbox)) {
    for (const name of fs.readdirSync(bootstrap.outbox)) {
      if (/^[1-9][0-9]*\.json$/.test(name)) version = Math.max(version, Number.parseInt(name, 10));
    }
  }
  let captures: Promise<void> = Promise.resolve();
  let draining: Promise<void> | undefined;
  let closing = assignment.phase === "closing";
  let mutating = false;
  let stateUpdates: Promise<unknown> = Promise.resolve();

  function publishState(status: string, timestamp: string): void {
    stateUpdates = stateUpdates
      .catch(report)
      .then(() => client.request("state", { status, timestamp }));
    void stateUpdates.catch(report);
  }

  function capture(): Promise<void> {
    if (!session.sessionFile) return Promise.reject(new Error("Pi session has no persistent file"));
    const content = fs.readFileSync(session.sessionFile, "utf8"); // Capture before Pi can resume writing.
    const next = ++version;
    const operation = captures
      .catch(() => {})
      .then(async () => {
        let root: string | undefined;
        try {
          root = (await git(bootstrap.cwd, ["rev-parse", "--show-toplevel"])).trim();
        } catch (error) {
          if (bootstrap.baseRef) throw error;
        }
        const workspace = root ? await captureRepository(root) : undefined;
        const cwdRelative = root
          ? path.relative(fs.realpathSync(root), fs.realpathSync(bootstrap.cwd))
          : undefined;
        await publisher.stage({
          version: next,
          sessions: [{ piSessionId: bootstrap.piSessionId, content }],
          workspace: workspace
            ? { ...workspace, baseRef: bootstrap.baseRef, cwdRelative: cwdRelative || undefined }
            : undefined,
        });
      });
    captures = operation;
    return operation;
  }

  const steered = new Map<string, QueueItem>();
  const subscribe = () => {
    const unsubscribeEvents = subscribeToPiSession(
      session,
      state,
      (_id, timestamp) => {
        publishState("active", timestamp);
      },
      hub,
      { displayArgsForTool: (_id, name, args) => formatter.displayArgsForTool(name, args) },
      bootstrap.streamId,
      bootstrap.streamName,
      {
        onAgentSettled: () => {
          if (!mutating) void capture().catch(report);
          publishState("waiting_for_user", new Date().toISOString());
        },
      },
    );
    const unsubscribeAdmission = session.agent.subscribe(async (event, signal) => {
      if (
        event.type !== "turn_end" ||
        event.message.role !== "assistant" ||
        signal.aborted ||
        closing ||
        mutating
      )
        return;
      for (const item of await pendingCommands()) {
        if (signal.aborted || closing) break;
        if (!(await client.request<{ accepted: boolean }>("accept", { id: item.id })).accepted)
          continue;
        if (signal.aborted) {
          await client.request("fail", { id: item.id });
          continue;
        }
        if (item.source !== "hook") state.addSteeredItem(item);
        try {
          await deliverToSession(item, true);
          steered.set(item.id, item);
        } catch (error) {
          state.removeSteeredItem(item);
          await client.request("fail", { id: item.id });
          report(error);
        }
      }
    });
    return () => {
      unsubscribeAdmission();
      unsubscribeEvents();
    };
  };

  async function pendingCommands(): Promise<QueueItem[]> {
    const { commands } = await client.request<{
      commands: Array<{
        id: string;
        createdAt: string;
        payload: Omit<QueueItem, "id" | "receivedAt">;
      }>;
    }>("commands");
    return commands.map(({ id, createdAt, payload }) => ({
      ...payload,
      id,
      receivedAt: createdAt,
      serverMessageId: payload.serverMessageId ?? id,
    }));
  }

  async function deliverToSession(item: QueueItem, steering = false): Promise<void> {
    const text = formatPromptWithContext(item);
    if (item.source === "hook") {
      await session.sendCustomMessage(
        {
          customType: "flitterbot-hook",
          content: item.images?.length ? [{ type: "text", text }, ...item.images] : text,
          display: true,
          details: { queueItemId: item.id, metadata: item.metadata },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    } else if (steering) await session.steer(text, item.images);
    else await session.prompt(text, { images: item.images });
  }

  async function settleSteering(): Promise<void> {
    for (const [id, item] of steered) {
      const persisted =
        item.source === "hook"
          ? session.sessionManager
              .getEntries()
              .some(
                (entry) =>
                  entry.type === "custom_message" &&
                  (entry.details as { queueItemId?: string } | undefined)?.queueItemId === id,
              )
          : Boolean(findConversationEntry(session.sessionManager, item.serverMessageId!));
      if (!persisted) continue;
      steered.delete(id);
      await client.request("complete", { id });
    }
  }

  let unsubscribe = subscribe();

  async function drain(): Promise<void> {
    while (!closing && !mutating) {
      const item = (await pendingCommands())[0];
      if (!item) return;
      if (typeof item?.text !== "string") throw new Error("Invalid persisted prompt");
      const { accepted } = await client.request<{ accepted: boolean }>("accept", {
        id: item.id,
      });
      if (!accepted) continue;
      state.setBusy(true, item);
      state.notePrompt(session.messages.length);
      hub.broadcast({
        type: "queue_item_start",
        item,
        piSessionId: bootstrap.piSessionId,
        streamId: bootstrap.streamId,
      });
      try {
        await deliverToSession(item);
        await settleSteering();
        await client.request("complete", { id: item.id });
      } catch (error) {
        await client.request("fail", { id: item.id });
        hub.broadcast({
          type: "error",
          piSessionId: bootstrap.piSessionId,
          message: error instanceof Error ? error.message : String(error),
        });
        await capture();
        throw error;
      } finally {
        state.setBusy(false);
        hub.broadcast({
          type: "queue_item_end",
          itemId: item.id,
          piSessionId: bootstrap.piSessionId,
          streamId: bootstrap.streamId,
        });
      }
    }
  }

  function wake(): Promise<void> {
    if (!draining) {
      const operation = drain();
      draining = operation;
      void operation
        .finally(() => {
          if (draining === operation) draining = undefined;
        })
        .catch(() => {});
    }
    return draining;
  }

  async function saveModel() {
    const model = session.model;
    if (!model) throw new Error("Session has no model");
    const info = {
      id: resolveModelEntryId(loadConfig(), model.provider, model.id),
      provider: model.provider,
      modelId: model.id,
      thinkingLevel: session.thinkingLevel,
    };
    await client.request("model", info);
    return info;
  }

  async function control(body: Record<string, unknown>) {
    if (
      closing ||
      mutating ||
      draining ||
      steered.size ||
      session.isStreaming ||
      session.isCompacting
    )
      throw new Error("Pi session is busy");
    mutating = true;
    try {
      let result: unknown;
      switch (body.operation) {
        case "model": {
          if (typeof body.id !== "string") throw new Error("Model ID required");
          await created.runtime.services.modelRuntime.refresh({ allowNetwork: false });
          const entry = resolveModelEntry(loadConfig(), body.id);
          const model = created.runtime.services.modelRuntime.getModel(
            entry.provider,
            entry.modelId,
          );
          if (!model) throw new Error("Model not found");
          await session.setModel(model);
          if (isThinkingLevel(body.level)) session.setThinkingLevel(body.level);
          else if (entry.thinkingLevel) session.setThinkingLevel(entry.thinkingLevel);
          result = await saveModel();
          break;
        }
        case "thinking": {
          if (!isThinkingLevel(body.level)) throw new Error("Invalid thinking level");
          session.setThinkingLevel(body.level);
          result = await saveModel();
          break;
        }
        case "compact": {
          const compacted = await session.compact(
            typeof body.customInstructions === "string" ? body.customInstructions : undefined,
          );
          hub.broadcastHistoryCommit({
            type: "history_rewritten",
            piSessionId: bootstrap.piSessionId,
            reason: "compact",
          });
          result = {
            ok: true,
            piSessionId: bootstrap.piSessionId,
            messageCount: session.messages.length,
            summary: compacted.summary,
            firstKeptEntryId: compacted.firstKeptEntryId,
            tokensBefore: compacted.tokensBefore,
          };
          break;
        }
        case "prune": {
          if (typeof body.entryId !== "string") throw new Error("Entry ID required");
          const target = session.sessionManager.getEntry(body.entryId);
          if (target?.type !== "message" || target.message.role !== "user")
            throw new Error("Prune target must be a user message");
          if ((await session.navigateTree(body.entryId)).cancelled)
            throw new Error("Navigation cancelled");
          session.sessionManager.appendCustomEntry("flitterbot:prune_anchor", {
            prunedEntryId: body.entryId,
            prunedAt: new Date().toISOString(),
          });
          hub.broadcastHistoryCommit({
            type: "history_rewritten",
            piSessionId: bootstrap.piSessionId,
            reason: "prune",
          });
          result = {
            ok: true,
            piSessionId: bootstrap.piSessionId,
            messageCount: session.messages.length,
          };
          break;
        }
        case "cwd": {
          if (typeof body.cwd !== "string") throw new Error("cwd required");
          const raw = body.cwd.trim().replace(/^@/, "");
          const expanded = raw.startsWith("~/")
            ? path.join(os.homedir(), raw.slice(2))
            : raw === "~"
              ? os.homedir()
              : path.resolve(loadConfig().projectsDir, raw);
          const cwd = fs.realpathSync(expanded);
          const relative = path.relative(os.homedir(), cwd);
          if (
            relative.startsWith("..") ||
            path.isAbsolute(relative) ||
            !fs.statSync(cwd).isDirectory()
          )
            throw new Error("cwd must be a directory under home");
          await captures;
          const file = session.sessionFile!;
          const previous = rewriteSessionHeaderCwd(file, cwd);
          try {
            if ((await created.runtime.switchSession(file)).cancelled)
              throw new Error("cwd switch cancelled");
          } catch (error) {
            if (previous !== undefined) rewriteSessionHeaderCwd(file, previous);
            throw error;
          }
          unsubscribe();
          session = created.runtime.session;
          if (session.sessionId !== bootstrap.piSessionId)
            throw new Error("cwd switch changed session identity");
          bootstrap.cwd = cwd;
          try {
            bootstrap.baseRef = (await git(cwd, ["rev-parse", "HEAD"])).trim();
          } catch {
            bootstrap.baseRef = undefined;
          }
          fs.writeFileSync(
            path.join(path.dirname(bootstrap.outbox), "bootstrap.json"),
            JSON.stringify(bootstrap),
            { mode: 0o600 },
          );
          formatter = createToolPathFormatter({ cwd, homeDir: os.homedir() });
          state.initialize(session.sessionId, session.sessionFile, session.messages.length);
          unsubscribe = subscribe();
          await client.request("cwd", { cwd });
          result = {
            ok: true,
            streamId: bootstrap.streamId,
            piSessionId: bootstrap.piSessionId,
            cwd,
          };
          break;
        }
        case "snapshot":
          result = { ok: true };
          break;
        default:
          throw new Error("Unknown session control");
      }
      await hooks.publish();
      await capture();
      await publisher.flush();
      return result;
    } finally {
      mutating = false;
      void wake().catch(report);
    }
  }

  await saveModel();
  await client.request("state", {
    status: "waiting_for_user",
    timestamp: new Date().toISOString(),
  });
  void publisher.flush().catch(report);
  return {
    control,
    client,
    hooks,
    runtime: created.runtime,
    hub,
    state,
    wake,
    async checkpoint(final = false): Promise<number> {
      if (final) {
        closing = true;
        await draining;
        await session.agent.waitForIdle();
        await settleSteering();
        for (const id of steered.keys()) await client.request("fail", { id });
        steered.clear();
        session.clearQueue();
      }
      await hooks.publish(final);
      await capture();
      await captures;
      await publisher.flush();
      return version;
    },
    async dispose(): Promise<void> {
      closing = true;
      await session.abort();
      await draining?.catch(() => {});
      await captures.catch(report);
      publisher.stop();
      hooks.stop();
      unsubscribe();
      hub.closeAll();
      await created.runtime.dispose();
    },
  };
}
