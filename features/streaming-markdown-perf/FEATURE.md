# Feature: Streaming Markdown Rendering Performance

**Status: Planned / Unimplemented**

## Current State

`MarkdownBlock` in `web/src/pi-web-ui/chat-components.ts` calls `marked.parse(this.content)` on every Lit render cycle. During streaming, the streaming store delivers deltas to the Lit component via imperative callback — bypasses React but still triggers a full markdown reparse on each update.

No incremental parsing. No stream chunker. No code highlight caching.

## Problem

Full reparse on every delta is O(N^2) total work over a streaming response. A 2700-token response at ~30 deltas/sec over 30 seconds: ~900 full re-parses of progressively larger content. Each parse is ~3ms for 10K words. The quadratic accumulation is the cost.

`CodeBlock.render()` calls `hljs.highlight()` on every render even when code content hasn't changed.

Lit's microtask batching coalesces rapid deltas into fewer renders, making streaming appear choppy rather than smooth character-by-character flow.

## Proposed Solution

Replace full-reparse pipeline with Incremark (`@incremark/core`) incremental parser + stream chunker + direct DOM for the active block + code highlight caching. See `specs/` for detailed implementation plans.

Target: O(N) total parse work, <16ms per frame, ~60fps visual smoothness.

## Specs

All unimplemented. Detailed specs for future work:

- `specs/01-incremark-lit-integration/` — Lit wrapper around @incremark/core's append() API
- `specs/02-stream-chunker/` — Buffered micro-delta release at ~60fps cadence
- `specs/03-direct-dom-streaming-block/` — Bypass Lit batching for the active streaming block via direct DOM
- `specs/04-code-highlight-caching/` — Cache hljs output keyed by stable block IDs

## Key Files

| File | Role |
|---|---|
| `web/src/pi-web-ui/chat-components.ts` | `MarkdownBlock` (full reparse), `CodeBlock` (uncached highlight) |
| `web/src/lib/streaming-store.ts` | Delta delivery to Lit — stream chunker would integrate here |
