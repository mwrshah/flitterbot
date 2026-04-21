# Streaming Markdown Rendering: Landscape & Recommendation

## The Problem

`MarkdownBlock.render()` in `chat-components.ts` re-parses the full message on every streaming delta:

1. `marked.parse(this.content)` — full document parse
2. Regex extraction of code blocks into `<code-block>` elements
3. `unsafeHTML()` — full DOM replacement

`streaming-store.ts` (`appendTextDelta`) concatenates each token to the accumulated text, triggering a Lit property change that re-runs this pipeline. Total work: O(N^2) for N tokens.

At ~30 deltas/second, a 2000-word response (~2700 tokens, ~30s) triggers ~900 full re-parses of progressively larger content.

### Current Pipeline (chat-components.ts:146-172)

```
MarkdownBlock.content = fullText  // property change
  → requestUpdate() (batched via microtask)
  → render() → marked.parse(FULL content) → O(n²) re-parse
  → unsafeHTML(parsed) → replaces entire innerHTML
```

## Lit Batching & Streaming Smoothness

Lit batches updates via `requestUpdate()` → microtask scheduling. Multiple property changes in the same event loop iteration coalesce into a single render. The batching latency itself is minimal (microseconds, before next frame paint), but it creates a perceptual problem for streaming:

- If WebSocket `onmessage` fires 5 times before the next frame, all 5 deltas batch into 1 render
- The user sees text "jump" in chunks rather than flowing smoothly
- For super-smooth streaming (~3 characters visible per update), we need to control the cadence at which deltas reach the DOM

**Implication**: The rendering pipeline needs two layers of optimization — (1) an incremental parser that avoids O(n²) re-parsing, and (2) a stream chunker that controls visual cadence independently of network burst patterns.

## Benchmark Data

### Parser One-Shot Performance

| Parser | 10K words (one-shot) | Streaming overhead | Notes |
|---|---|---|---|
| **marked** (current) | ~3ms | O(N^2) — full re-parse per delta | Mature, good CommonMark support |
| **markdown-wasm** | ~1.5ms | O(N^2) — no incremental API | ~2x faster parse, same streaming problem |
| **markdown-it** | ~4ms | O(N^2) | Plugin ecosystem, slower than marked |
| **Incremark** | ~3ms initial | O(N) incremental — block-level diffing | Dual-engine, stable block IDs |
| **Semidown** | Unknown | Block-level only, partial | 10 stars, single contributor |
| **streaming-markdown** | Unknown | ChatGPT-style, WIP | Coupled parser+renderer, not production-ready |
| **FluidMarkdown** | Unknown | CommonMark streaming | Ant Group, limited English docs |

Sources: marked.js docs, Incremark README/benchmarks, markdown-wasm GitHub benchmarks.

### Incremark Streaming Benchmarks (38 Real Files, 128KB Total)

From incremark.com benchmarks on real markdown files:

| Parser | Total Time | vs Incremark |
|---|---|---|
| **Incremark** | 519ms | 1.0x (baseline) |
| **Streamdown** | 3,190ms | 6.1x slower |
| **ant-design-x** | 3,728ms | 7.2x slower |
| **markstream** | 14,683ms | 28.3x slower |

On large files (916 lines): Incremark 87.7ms vs Streamdown 1,441ms — **16.4x faster**.

O(n) complexity vs O(n²) for all competitors. The gap widens with content length.

## Incremark Architecture

**Incremark** (`@incremark/core`, kingshuaishuai/incremark) is a production-ready incremental streaming markdown parser.

### Dual Engine Design

- **marked engine** (default): fastest, uses marked under the hood — same parser we already use
- **micromark engine**: strictest CommonMark compliance, slower

### Core API (`@incremark/core`)

`createIncremarkParser()` returns a framework-agnostic parser instance. The `useIncremark` hook (available for React/Vue/Svelte/Solid) wraps this with reactive state:

- `blocks` — reactive array of parsed blocks with **stable IDs** (only changed blocks trigger re-render)
- `append(chunk)` — feed a streaming delta; parser incrementally processes only new content
- `render(content)` — set/replace full content
- `reset()` — clear parser state
- `finalize()` — signal end of stream, flush pending state

### Key Properties

- **Separates parsing from rendering**: core outputs an AST/block array that can be rendered by any framework
- **Stable block IDs**: completed blocks retain identity across updates — enables efficient diffing
- **No Lit bindings**: has React/Vue/Svelte/Solid bindings but we need to write a Lit integration using the core API
- **Features**: GFM, footnotes, math, custom containers, code blocks, typewriter effect, DevTools
- **Website**: incremark.com — extensive docs, benchmarks, interactive demos

## Approaches Compared

### 1. Incremark Incremental Parser (RECOMMENDED)

Replace marked with Incremark's `@incremark/core`. Feed streaming deltas via `append()`, receive updated block AST with stable IDs. Only changed blocks re-render.

**Pros**: Purpose-built for AI streaming; O(n) by design; stable block IDs enable surgical DOM updates; uses marked under the hood (same parser maturity); separates parsing from rendering; benchmarked at 6-28x faster than competitors.

**Cons**: No Lit bindings — requires writing a Lit integration. Replaces our direct marked usage (but Incremark uses marked internally with the marked engine). Custom renderer hooks (link targets) need to be configured through Incremark's marked engine options.

### 2. Block-level caching on marked (SUPERSEDED)

Detect completed markdown blocks, cache their HTML, only re-parse the trailing incomplete block. Manual reimplementation of what Incremark does natively.

**Why superseded**: Incremark handles block boundary detection, caching, and incremental diffing as its core purpose. Rolling our own would duplicate this logic with worse edge-case handling (nested lists, code fences, blockquotes). Incremark's benchmarks prove the approach works at scale.

### 3. markdown-wasm (NOT RECOMMENDED)

WASM parser, ~2x faster per parse. Still O(N^2) during streaming — smaller constant, same quadratic growth. The problem is re-parse frequency, not per-parse speed.

### 4. Stream Chunker (COMPLEMENT to Incremark)

A buffer between WebSocket and Incremark that controls visual cadence:

1. WebSocket delivers chunks (variable size, bursty)
2. Stream chunker buffers and releases at ~16ms intervals (60fps), splitting large chunks into ~3-char micro-deltas
3. Incremark's `append()` receives each micro-delta
4. Result: smooth character-by-character visual flow regardless of network burst patterns

### 5. Direct DOM Streaming Block (COMPLEMENT to Incremark)

For the actively-streaming block (the last/growing block), bypass Lit's reactive update cycle entirely:

- Use a ref to the DOM element and update `textContent`/`innerHTML` directly on each micro-delta
- Avoids Lit's microtask batching for the hot path
- Completed blocks use normal Lit rendering (they don't change)

This is the key to achieving per-character visual smoothness. Lit's batching is a feature for most UI updates, but for the streaming hot path we need frame-level control.

### 6. highlight.js Output Caching (COMPLEMENT)

Cache `hljs.highlight()` output keyed by `(code, language)`. Incremark's stable block IDs make this natural — a completed code block's ID doesn't change, so its highlight output can be cached permanently for the session.

## Target Pipeline

```
WebSocket delivers bursty chunks
  → Stream chunker buffers, releases ~3-char micro-deltas at 60fps
  → incremark.append(delta) → O(1) incremental parse
  → only last block's AST updated (stable IDs)
  → Active block: direct DOM update (bypass Lit batching)
  → Completed blocks: cached Lit templates, never re-rendered
  → Code blocks: hljs output cached by (code, language, blockId)
```

## Recommended Approach

**Spec 01 — Incremark Lit Integration**: Create a Lit web component wrapper around `@incremark/core`. This is the foundation — replaces marked with incremental parsing, provides stable block IDs.

**Spec 02 — Stream Chunker**: Buffer between WebSocket and Incremark that controls visual cadence. Ensures smooth ~60fps character flow regardless of network burst patterns.

**Spec 03 — Direct DOM Streaming Block**: Bypass Lit's reactive update cycle for the actively-streaming block. Direct DOM manipulation on each micro-delta for frame-level smoothness.

**Spec 04 — Code Highlight Caching**: Cache hljs output keyed by (code, language). Stable block IDs from Incremark make cache keys natural and long-lived.

## Key Insight: Lit Is Not the Bottleneck (But It's a Smoothness Constraint)

Lit patches DOM directly — no VDOM diffing. Render cost is dominated by `marked.parse()` + regex extraction, not Lit's template update. **However**, Lit's microtask batching coalesces rapid updates into fewer renders, which creates visible choppiness during streaming. The fix is two-fold: (1) Incremark for O(n) parsing, (2) direct DOM updates for the streaming block to bypass batching.
