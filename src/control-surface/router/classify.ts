import type { BlackboardDatabase } from "../../blackboard/db.ts";
import { getRecentConversationByWorkstream } from "../../blackboard/queries/messages.ts";
import { listOpenWorkstreams } from "../../blackboard/queries/workstreams.ts";
import type { WorkstreamRow } from "../../contracts/index.ts";
import { buildClassificationPrompt } from "../../prompts/classifier.ts";
import { type ClassifyResult, callGroqClassify } from "./groq-client.ts";

export type ClassificationResult = {
  workstream: WorkstreamRow | null;
  action: "matched" | "none";
};

export async function classifyMessage(
  message: string,
  db: BlackboardDatabase,
  apiKey: string,
): Promise<ClassificationResult> {
  const workstreams = listOpenWorkstreams(db);
  const recentConversation = getRecentConversationByWorkstream(db, 12, 4);
  const prompt = buildClassificationPrompt(
    message,
    workstreams,
    recentConversation,
  );
  console.log(
    "── [router] classifying ──\nworkstreams: %d open | message: %s\n── [/router] ──",
    workstreams.length,
    message,
  );

  let result: ClassifyResult;
  try {
    result = await callGroqClassify(apiKey, prompt);
  } catch (error) {
    console.error(
      `[router] Groq classification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { workstream: null, action: "none" };
  }

  // Try to match existing open workstream
  if (result.workstream_id) {
    const existing = workstreams.find((ws) => ws.id === result.workstream_id);
    if (existing) {
      return { workstream: existing, action: "matched" };
    }
    // LLM returned an id that doesn't exist — fall through to default
  }

  // No match — default agent will handle (and may create a workstream via tool)
  return { workstream: null, action: "none" };
}
