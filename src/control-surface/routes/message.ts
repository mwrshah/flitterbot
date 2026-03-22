import type http from "node:http";
import type {
  DeliveryMode,
  MessageRequest,
  MessageResponse,
  MessageSource,
} from "../../contracts/index.ts";
import { classifyMessage } from "../router/classify.ts";
import { resolveGroqApiKey } from "../router/groq-client.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

export async function handleMessageRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  const body = await readJsonBody<MessageRequest>(req);
  if (!body.text || typeof body.text !== "string") {
    return sendJson(res, 400, { ok: false, error: "text is required" });
  }

  const source = normalizeSource(body.source);
  const deliveryMode: DeliveryMode = body.deliveryMode === "steer" ? "steer" : "followUp";
  const formatted = formatInboundMessage(body.text, source, body.metadata);

  // Direct-targeted session (web UI tab input) — skip router
  let workstreamMeta: Record<string, unknown> = {};
  if (body.targetSessionId) {
    workstreamMeta._targetSessionId = body.targetSessionId;
  } else if (source === "web" || source === "whatsapp") {
    // Router: classify human messages against workstreams (hooks/cron bypass)
    const classification = await routeMessage(runtime, body.text);
    if (classification) {
      workstreamMeta = classification.metadata;
    }
  }

  runtime.enqueue({
    text: formatted,
    source,
    metadata: { ...body.metadata, ...workstreamMeta },
    deliveryMode,
    images: Array.isArray(body.images) ? body.images : undefined,
  });

  const response: MessageResponse = { ok: true };
  return sendJson(res, 200, response);
}

async function routeMessage(
  runtime: ControlSurfaceRuntime,
  rawText: string,
): Promise<{ metadata: Record<string, unknown> } | null> {
  const { projectsDir } = runtime.config;

  try {
    const apiKey = resolveGroqApiKey();
    if (!apiKey) return null;
    const result = await classifyMessage(rawText, runtime.blackboard, apiKey, projectsDir);
    const meta: Record<string, unknown> = {
      router_action: result.action,
      router_is_work: result.isWorkMessage,
    };
    if (result.workstream) {
      meta.workstream_id = result.workstream.id;
      meta.workstream_name = result.workstream.name;
    }
    return { metadata: meta };
  } catch (error) {
    console.error(
      "[router] classification failed:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function normalizeSource(source?: string): MessageSource {
  switch (source) {
    case "whatsapp":
    case "hook":
    case "cron":
      return source;
    default:
      return "web";
  }
}

function formatInboundMessage(
  text: string,
  source: MessageSource,
  _metadata?: Record<string, unknown>,
): string {
  // Hook and cron messages are structured content — pass through unchanged
  if (source === "cron" || source === "hook") {
    return text;
  }
  // Web and WhatsApp: return raw user text (no source prefix or quote wrapping)
  return text;
}
