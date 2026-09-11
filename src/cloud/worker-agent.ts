import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createQueryBlackboardTool } from "../blackboard/tool-query-blackboard.ts";
import { createFlitterbotAgent } from "../streams/create-agent.ts";
import { PiSessionState } from "../streams/pi-session-state.ts";
import { subscribeToPiSession } from "../streams/pi-subscribe.ts";
import { createToolPathFormatter } from "../streams/tool-display.ts";
import type { QueueItem } from "../streams/turn-queue.ts";
import { WebSocketHub } from "../ws/hub.ts";
import { CloudClient, type WorkerIdentity } from "./client.ts";
import { CheckpointPublisher } from "./publisher.ts";
import { captureRepository } from "./repository.ts";

export type WorkerBootstrap = WorkerIdentity & {
  piSessionId: string;
  streamName: string;
  cwd: string;
  baseRef?: string;
  sessionFile: string;
  checkpointVersion: number;
  outbox: string;
};

export async function createCloudWorkerAgent(
  bootstrap: WorkerBootstrap,
  report: (error: unknown) => void,
) {
  const client = new CloudClient(bootstrap);
  const assignment = await client.request<{ checkpointVersion: number; phase: string }>(
    "assignment",
  );
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
    customTools: [createQueryBlackboardTool((sql, mode) => client.query(sql, mode))],
  });
  const session = created.runtime.session;
  const state = new PiSessionState();
  state.initialize(session.sessionId, session.sessionFile, session.messages.length);
  const hub = new WebSocketHub((socket, value) => {
    if (!value || typeof value !== "object") return;
    const event = value as { type?: string; piSessionId?: string };
    if (event.type === "subscribe" && event.piSessionId === bootstrap.piSessionId) {
      hub.subscribeClient(socket.id, event.piSessionId);
    }
  });
  const formatter = createToolPathFormatter({ cwd: bootstrap.cwd, homeDir: os.homedir() });
  const publisher = new CheckpointPublisher(
    bootstrap.outbox,
    (checkpoint) => client.checkpoint(checkpoint),
    report,
  );
  let version = Math.max(bootstrap.checkpointVersion, assignment.checkpointVersion);
  if (fs.existsSync(bootstrap.outbox)) {
    for (const name of fs.readdirSync(bootstrap.outbox)) {
      if (/^[1-9][0-9]*\.json$/.test(name)) version = Math.max(version, Number.parseInt(name, 10));
    }
  }
  let captures: Promise<void> = Promise.resolve();
  let draining: Promise<void> | undefined;
  let closing = assignment.phase === "closing";
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
        const workspace = fs.existsSync(path.join(bootstrap.cwd, ".git"))
          ? await captureRepository(bootstrap.cwd)
          : undefined;
        await publisher.stage({
          version: next,
          sessions: [{ piSessionId: bootstrap.piSessionId, content }],
          workspace: workspace ? { ...workspace, baseRef: bootstrap.baseRef } : undefined,
        });
      });
    captures = operation;
    return operation;
  }

  const unsubscribe = subscribeToPiSession(
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
        void capture().catch(report);
        publishState("waiting_for_user", new Date().toISOString());
      },
    },
  );

  async function drain(): Promise<void> {
    while (!closing) {
      const { commands } = await client.request<{
        commands: Array<{
          id: string;
          createdAt: string;
          payload: Omit<QueueItem, "id" | "receivedAt">;
        }>;
      }>("commands");
      const command = commands[0];
      if (!command) return;
      const item: QueueItem = { ...command.payload, id: command.id, receivedAt: command.createdAt };
      if (typeof item?.text !== "string") throw new Error("Invalid persisted prompt");
      const { accepted } = await client.request<{ accepted: boolean }>("accept", {
        id: command.id,
      });
      if (!accepted) continue;
      state.setBusy(true, item);
      state.notePrompt(session.messages.length);
      try {
        await session.prompt(item.text, { images: item.images });
        await client.request("complete", { id: command.id });
      } finally {
        state.setBusy(false);
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

  void publisher.flush().catch(report);
  return {
    runtime: created.runtime,
    hub,
    state,
    wake,
    async checkpoint(final = false): Promise<number> {
      if (final) {
        closing = true;
        await draining;
        await session.agent.waitForIdle();
      }
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
      unsubscribe();
      hub.closeAll();
      await created.runtime.dispose();
    },
  };
}
