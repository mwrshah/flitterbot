import type { BlackboardDatabase } from "../blackboard/db.ts";
import {
  getRecentConversationByWorkstream,
  getRecentDefaultConversation,
} from "../blackboard/query-messages.ts";
import { getLatestStreamCreatedAt, listOpenStreams } from "../blackboard/query-streams.ts";
import type { StreamRow } from "../contracts/index.ts";
import { buildClassificationPrompts } from "../prompts/classifier.ts";
import { type ClassifyResult, callGroqClassify } from "./groq-client.ts";

/**
 * Messages that unambiguously target the default agent — skip LLM classification.
 * Covers: explicit stream creation requests, /new-stream commands, and legacy "help me do" asks.
 */
const DEFAULT_AGENT_PATTERNS = [
  /^\s*\/new-stream\b/i,
  /^\s*(new|create|launch|start|open)\s+stream/i,
  /^\s*help me do\b/i,
];

function shouldShortCircuitToDefault(message: string): boolean {
  return DEFAULT_AGENT_PATTERNS.some((p) => p.test(message));
}

export type ClassificationResult = {
  stream: StreamRow | null;
  action: "matched" | "none";
};

export async function classifyMessage(
  message: string,
  db: BlackboardDatabase,
  apiKey: string,
  defaultPiSessionId?: string,
  logClassifierPrompt?: (message: string) => void,
): Promise<ClassificationResult> {
  // Fast-path: messages that clearly target the default agent skip LLM
  if (shouldShortCircuitToDefault(message)) {
    console.log("[router] short-circuit to default agent: %s", message.slice(0, 120));
    return { stream: null, action: "none" };
  }

  const streams = listOpenStreams(db);
  // Nothing to classify against — skip the Groq call entirely.
  if (streams.length === 0) {
    console.log("[router] short-circuit: no open streams, routing to default");
    return { stream: null, action: "none" };
  }

  const recentConversation = getRecentConversationByWorkstream(db, 4);
  const defaultBoundary = getLatestStreamCreatedAt(db);
  const defaultConversation = defaultPiSessionId
    ? getRecentDefaultConversation(db, defaultPiSessionId, 4, defaultBoundary)
    : [];
  const prompts = buildClassificationPrompts(
    message,
    streams,
    recentConversation,
    defaultConversation,
  );
  console.log(
    "[router] classifying: %d open streams | message: %s",
    streams.length,
    message.slice(0, 120),
  );
  logClassifierPrompt?.(`[router classifier] system prompt\n${prompts.systemPrompt}`);
  logClassifierPrompt?.(`[router classifier] user prompt\n${prompts.userPrompt}`);

  let result: ClassifyResult;
  try {
    result = await callGroqClassify(apiKey, prompts);
  } catch (error) {
    console.error(
      `[router] Groq classification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { stream: null, action: "none" };
  }

  // Try to match existing open stream
  if (result.stream_id) {
    const existing = streams.find((ws) => ws.id === result.stream_id);
    if (existing) {
      return { stream: existing, action: "matched" };
    }
    // LLM returned an id that doesn't exist — fall through to default
  }

  // No match — default agent will handle (and may create a stream via tool)
  return { stream: null, action: "none" };
}
