import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { getSessionById } from "../blackboard/query-sessions.ts";
import { loadConfig } from "../config/load-config.ts";
import type { ClaudeHookPayload, StreamRow } from "../contracts/index.ts";
import { directSessionMessage } from "../custom-tools/manage-session.ts";
import { git } from "../git.ts";
import { readJsonBody, sendJson } from "../routes/_shared.ts";
import { serveDirectoryCompletions } from "../routes/browser-directory-completions.ts";
import { serveRepositoryDiff } from "../routes/browser-pi-session-diff.ts";
import { serveStreamWorkspace } from "../routes/browser-pi-session-stream.ts";
import {
  decodeHistoryCursor,
  parseVisibleRowLimit,
  readStreamsHistoryFromSession,
  takePageEndingBeforeCursor,
} from "../streams/history.ts";
import { readTranscriptPage } from "../transcript/transcript.ts";
import { createCloudWorkerAgent, type WorkerBootstrap } from "./worker-agent.ts";

export async function startWorkerServer(
  bootstrap: WorkerBootstrap,
  port: number,
  host = "127.0.0.1",
) {
  const report = (error: unknown) =>
    console.error("Cloud worker:", error instanceof Error ? error.message : String(error));
  const worker = await createCloudWorkerAgent(bootstrap, report);
  const authorized = (req: http.IncomingMessage) => {
    const supplied = crypto
      .createHash("sha256")
      .update(req.headers.authorization ?? "")
      .digest();
    const expected = crypto.createHash("sha256").update(`Bearer ${bootstrap.token}`).digest();
    return crypto.timingSafeEqual(supplied, expected);
  };
  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) return sendJson(res, 401, { error: "Worker authentication required" });
    res.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const session = worker.runtime.session;
      if (req.method === "GET" && url.pathname === "/worker/health") {
        return sendJson(res, 200, {
          ok: true,
          streamId: bootstrap.streamId,
          generation: bootstrap.generation,
          piSessionId: session.sessionId,
          busy: session.isStreaming,
        });
      }
      if (req.method === "POST" && url.pathname.startsWith("/hook/")) {
        const body = await readJsonBody<ClaudeHookPayload>(req);
        await worker.hooks.accept(url.pathname.slice("/hook/".length), body);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/worker/transcript") {
        const body = await readJsonBody<{ sessionId: string; cursor?: string; limit?: number }>(
          req,
        );
        await worker.client.request("session", { id: body.sessionId });
        const transcript = worker.hooks.transcript(body.sessionId);
        return sendJson(
          res,
          200,
          transcript
            ? await readTranscriptPage(
                body.sessionId,
                transcript,
                body.cursor ?? "0",
                Math.max(1, Math.min(500, body.limit ?? 50)),
              )
            : { sessionId: body.sessionId, transcriptPath: null, oldestFirst: true, items: [] },
        );
      }
      if (req.method === "POST" && url.pathname === "/worker/direct") {
        const body = await readJsonBody<{ sessionId: string; text: string }>(req);
        if (typeof body.text !== "string" || !body.text.trim())
          throw new Error("Message text required");
        return sendJson(
          res,
          200,
          await directSessionMessage(
            {
              getSession: (id) =>
                worker.client.request<ReturnType<typeof getSessionById>>("session", { id }),
              config: loadConfig(),
            },
            body.sessionId,
            body.text,
          ),
        );
      }
      if (req.method === "POST" && url.pathname === "/worker/wake") {
        void worker.wake().catch(report);
        return sendJson(res, 202, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/worker/checkpoint") {
        const body = await readJsonBody<{ final?: boolean }>(req);
        return sendJson(res, 200, { version: await worker.checkpoint(body.final === true) });
      }
      if (req.method === "GET" && url.pathname === "/api/streams/history") {
        if (url.searchParams.get("piSessionId") !== bootstrap.piSessionId)
          return sendJson(res, 404, { error: "Session not assigned to this worker" });
        const before = url.searchParams.get("before");
        const cursor = before ? decodeHistoryCursor(before) : null;
        if (before && !cursor) return sendJson(res, 400, { error: "Invalid cursor" });
        const items = readStreamsHistoryFromSession(
          session.sessionManager,
          url.searchParams.get("surface") === "input" ? "input" : "agent",
        );
        const page = takePageEndingBeforeCursor(
          items,
          parseVisibleRowLimit(url.searchParams.get("limit")),
          cursor,
        );
        if (!page) return sendJson(res, 400, { error: "Invalid cursor" });
        return sendJson(res, 200, {
          ...page,
          historyPosition: worker.hub.historyPosition(session.sessionId),
        });
      }
      if (
        req.method === "GET" &&
        url.pathname === `/api/pi-sessions/${bootstrap.piSessionId}/stream`
      ) {
        const stream = await worker.client.request<StreamRow>("stream");
        let root: string | null = null;
        try {
          root = (await git(bootstrap.cwd, ["rev-parse", "--show-toplevel"])).trim();
        } catch {}
        return serveStreamWorkspace(
          res,
          { ...stream, repo_path: root, worktree_path: root },
          bootstrap.cwd,
          loadConfig().projectsDir,
        );
      }
      if (req.method === "GET" && url.pathname === "/api/directory-completions") {
        const base = url.searchParams.get("baseCwd");
        return serveDirectoryCompletions(
          base && path.isAbsolute(base) ? base : bootstrap.cwd,
          url.searchParams.get("query") ?? "",
          url.searchParams.get("directoriesOnly") === "true",
          res,
          { log: (message) => console.log(message) },
        );
      }
      if (
        req.method === "GET" &&
        url.pathname === `/api/pi-sessions/${bootstrap.piSessionId}/diff`
      ) {
        if (!bootstrap.baseRef) {
          res.writeHead(204);
          res.end();
          return;
        }
        return serveRepositoryDiff(bootstrap.cwd, bootstrap.baseRef, res, {
          log: (message) => console.log(message),
        });
      }
      if (
        url.pathname === `/api/pi-sessions/${bootstrap.piSessionId}/interrupt` &&
        req.method === "POST"
      ) {
        const settlement = session.abort();
        if (session.isBashRunning) session.abortBash();
        void settlement.catch(report);
        return sendJson(res, 200, {
          ok: true,
          piSessionId: bootstrap.piSessionId,
          signaledSessions: 0,
        });
      }
      if (url.pathname === "/worker/control" && req.method === "POST") {
        const body = await readJsonBody<Record<string, unknown>>(req);
        return sendJson(res, 200, await worker.control(body));
      }
      return sendJson(res, 404, { error: "Unknown worker operation" });
    } catch (error) {
      return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.on("upgrade", (request, socket: import("node:net").Socket, head) => {
    if (!worker.hub.handleUpgrade(request, socket, head, bootstrap.token)) socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    server,
    worker,
    async stop() {
      await worker.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bootstrapPath = process.argv[2];
  if (!bootstrapPath) throw new Error("Usage: pnpm cloud:worker <bootstrap.json> <port>");
  const port = Number(process.argv[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Explicit worker port required");
  const bootstrap = JSON.parse(await fs.readFile(bootstrapPath, "utf8")) as WorkerBootstrap;
  const running = await startWorkerServer(bootstrap, port);
  const stop = () => {
    void running.stop().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
