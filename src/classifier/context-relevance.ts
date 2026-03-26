import { buildContextRelevancePrompt } from "../prompts/context-relevance.ts";
import { callGroqJson } from "./groq-client.ts";

type ContextRelevanceResult = {
  relevant: boolean[];
};

/**
 * Classify which messages are relevant to a workstream being created.
 * Returns a boolean array (same length as messages) indicating relevance.
 * Throws on Groq failure — caller should handle fallback.
 */
export async function classifyContextRelevance(
  messages: { content: string; created_at: string }[],
  workstreamName: string,
  apiKey: string,
): Promise<boolean[]> {
  const prompt = buildContextRelevancePrompt(messages, workstreamName);
  const result = await callGroqJson<ContextRelevanceResult>(apiKey, prompt);

  if (!Array.isArray(result.relevant) || result.relevant.length !== messages.length) {
    throw new Error(
      `Invalid context relevance response: expected ${messages.length} booleans, got ${JSON.stringify(result.relevant)}`,
    );
  }

  return result.relevant;
}
