export function buildContextRelevancePrompt(
  messages: { content: string; created_at: string }[],
  workstreamName: string,
): string {
  const numberedMessages = messages
    .map((m, i) => `[Message ${i + 1}] (${m.created_at})\n${m.content}`)
    .join("\n\n");

  return `You are a context-relevance classifier for a software development assistant.

A new workstream is being created called "${workstreamName}".
Below are the user's recent messages to the default agent (before the workstream existed).

Determine which messages are relevant to the workstream being created. A message is relevant if it discusses the same task, topic, or feature that the workstream will address.

## Messages
${numberedMessages}

## Rules
1. Return a JSON object with a single field "relevant" — an array of booleans, one per message, in the same order.
2. A message is relevant if it discusses the same task/topic as the workstream "${workstreamName}".
3. The final message (which triggered workstream creation) should almost always be marked true.
4. Unrelated messages (greetings, questions about other topics, status checks for other work) should be false.
5. When in doubt, include the message (true) — more context is better than less.

## Response format
Respond with ONLY a JSON object. No other text. Example:
\`\`\`json
{"relevant": [false, true, true]}
\`\`\``;
}
