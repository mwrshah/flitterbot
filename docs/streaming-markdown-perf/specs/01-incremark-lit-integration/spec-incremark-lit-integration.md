# Spec: Incremark Lit Integration

## Overview

Create a Lit web component wrapper around `@incremark/core` to replace the current `marked.parse()` full-reparse pipeline. This is the foundation — all other specs depend on having incremental parsing with stable block IDs.

## Functional Requirements

1. **FR-1: Core parser integration** — Use `createIncremarkParser()` from `@incremark/core` with the marked engine (default). The parser instance lives on the component, created in `connectedCallback`, cleaned up in `disconnectedCallback`.

2. **FR-2: Streaming API** — Expose `append(chunk)` to feed streaming deltas. Each call incrementally parses only the new content. The parser outputs an updated block array with stable IDs — only changed/new blocks trigger re-render.

3. **FR-3: Block-to-Lit rendering** — Render each block from Incremark's output as a Lit template. Use `repeat()` directive with block IDs as keys so Lit can efficiently diff the block list. Each block renders its HTML content via `unsafeHTML()`.

4. **FR-4: Custom renderer configuration** — Configure Incremark's marked engine to match our current renderer customizations: links open in new tabs (`target="_blank" rel="noopener noreferrer"`). Verify this works through Incremark's engine options.

5. **FR-5: Code block extraction** — Adapt the current `<pre><code>` → `<code-block>` regex extraction to work per-block rather than on the full concatenated HTML. Each code block in Incremark's output should produce a `<code-block>` custom element.

6. **FR-6: Full content mode** — Support `render(content)` for non-streaming use cases (displaying saved messages). The component must work for both streaming and static rendering.

7. **FR-7: Reset and finalize** — Call `reset()` when the component receives a new message. Call `finalize()` when streaming ends (message_end event) to flush any pending parser state.

## Key Files

| File | Role |
|---|---|
| `web/src/pi-web-ui/chat-components.ts` | Replace `MarkdownBlock` internals (lines 131-173) |
| `web/src/lib/streaming-store.ts` | Delta delivery — will call `append()` instead of setting `content` |

## New Dependency

`@incremark/core` — framework-agnostic incremental markdown parser
