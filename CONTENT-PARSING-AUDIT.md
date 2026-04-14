# Content-Parsing Audit

Audit of all instances where structured data is embedded into message content strings, then parsed back out (or displayed as-is with metadata baked in).

## True Hacks

These embed or extract structured metadata in/from content strings. Each should be replaced with a proper structured field.

### 1. Stream Header in Prompt Content

**File:** `src/streams/format-stream-prompt.ts:11`
```ts
const header = `[Stream: "${streamName}" (${streamId})]`;
```
- **What:** Embeds stream name + ID as a bracket-prefix header into the prompt text sent to Claude Code sessions
- **Used by:** `session-manager.ts:414` (`buildStreamPrompt()`), `runtime.ts:1059` (orchestrator stream context)
- **Verdict:** HACK — stream name/ID are structured metadata being embedded into free text

### 2. Stream Prefix Regex Parse in Surface

**File:** `web/src/components/surface.tsx:54-59`
```ts
const STREAM_PREFIX_RE = /^\[Stream: "([^"]+)" \([0-9a-f-]+\)\]\s*(?:\[NEW\]\s*)?/;

function parseStreamPrefix(content: string): { streamName: string; cleanContent: string } | null {
  const match = content.match(STREAM_PREFIX_RE);
  if (!match) return null;
  return { streamName: match[1] ?? "", cleanContent: content.slice(match[0]!.length) };
}
```
- **What:** Regex-parses the `[Stream: "name" (uuid)]` prefix back out of message content to extract stream name for display
- **Used for:** Rendering a stream name badge on Surface view entries
- **Verdict:** HACK — the structured `streamName` field already exists on `ChatTimelineMessage` and `SurfaceEntry`
- **Note:** Already being fixed on this branch

### 3. Source Prefix Extraction from History Messages

**File:** `src/streams/history.ts:20-29`
```ts
const SOURCE_PREFIX_RE = /^\[(web|whatsapp|hook|cron|init|agent|stream_outbound)\]\s*/i;

function extractSource(text: string): { source: MessageSource | undefined; content: string } {
  const match = SOURCE_PREFIX_RE.exec(text);
  if (!match) return { source: undefined, content: text };
  return {
    source: match[1]!.toLowerCase() as MessageSource,
    content: text.slice(match[0].length),
  };
}
```
- **What:** Parses `[web]`, `[whatsapp]`, etc. bracket prefixes from the beginning of message content to extract message source
- **Used in:** `pushMessage()` at line 77 — applied during JSONL history file parsing for `role === "user"` messages
- **Verdict:** HACK (backward-compat). Comment on line 17 says these are "old session JSONL files." The current `formatPromptWithContext` no longer embeds these prefixes, but old persisted data still has metadata baked into content.

### 4. Stream Name Prefix in WhatsApp Surface Messages

**File:** `src/runtime.ts:802-810`
```ts
const surfaceText =
  managed.role === "orchestrator" && managed.streamName
    ? `[${managed.streamName}] ${finalText}`
    : finalText;

await this.sendWhatsAppCommand({
  command: "send",
  text: `*Flitterbot:*\n---\n${surfaceText}`,
});
```
- **What:** Prepends `[streamName]` to outbound orchestrator messages when surfacing to WhatsApp. Also wraps in `*Flitterbot:*\n---\n` markdown
- **Verdict:** HACK — stream name is structured metadata embedded in display text. WhatsApp has no way to parse it back, but it mixes metadata into content.

### 5. Stream Name Label in Web-to-WhatsApp Mirror

**File:** `src/runtime.ts:1600-1603`
```ts
const wsLabel = routerMeta.stream_name ? `[${routerMeta.stream_name}] ` : "";
await this.sendWhatsAppCommand({
  command: "send",
  text: `${wsLabel}*User (web):*\n---\n${payload.text}`,
});
```
- **What:** When mirroring a web user's message to WhatsApp, prepends `[stream_name]` and `*User (web):*` to the content
- **Verdict:** HACK — same pattern as #4, structured metadata embedded as text prefix

## Stale/Broken Tests

### 6. Context Relevance Test Expects Removed Format

**File:** `src/classifier/context-relevance.test.ts:44,57,69`
```ts
expect(result).toContain('[Stream: "my-ws" (ws-123)] [NEW]');
expect(result).toContain('[Stream: "my-feature" (ws-456)] [NEW]');
expect(result).toContain('[Stream: "empty-ws" (ws-000)] [NEW]');
```
- **What:** Tests expect `[Stream: ...] [NEW]` format that no longer exists in `formatStreamPrompt`
- **Verdict:** Stale tests referencing a removed `[NEW]` marker

## Borderline (Not True Hacks)

These parse content-like fields but are either LLM prompt formatting or fuzzy field normalization — not round-tripped structured data.

### 7. Tool Status Detection via String Sniffing

**File:** `src/transcript/transcript.ts:81-101`
```ts
function detectToolStatus(record: RawTranscriptEntry): TranscriptToolStatus | null {
  const candidate = [record.status, record.tool_status, record.toolStatus].find(
    (value) => typeof value === "string" && value.trim(),
  ) as string | undefined;
  const normalized = candidate.toLowerCase();
  if (normalized.includes("start")) return "started";
  if (normalized.includes("fail") || normalized.includes("error")) return "failed";
  if (normalized.includes("complete") || normalized.includes("finish") || normalized.includes("success")) return "completed";
  return null;
}
```
- **What:** Fuzzy string matching on status fields to normalize into an enum
- **Verdict:** BORDERLINE — parsing structured fields, but with fuzzy matching rather than a fixed vocabulary. Defensively necessary given external data format.

### 8. Context Relevance Prompt Message Tags

**File:** `src/prompts/context-relevance.ts:7-9`
```ts
const tag = i === lastIdx ? `[Message ${i + 1} — CURRENT]` : `[Message ${i + 1}]`;
return `${tag} (${m.created_at})\n${m.content}`;
```
- **What:** Formats messages with numbered bracket tags + timestamps for LLM classification prompt
- **Verdict:** BORDERLINE — LLM prompt construction where structured tags in text is the natural interface. The LLM response is parsed as JSON, not parsed back from embedded content.

### 9. Classifier Prompt Source Labels

**File:** `src/prompts/classifier.ts:57-59`
```ts
const messageLines = snippets.map((s) => {
  const label = s.direction === "outbound" ? "Agent" : "User";
  return `    [${s.source}] ${label}: ${truncate(collapseNewlines(s.content), 200)} (${relativeTime(s.created_at)})`;
});
```
- **What:** Formats conversation snippets with `[source]` labels, direction, timestamps for LLM classifier
- **Verdict:** BORDERLINE — prompt formatting for LLM, returns structured JSON. Not round-tripped.

## Legitimate (Not Hacks)

These use regex/string parsing for their intended purpose (rendering, security, protocol parsing, UI).

| File | Pattern | Purpose |
|------|---------|---------|
| `web/src/pi-web-ui/chat-components.ts:103-108` | `decodeHtmlEntities()` with `.replace()` | HTML entity decoding for markdown rendering |
| `web/src/pi-web-ui/chat-components.ts:193-208` | `.replace()` on rendered HTML | Adding `target="_blank"` to links, transforming code blocks |
| `web/src/pi-web-ui/chat-components.ts:515-517` | `l.startsWith("- ")` / `l.startsWith("+ ")` | Diff line coloring in tool output |
| `web/src/components/common/message-input.tsx:155-174` | `/\s/.test()` | Word boundary detection for autocomplete |
| `web/src/routes/streams.$sessionId.tsx:33` | `/404\|not found/i.test(error.message)` | Error handling |
| `src/claude-sessions/tmux.ts:11-12` | ANSI/Unicode regex for spinner chars | Terminal screen-scraping for inference state detection |
| `src/ws/hub.ts:175`, `src/routes/_shared.ts:23` | `/^Bearer\s+(.+)$/i` | Standard HTTP auth header parsing |
| `src/blackboard/tool-query-blackboard.ts:135` | `/^(select\|pragma)\b/i` | SQL query safety validation |
| `src/streams/format-prompt.ts:7-9` | `return item.text` | Was embedding, now clean passthrough |
| `web/src/prompts/datetime.ts:18` | `[Now: ...]` in prompts | Write-only LLM context, never parsed back |

## Summary

| Category | Count | Items |
|----------|-------|-------|
| **True hacks** (embed/extract structured data in content) | 5 | #1, #2, #3, #4, #5 |
| **Stale tests** | 1 | #6 |
| **Borderline** (LLM prompts / fuzzy field parsing) | 3 | #7, #8, #9 |
| **Legitimate** | 10 | See table above |

The core pattern: **stream identity** (name, ID) and **message source** (web, whatsapp, etc.) are the two types of structured data most commonly embedded into content strings. Hacks #1-#5 all involve one or both of these. The fix direction is clear — these should flow through dedicated fields on message/event types, not be baked into text.
