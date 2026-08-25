import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FlitterbotConfig } from "../config/load-config.ts";
import { buildContextRelevancePrompts } from "../prompts/context-relevance.ts";
import { inferClassifierJson } from "./inference.ts";

type ContextRelevanceResult = {
  relevant: boolean[];
};

export async function classifyContextRelevance(
  messages: { content: string; created_at: string }[],
  streamName: string,
  modelRuntime: ModelRuntime,
  config: FlitterbotConfig,
  agentContext?: string,
  logClassifierPrompt?: (message: string) => void,
): Promise<boolean[]> {
  const prompts = buildContextRelevancePrompts(messages, streamName, agentContext);
  logClassifierPrompt?.(`[context classifier] system prompt\n${prompts.systemPrompt}`);
  logClassifierPrompt?.(`[context classifier] user prompt\n${prompts.userPrompt}`);
  const inferred = await inferClassifierJson(modelRuntime, config, prompts);
  if (
    !inferred ||
    typeof inferred !== "object" ||
    Array.isArray(inferred) ||
    Object.keys(inferred).length !== 1 ||
    !("relevant" in inferred)
  ) {
    throw new Error(`Invalid context relevance response: ${JSON.stringify(inferred)}`);
  }

  const result = inferred as ContextRelevanceResult;
  if (
    !Array.isArray(result.relevant) ||
    result.relevant.length !== messages.length ||
    !result.relevant.every((value) => typeof value === "boolean")
  ) {
    throw new Error(
      `Invalid context relevance response: expected ${messages.length} booleans, got ${JSON.stringify(result.relevant)}`,
    );
  }

  return result.relevant;
}
