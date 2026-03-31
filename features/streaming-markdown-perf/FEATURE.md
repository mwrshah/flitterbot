# Feature: Streaming Markdown Rendering Performance

## Problem

Autonoma's markdown rendering pipeline re-parses the entire message on every streaming delta, creating O(N^2) total work during a streaming response. Additionally, Lit's microtask-based update batching coalesces rapid deltas into fewer renders, making streaming appear choppy rather than smooth.

The current pipeline (`MarkdownBlock` in `web/src/pi-web-ui/chat-components.ts`):

1. `streaming-store.ts` accumulates text via `appendTextDelta()` — concatenates each delta to the full message string
2. Lit detects the `content` property change on `<markdown-block>`
3. `MarkdownBlock.render()` calls `marked.parse(this.content)` on the **entire** accumulated text
4. Regex extraction converts `<pre><code>` blocks into `<code-block>` custom elements
5. `unsafeHTML()` replaces the entire DOM subtree

For a 2700-token response at ~30 deltas/second over 30 seconds: ~900 full re-parses of progressively larger content. Each parse is ~3ms for 10K words, but the quadratic accumulation is the real cost — total CPU time grows with the square of message length.

Additionally, `CodeBlock.render()` calls `hljs.highlight()` or `hljs.highlightAuto()` on every render, even when the code content hasn't changed.

## Goals

- Reduce streaming markdown rendering from O(N^2) to O(N) total work via Incremark's incremental parser
- Achieve super-smooth streaming (~60fps visual cadence, ~3 chars per visible update) via a stream chunker
- Bypass Lit's microtask batching for the actively-streaming block via direct DOM manipulation
- Cache highlighted code output keyed by stable block IDs
- Maintain current rendering fidelity — same markdown output, link target behavior, code block extraction

## Non-Goals

- Manual block-level caching on marked (Incremark handles this natively and better)
- Replacing Lit as the rendering layer (Lit is fine for completed blocks; only the streaming hot path needs direct DOM)
- Virtualizing the message list (separate concern — see pretext-text-rendering feature)

## Architecture

### Incremark-based incremental pipeline

```
WebSocket delivers bursty chunks
  |
  +-- Stream Chunker (spec-02)
  |     |-- Buffers incoming deltas
  |     +-- Releases ~3-char micro-deltas at ~16ms intervals (60fps)
  |
  +-- Incremark Lit Component (spec-01)
  |     |-- createIncremarkParser() with marked engine
  |     |-- append(microDelta) → O(1) incremental parse
  |     |-- Outputs block array with stable IDs
  |     +-- Only changed blocks trigger Lit re-render
  |
  +-- Active Streaming Block (spec-03)
  |     |-- Last block uses direct DOM update (ref + textContent/innerHTML)
  |     |-- Bypasses Lit's requestUpdate() microtask batching
  |     +-- Completed blocks use normal cached Lit rendering
  |
  +-- Code Highlight Cache (spec-04)
        |-- hljs.highlight() output cached by (code, language)
        +-- Stable block IDs = stable cache keys
```

### Why Incremark

Incremark (`@incremark/core`, kingshuaishuai/incremark) is a purpose-built incremental streaming markdown parser. Benchmarked at 6.1-28.3x faster than competitors on real files (128KB across 38 files). Uses marked as its default engine — the same parser we already depend on — so rendering fidelity is preserved.

Key properties:
- O(n) complexity via block-level diffing with stable IDs
- Separates parsing from rendering — core outputs block AST, we render with Lit
- `append(chunk)` API designed for streaming deltas
- No Lit bindings exist — we write a Lit integration using the core API

### Stream Chunker

WebSocket delivers text in variable-size bursts. Multiple `onmessage` events can fire before the next animation frame, and Lit batches them into a single render. The stream chunker sits between WebSocket and Incremark:

- Buffers incoming deltas into a queue
- Drains the queue at ~60fps, releasing ~3 characters per tick
- Ensures visually smooth character-by-character flow regardless of network patterns

### Direct DOM for Active Block

Lit's `requestUpdate()` → microtask batching is efficient for general UI but fights against per-character streaming smoothness. For the last (actively growing) block only:

- Hold a ref to the DOM element
- On each micro-delta from the stream chunker, update `textContent` or `innerHTML` directly
- When the block completes (next block starts), hand it off to normal Lit rendering

## Key Files

| File | Role |
|---|---|
| `web/src/pi-web-ui/chat-components.ts` | `MarkdownBlock` (lines 131-173) — replace with Incremark wrapper; `CodeBlock` (lines 179-230) — highlight caching |
| `web/src/lib/streaming-store.ts` | Streaming text accumulation, delta delivery — stream chunker integrates here |
| `web/src/lib/pi-web-ui-init.ts` | Lazy-loads chat-components.ts |

## Specs

- `specs/01-incremark-lit-integration/` — Lit web component wrapper around @incremark/core
- `specs/02-stream-chunker/` — Buffered micro-delta release at 60fps cadence
- `specs/03-direct-dom-streaming-block/` — Bypass Lit batching for the active streaming block
- `specs/04-code-highlight-caching/` — Cache hljs output keyed by stable block IDs

## Risks

1. **No Lit bindings for Incremark**: We must write our own integration using `@incremark/core`. The core API is framework-agnostic, so this is a wrapper task, not a port. Risk is low but it's custom code to maintain.

2. **Incremark's marked engine configuration**: Our custom renderer (link targets with `target="_blank"`) must be configured through Incremark's marked engine options. Need to verify this is supported.

3. **Direct DOM updates and Lit state sync**: When bypassing Lit for the active streaming block, we must ensure Lit's internal state stays consistent when the block transitions to normal rendering. A clean handoff protocol is needed.

4. **Stream chunker timing**: The ~3-char / ~16ms cadence is a starting point. Actual optimal values depend on content type (code vs prose), font rendering speed, and user perception. May need tuning or adaptive cadence.

## Measurement

- **User Timing API**: Wrap Incremark `append()` calls in `performance.mark/measure`
- **Total parse time over a streaming response**: Compare against current `marked.parse()` full-reparse baseline
- **Frame timing**: `requestAnimationFrame` delta to detect jank (>20ms frames) during streaming
- **Visual smoothness**: Subjective assessment of character-by-character flow vs current choppy behavior
- **Target**: O(N) total parse work; <16ms per frame during streaming; visually smooth ~60fps text flow
