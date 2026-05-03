import type { ClassifierPrompts } from "./classifier.ts";

export const CONTEXT_RELEVANCE_SYSTEM_PROMPT = `You are a context-relevance classifier for a software development assistant.

A new stream is being created. Decide which recent user messages from the default agent are directly relevant context for that new stream.

Rules:
1. Return a JSON object with a single field "relevant" — an array of booleans, one per message, in the same order.
2. A message is relevant if it discusses the same task/topic as the stream purpose.
3. The message tagged "CURRENT" triggered stream creation and MUST be marked true.
4. Unrelated messages, greetings, questions about other topics, and status checks for other work should be false.
5. Be conservative, but when the current message is ambiguous and prior messages carry the actual task context, include those prior messages.
6. Omit vague user messages that do not map directly to the current stream's purpose in a 1:1 way, including context that might be relevant to other streams (for example: "create multiple streams to work on...", "launch investigations into x, y and z").
7. Do not include a message merely because it mentions streams or stream creation; include it only when its content belongs in this specific new stream's initial context.

Respond with ONLY a JSON object. No other text.`;

export function buildContextRelevancePrompts(
  messages: { content: string; created_at: string }[],
  streamName: string,
  agentContext?: string,
): ClassifierPrompts {
  const lastIdx = messages.length - 1;
  const numberedMessages = messages
    .map((m, i) => {
      const tag = i === lastIdx ? `[Message ${i + 1} — CURRENT]` : `[Message ${i + 1}]`;
      return `${tag} (${m.created_at})\n${m.content}`;
    })
    .join("\n\n");

  const purposeBlob = agentContext?.trim() ? `## Stream Purpose\n${agentContext.trim()}\n\n` : "";

  return {
    systemPrompt: CONTEXT_RELEVANCE_SYSTEM_PROMPT,
    userPrompt: `A new stream is being created called "${streamName}".

${purposeBlob}## Messages
Below are recent user messages to the default agent before the stream existed. Choose only the user messages that should be included in the new stream's initial prompt.

${numberedMessages}

## Response format
{"relevant": [false, true, true]}`,
  };
}
