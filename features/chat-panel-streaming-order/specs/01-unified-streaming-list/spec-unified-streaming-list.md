# Spec: Unified Streaming List

## Goal

Eliminate the two-layer rendering model (completed messages above, streaming below) and replace it with a single `<message-list>` that renders all content — completed and streaming — in chronological order, with the streaming message occupying its natural position at the tail.

## Functional Requirements

### FR1: Single rendering surface

Delete `PiStreamingMessage` as a separate React component. The `<message-list>` Lit component becomes the sole renderer of all chat content. ChatPanel no longer places two sibling elements in the message area — only `<PiMessageList>`.

### FR2: Streaming slot on `<message-list>`

The Lit `MessageList` component gains a `streamingMessage` property (type `AssistantMessage | null`). When set, it renders a single `<assistant-message>` element after all `repeat()` items, with `.isStreaming=${true}`. When null, no streaming element is rendered.

This streaming element lives **outside** the `repeat()` directive. Setting or updating `streamingMessage` must not trigger re-evaluation of the repeated item templates. This is the key performance constraint — the `repeat()` block only re-runs when the `messages` array changes (on React re-render), while the streaming slot updates at 60+ Hz via imperative property assignment.

### FR3: Imperative update path via PiMessageList ref

`PiMessageList` exposes an imperative handle via `useImperativeHandle`:

```ts
type PiMessageListHandle = {
  updateStreaming(msg: AssistantMessage): void;
  clearStreaming(): void;
};
```

`updateStreaming` sets `streamingMessage` on the underlying `<message-list>` element. `clearStreaming` sets it to null. ChatPanel calls these via ref from the streaming callback effect — the same place it currently calls `streamingRef.current?.update()` and `streamingRef.current?.clear()`.

### FR4: Zero React re-renders during streaming

The streaming callback effect in ChatPanel (the `useEffect` that registers `onStreamingDelta`, `onStreamingThinkingDelta`, `onStreamingToolCall`) pushes deltas to the `PiMessageList` ref. No React state is set during streaming deltas. React only re-renders on:
- `message_end` — completed message appended to `appendedItems`, triggers `useSyncExternalStore`
- `tool_execution_start` / `tool_execution_end` — tool events appended to `appendedItems`
- `turn_end` — divider appended

The `isStreaming` boolean state in ChatPanel remains for controlling UI elements (e.g., input disabled state), but it no longer drives any rendering logic inside the message list.

### FR5: Remove `hidePendingToolCalls`

Remove the `hidePendingToolCalls` property from `AssistantMessage` and the corresponding logic that skips rendering pending tool calls when streaming is active.

**Why it existed:** The two-layer model showed streaming tool calls in the bottom layer (PiStreamingMessage) while the same tool call appeared in the top layer (completed assistant message via `timelineToAgentMessages` look-ahead). Hiding pending tool calls in the completed layer prevented duplicates.

**Why it's no longer needed:** With a single rendering surface, the streaming `<assistant-message>` at the tail is the only place an in-progress tool call appears. Completed assistant messages in the `repeat()` block only contain tool calls that have already been finalized (message_end has fired), so there's no duplication risk.

Also remove `pendingToolCallsFromTimeline` from `pi-web-ui-bridge.ts` and the `pendingToolCalls` prop threading through ChatPanel and PiMessageList, since nothing consumes it after `hidePendingToolCalls` is gone. The `pendingToolCalls` set on `<message-list>` and `<assistant-message>` stays — it drives the pending spinner on `<tool-message>`. But it can be computed inside the Lit component from the messages array (tool starts without matching tool ends) rather than threaded from React.

### FR6: Flush transition — no flash on `message_end`

The critical moment: `message_end` fires, the completed assistant message is added to `appendedItems`, and streaming state clears. In the current architecture this causes a flash because the streaming element hides synchronously while React hasn't yet committed the completed message.

The new approach:

1. `message_end` handler in `use-pi-ws-handler.ts` adds the completed message to `appendedItems` and clears streaming state (unchanged).
2. The streaming callbacks fire `cb(null, null)` which calls `clearStreaming()` on the PiMessageList ref.
3. `clearStreaming()` does NOT immediately remove the streaming element. Instead, it marks it as "pending flush" — the streaming `<assistant-message>` stays visible with its last content.
4. When React re-renders `PiMessageList` (triggered by `appendedItems` change via `useSyncExternalStore`), the new `messages` array now includes the completed assistant message. At this point, the pending-flush streaming element is removed.

This ensures the user always sees content in the streaming slot until the completed version renders in the `repeat()` block. No gap, no flash.

**Implementation approach:** The `<message-list>` Lit component can track a `_pendingFlush` boolean. When `streamingMessage` is set to null while `_pendingFlush` is false, it clears immediately. When the host calls a `flushStreaming()` method (or sets `streamingMessage = null`), it keeps the last streaming element visible. On the next `messages` property update (which triggers `render()`), it clears the stale streaming element.

### FR7: Chronological ordering

All content appears in WS arrival order:
- Completed assistant messages render via `repeat()` from the `messages` array
- Tool execution starts/ends render via `repeat()` (they're in `messages` via `timelineToAgentMessages`)
- The streaming assistant message renders after all `repeat()` items

Since the streaming message is always the most recent thing happening in the conversation, its position at the tail of the list IS the correct chronological position. No sorting or reordering logic is needed.

### FR8: `buildStreamingAssistantMessage` remains unchanged

The function that combines `currentChunkedText`, `currentThinking`, and `currentToolCalls` into an `AssistantMessage` object continues to work as-is. The only change is where the result goes: instead of `streamingRef.current?.update(msg)` targeting `PiStreamingMessage`, it targets `messageListRef.current?.updateStreaming(msg)` targeting `PiMessageList`.

## Files Changed

| File | Change |
|---|---|
| `chat-panel.tsx` | Replace `streamingRef` (PiStreamingMessage) with `messageListRef` (PiMessageList). Remove `PiStreamingMessage` from JSX. Remove `pendingToolCalls` memo. Streaming callbacks target `messageListRef.current?.updateStreaming()`. |
| `pi-streaming-message.tsx` | **Delete.** |
| `pi-message-list.tsx` | Add `forwardRef` + `useImperativeHandle` exposing `updateStreaming`/`clearStreaming`. Forward these to the `<message-list>` element's `streamingMessage` property. |
| `chat-components.ts` (`MessageList`) | Add `streamingMessage` property. Render streaming `<assistant-message>` after `repeat()` block. Implement flush-transition logic. Remove `hidePendingToolCalls` pass-through. |
| `chat-components.ts` (`AssistantMessage`) | Remove `hidePendingToolCalls` property and the `continue` guard in the render loop. |
| `pi-web-ui-bridge.ts` | Remove `pendingToolCallsFromTimeline`. `buildStreamingAssistantMessage` and `timelineToAgentMessages` unchanged. |

## Risks

**Lit `repeat()` key stability.** The streaming element must not interfere with `repeat()` keying. Since it's rendered outside the directive (after the `repeat()` output in the template), Lit treats it as a separate template part — no key conflict.

**`pendingToolCalls` computation.** Moving this into the Lit component means `<message-list>` derives it from its `messages` array. This is a simple scan (tool starts without matching tool ends) and avoids threading a React-computed Set through props. If this turns out to be expensive on large histories, it can be memoized inside the Lit component's `buildRenderItems`.

**Flash timing.** The flush transition relies on React's re-render happening "soon" after `appendedItems` updates. Since `useSyncExternalStore` triggers a synchronous re-render in React 18+, this should be within the same frame or next microtask. If there's a visible gap in practice, a `requestAnimationFrame` guard can be added.
