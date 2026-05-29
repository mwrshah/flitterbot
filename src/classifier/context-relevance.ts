import { buildContextRelevancePrompts } from "../prompts/context-relevance.ts";
import { callGroqJson } from "./groq-client.ts";

type ContextRelevanceResult = {
  relevant: boolean[];
};

export async function classifyContextRelevance(
  messages: { content: string; created_at: string }[],
  streamName: string,
  apiKey: string,
  agentContext?: string,
  logClassifierPrompt?: (message: string) => void,
): Promise<boolean[]> {
  const prompts = buildContextRelevancePrompts(messages, streamName, agentContext);
  logClassifierPrompt?.(`[context classifier] system prompt\n${prompts.systemPrompt}`);
  logClassifierPrompt?.(`[context classifier] user prompt\n${prompts.userPrompt}`);
  const result = await callGroqJson<ContextRelevanceResult>(apiKey, prompts);

  if (!Array.isArray(result.relevant) || result.relevant.length !== messages.length) {
    throw new Error(
      `Invalid context relevance response: expected ${messages.length} booleans, got ${JSON.stringify(result.relevant)}`,
    );
  }

  return result.relevant;
}
