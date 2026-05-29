import type http from "node:http";
import { classifyMessage } from "../classifier/classify.ts";
import { resolveGroqApiKey } from "../classifier/groq-client.ts";
import type {
  DeliveryMode,
  MessageMetadata,
  MessageRequest,
  MessageResponse,
  MessageSource,
  StreamRoutingMeta,
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

  let streamMeta: StreamRoutingMeta = {};
  if (body.targetPiSessionId) {
    streamMeta._targetSessionId = body.targetPiSessionId;
  } else {
    const classification = await routeMessage(runtime, body.text);
    if (classification) {
      streamMeta = classification.metadata;
    }
  }

  runtime.enqueue({
    text: formatted,
    source,
    metadata: { ...body.metadata, ...streamMeta },
    deliveryMode,
    images: Array.isArray(body.images) ? body.images : undefined,
  });

  const response: MessageResponse = { ok: true };
  return sendJson(res, 200, response);
}

async function routeMessage(
  runtime: ControlSurfaceRuntime,
  rawText: string,
): Promise<{ metadata: StreamRoutingMeta } | null> {
  try {
    const apiKey = resolveGroqApiKey();
    if (!apiKey) return null;
    const defaultPiSessionId = runtime.sessionManager.getDefault()?.piSessionId;
    const result = await classifyMessage(
      rawText,
      runtime.blackboard,
      apiKey,
      defaultPiSessionId,
      runtime.log.bind(runtime),
    );
    const meta: StreamRoutingMeta = {
      router_action: result.action,
    };
    if (result.stream) {
      meta.stream_id = result.stream.id;
      meta.stream_name = result.stream.name;
    }
    runtime.log(
      result.stream
        ? `router: matched stream "${result.stream.name}" (${result.stream.id.slice(0, 8)})`
        : "router: no stream match",
    );
    return { metadata: meta };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[router] classification failed:", msg);
    runtime.log(`router: classification failed — ${msg}`);
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
