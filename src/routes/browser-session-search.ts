import type http from "node:http";
import type { SessionSearchResponse } from "../contracts/control-surface-api.ts";
import { withFileFinder } from "../file-finder/manager.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { searchSessionFiles } from "../session-file-search.ts";
import { sendJson } from "./_shared.ts";

export async function handleBrowserSessionSearchRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const query = (url.searchParams.get("query") ?? "").trim();
  if (!query) {
    sendJson(res, 200, { matches: [] } satisfies SessionSearchResponse);
    return;
  }

  runtime.log(`[jsonl] query="${query}"`);
  const result = await withFileFinder(
    runtime.config.controlSurfaceSessionsDir,
    async (finder) => {
      const scan = await finder.waitForScan(5_000);
      if (!scan.ok || !scan.value) throw new Error("FFF session index did not become ready");
      return searchSessionFiles(
        runtime.blackboard,
        finder,
        runtime.config.controlSurfaceSessionsDir,
        query,
      );
    },
    (sessionsDir) => runtime.log(`[jsonl] index mount dir=${sessionsDir}`),
  );
  sendJson(res, 200, result satisfies SessionSearchResponse);
}
