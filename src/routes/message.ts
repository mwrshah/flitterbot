import type http from "node:http";
import { classifyMessage } from "../classifier/classify.ts";
import { resolveGroqApiKey } from "../classifier/groq-client.ts";
import type {
  DeliveryMode,
  MessageMetadata,
  MessageRequest,
  MessageResponse,
  MessageSource,
  WorkstreamRoutingMeta,
} from "../contracts/index.ts";
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

  // Only web and whatsapp sources reach this handler (normalizeSource guarantees this).
  // Direct-targeted session (web UI tab input) — skip router
  let workstreamMeta: WorkstreamRoutingMeta = {};
  if (body.targetSessionId) {
    workstreamMeta._targetSessionId = body.targetSessionId;
  } else {
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
): Promise<{ metadata: WorkstreamRoutingMeta } | null> {
  try {
    const apiKey = resolveGroqApiKey();
    if (!apiKey) return null;
    const defaultPiSessionId = runtime.sessionManager.getDefault()?.piSessionId;
    const result = await classifyMessage(rawText, runtime.blackboard, apiKey, defaultPiSessionId);
    const meta: WorkstreamRoutingMeta = {
      router_action: result.action,
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
      return source;
    default:
      return "web";
  }
}

function formatInboundMessage(
  text: string,
  _source: MessageSource,
  _metadata?: MessageMetadata,
): string {
  return text;
}
