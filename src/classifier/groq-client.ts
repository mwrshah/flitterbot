import OpenAI from "openai";
import type { ClassifierPrompts } from "../prompts/classifier.ts";

const MODEL_ID = "openai/gpt-oss-120b";

let cachedClient: OpenAI | null = null;

/**
 * Resolve Groq API key from GROQ_API_KEY environment variable.
 */
export function resolveGroqApiKey(): string | undefined {
  return process.env.GROQ_API_KEY;
}

function getClient(apiKey: string): OpenAI {
  if (cachedClient) return cachedClient;
  cachedClient = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });
  return cachedClient;
}

export type ClassifyResult = {
  stream_id: string | null;
  reasoning: string;
};

const MAX_RETRIES = 3;

export async function callGroqClassify(
  apiKey: string,
  prompts: ClassifierPrompts,
): Promise<ClassifyResult> {
  const client = getClient(apiKey);

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: MODEL_ID,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompts.systemPrompt },
          { role: "user", content: prompts.userPrompt },
        ],
      });

      const text = response.choices[0]?.message?.content;

      if (!text) {
        console.warn(
          "[router] Groq response missing content (attempt %d/%d)",
          attempt,
          MAX_RETRIES,
        );
        lastError = new Error("Groq response missing content");
        continue;
      }

      let parsed: ClassifyResult;
      try {
        parsed = JSON.parse(text) as ClassifyResult;
      } catch (parseError) {
        console.warn(
          "[router] Failed to parse Groq JSON (attempt %d/%d): %s",
          attempt,
          MAX_RETRIES,
          parseError instanceof Error ? parseError.message : String(parseError),
        );
        lastError = parseError instanceof Error ? parseError : new Error(String(parseError));
        continue;
      }

      const result = {
        stream_id: parsed.stream_id || null,
        reasoning: parsed.reasoning || "",
      };
      if (attempt > 1) {
        console.log("[router] Groq classification succeeded on attempt %d", attempt);
      }
      return result;
    } catch (apiError) {
      console.warn(
        "[router] Groq API error (attempt %d/%d): %s",
        attempt,
        MAX_RETRIES,
        apiError instanceof Error ? apiError.message : String(apiError),
      );
      lastError = apiError instanceof Error ? apiError : new Error(String(apiError));
    }
  }

  // All retries exhausted
  throw lastError;
}

/**
 * Generic Groq JSON call — sends a prompt and returns the parsed JSON response.
 * Unlike callGroqClassify, this does not impose a specific return type.
 */
export async function callGroqJson<T>(apiKey: string, prompts: ClassifierPrompts): Promise<T> {
  const client = getClient(apiKey);

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: MODEL_ID,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompts.systemPrompt },
          { role: "user", content: prompts.userPrompt },
        ],
      });

      const text = response.choices[0]?.message?.content;
      if (!text) {
        lastError = new Error("Groq response missing content");
        continue;
      }

      return JSON.parse(text) as T;
    } catch (error) {
      console.warn(
        "[groq] JSON call error (attempt %d/%d): %s",
        attempt,
        MAX_RETRIES,
        error instanceof Error ? error.message : String(error),
      );
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError;
}

/** Reset cached client (for testing or key rotation). */
export function resetGroqClient(): void {
  cachedClient = null;
}
