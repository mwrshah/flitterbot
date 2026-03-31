export function buildContextRelevancePrompt(
  messages: { content: string; created_at: string }[],
  streamName: string,
): string {
  const lastIdx = messages.length - 1;
  const numberedMessages = messages
    .map((m, i) => {
      const tag = i === lastIdx ? `[Message ${i + 1} — CURRENT]` : `[Message ${i + 1}]`;
      return `${tag} (${m.created_at})\n${m.content}`;
    })
    .join("\n\n");

  return `You are a context-relevance classifier for a software development assistant.

A new stream is being created called "${streamName}".
Below are the user's recent messages to the default agent (before the stream existed).

Determine which messages are *directly* relevant to the stream being created. A message is relevant if it seems to be a continuation of the same task which led to the creation of the stream but was being  discussed from before the exact current message that started / opened the stream came through. Be conservative in marking messages as relevant. Do so when you are very sure and especially map if current message is a bit ambiguous and prior messages need to be considered to show the  full picture.

## Messages
${numberedMessages}

## Rules
1. Return a JSON object with a single field "relevant" — an array of booleans, one per message, in the same order.
2. A message is relevant if it discusses the same task/topic as the stream "${streamName}".
3. The message tagged "CURRENT" (which triggered stream creation) MUST be marked true.
4. Unrelated messages (greetings, questions about other topics, status checks for other work) should be false.
5. When in doubt, include the message (true) — more context is better than less.

## Response format
Respond with ONLY a JSON object. No other text. Example:
\`\`\`json
{"relevant": [false, true, true]}
\`\`\``;
}
