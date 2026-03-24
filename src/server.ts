// Suppress the node:sqlite ExperimentalWarning before any imports that use it.
const _origWarningListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  for (const listener of _origWarningListeners) (listener as (w: Error) => void)(warning);
});

import http from "node:http";
import {
  CONTROL_SURFACE_ENDPOINTS,
  type HookRouteEventName,
  ROUTE_EVENT_TO_HOOK_EVENT,
} from "./contracts/index.ts";
import { sendJson } from "./routes/_shared.ts";
import { handleBrowserPiHistoryRoute } from "./routes/browser-pi.ts";
import {
  handleBrowserSessionDetailRoute,
  handleBrowserSessionsRoute,
} from "./routes/browser-sessions.ts";
import { handleBrowserSkillsRoute } from "./routes/browser-skills.ts";
import { handleBrowserTranscriptRoute } from "./routes/browser-transcript.ts";
import { handleCronTickRoute } from "./routes/cron-tick.ts";
import { handleDirectSessionMessageRoute } from "./routes/direct-session-message.ts";
import { handleHookRoute } from "./routes/hooks.ts";
import { handleMessageRoute } from "./routes/message.ts";
import { handleRuntimeWhatsAppRoute } from "./routes/runtime-whatsapp.ts";
import { handleStatusRoute } from "./routes/status.ts";
import { handleStopRoute } from "./routes/stop.ts";
import { ControlSurfaceRuntime } from "./runtime.ts";

const runtime = new ControlSurfaceRuntime();

const server = http.createServer(async (req, res) => {
  applyCorsHeaders(res);
  if ((req.method ?? "GET") === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  try {
    await routeRequest(req, res);
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    runtime.log(`unhandled route error: ${detail}`);
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { ok: false, error: message });
  }
});

runtime.attachServer(server);

server.on("upgrade", (req, socket: import("node:net").Socket, head) => {
  const handled = runtime.handleUpgrade(req, socket, head);
  if (!handled) socket.destroy();
});

process.on("SIGTERM", () => {
  void runtime.stop("sigterm").finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void runtime.stop("sigint").finally(() => process.exit(0));
});
process.on("uncaughtException", (error) => {
  console.error(error);
  void runtime.stop("uncaught_exception", true).finally(() => process.exit(1));
});
process.on("unhandledRejection", (error) => {
  console.error(error);
  void runtime.stop("unhandled_rejection", true).finally(() => process.exit(1));
});

await runtime.start();
server.listen(runtime.config.controlSurfacePort, runtime.config.controlSurfaceHost, () => {
  console.log(
    `Autonoma control surface listening on http://${runtime.config.controlSurfaceHost}:${runtime.config.controlSurfacePort}`,
  );
});

function applyCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

async function routeRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(
    req.url ?? "/",
    `http://${runtime.config.controlSurfaceHost}:${runtime.config.controlSurfacePort}`,
  );
  const pathname = url.pathname;
  const segments = pathname.split("/").filter(Boolean);

  if (
    method === CONTROL_SURFACE_ENDPOINTS.status.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.status.path
  ) {
    return handleStatusRoute(runtime, req, res);
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.message.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.message.path
  ) {
    return handleMessageRoute(runtime, req, res);
  }
  if (method === "POST" && segments[0] === "hook" && segments[1]) {
    const eventName = segments[1] as HookRouteEventName;
    if (eventName in ROUTE_EVENT_TO_HOOK_EVENT) {
      return handleHookRoute(runtime, req, res, eventName);
    }
    runtime.log(`hook ${segments[1]}: unknown event, rejecting`);
    return sendJson(res, 404, { ok: false, error: `Unknown hook route event: ${segments[1]}` });
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.stop.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.stop.path
  ) {
    return handleStopRoute(runtime, req, res);
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.cronTick.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.cronTick.path
  ) {
    return handleCronTickRoute(runtime, req, res);
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.sessions.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.sessions.path
  ) {
    return handleBrowserSessionsRoute(runtime, req, res);
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.piHistory.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.piHistory.path
  ) {
    return handleBrowserPiHistoryRoute(runtime, req, res);
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.skills.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.skills.path
  ) {
    return handleBrowserSkillsRoute(runtime, req, res);
  }
  if (
    method === "GET" &&
    segments[0] === "api" &&
    segments[1] === "sessions" &&
    segments[2] &&
    segments[3] === "transcript"
  ) {
    return handleBrowserTranscriptRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (method === "GET" && segments[0] === "api" && segments[1] === "sessions" && segments[2]) {
    return handleBrowserSessionDetailRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (method === "POST" && segments[0] === "sessions" && segments[1] && segments[2] === "message") {
    return handleDirectSessionMessageRoute(runtime, req, res, decodeURIComponent(segments[1]));
  }
  if (
    (method === CONTROL_SURFACE_ENDPOINTS.runtimeWhatsAppStart.method &&
      pathname === CONTROL_SURFACE_ENDPOINTS.runtimeWhatsAppStart.path) ||
    (method === CONTROL_SURFACE_ENDPOINTS.runtimeWhatsAppStop.method &&
      pathname === CONTROL_SURFACE_ENDPOINTS.runtimeWhatsAppStop.path)
  ) {
    return handleRuntimeWhatsAppRoute(
      runtime,
      req,
      res,
      pathname.endsWith("/start") ? "start" : "stop",
    );
  }

  return sendJson(res, 404, { ok: false, error: `No route for ${method} ${pathname}` });
}
