# WebSocket Streaming Performance

## Problem
Every text_delta from the WebSocket triggers a full React re-render cycle: new Map creation in the store, snapshot rebuild, useSyncExternalStore notification, and O(n) timeline recomputation — all for a single character of streaming text. This causes unnecessary CPU work and potential jank during LLM response streaming.

## Goals
- Zero React re-renders during active text streaming
- Sub-millisecond delta-to-pixel latency
- Single React reconciliation when stream completes
- No new dependencies

## Architecture
The fix is a hybrid DOM + state sync pattern:
- During streaming: accumulate deltas in a mutable variable, push directly to the web component DOM element (bypassing React)
- On stream end: sync final text to React state, triggering a single render that adds the completed message to the memoized message list

Key insight: PiStreamingMessage already uses imperative DOM (sets properties on a Lit web component). We just need to stop routing text_delta through React state entirely.

## Files Touched
- web/src/hooks/use-pi-ws-handler.ts — text_delta handler bypasses store
- web/src/lib/pi-session-store.ts — remove streamingText from SessionAccum
- web/src/components/chat-panel.tsx — streaming ref instead of streamingText prop
- web/src/components/pi-streaming-message.tsx — accept ref-driven updates
- web/src/routes/pi.default.tsx — remove streamingText from accum reads
- web/src/routes/pi.$sessionId.tsx — same
- src/pi/subscribe.ts — throttle touchPiEvent during text_delta (server-side, minor)

## Specs
- 01-client-streaming-bypass — bypass React for text deltas, direct DOM updates
- 02-server-touchevent-throttle — throttle SQLite writes on hot path
