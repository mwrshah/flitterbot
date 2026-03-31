import type { BlackboardDatabase } from "../blackboard/db.ts";
import {
  getRecentConversationByWorkstream,
  getRecentDefaultConversation,
} from "../blackboard/query-messages.ts";
import { listOpenStreams } from "../blackboard/query-streams.ts";
import type { StreamRow } from "../contracts/index.ts";
import { buildClassificationPrompt } from "../prompts/classifier.ts";
import { type ClassifyResult, callGroqClassify } from "./groq-client.ts";

export type ClassificationResult = {
  stream: StreamRow | null;
  action: "matched" | "none";
};

export async function classifyMessage(
  message: string,
  db: BlackboardDatabase,
  apiKey: string,
  defaultPiSessionId?: string,
): Promise<ClassificationResult> {
  const streams = listOpenStreams(db);
  const recentConversation = getRecentConversationByWorkstream(db, 12, 4);
  const defaultConversation = defaultPiSessionId
    ? getRecentDefaultConversation(db, defaultPiSessionId, 10)
    : [];
  const prompt = buildClassificationPrompt(
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

  let result: ClassifyResult;
  try {
    result = await callGroqClassify(apiKey, prompt);
  } catch (error) {
    console.error(
      `[router] Groq classification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { stream: null, action: "none" };
  }

  // Try to match existing open stream
  if (result.workstream_id) {
    const existing = streams.find((ws) => ws.id === result.workstream_id);
    if (existing) {
      return { stream: existing, action: "matched" };
    }
    // LLM returned an id that doesn't exist — fall through to default
  }

  // No match — default agent will handle (and may create a stream via tool)
  return { stream: null, action: "none" };
}
