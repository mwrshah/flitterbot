# Spec: Direct DOM Streaming Block

## Overview

For the actively-streaming block (the last/growing block), bypass Lit's reactive update cycle and update the DOM directly. This avoids Lit's microtask batching for the hot path, enabling per-micro-delta visual updates at frame rate. Completed blocks continue using normal Lit rendering.

## Functional Requirements

1. **FR-1: Ref to active block element** — The Incremark Lit component (from spec-01) holds a `ref()` to the DOM element of the last block. This ref is used for direct DOM manipulation during streaming.

2. **FR-2: Direct DOM update on micro-delta** — When the stream chunker (spec-02) delivers a micro-delta that affects the last block, update the block's `innerHTML` directly from Incremark's rendered output for that block. Do not go through Lit's `requestUpdate()` path.

3. **FR-3: Handoff to Lit on block completion** — When Incremark's output indicates a new block has started (the previously-active block is now complete), stop direct DOM updates for that block and let Lit take over its rendering. The new last block becomes the direct-DOM target.

4. **FR-4: Consistency on finalize** — When streaming ends (`finalize()`), perform one final Lit render to ensure all blocks are in Lit's managed state. No orphaned direct-DOM content after streaming completes.

5. **FR-5: No interference with completed blocks** — Completed blocks rendered by Lit must not be disturbed by the direct DOM updates to the active block. The active block's DOM element is isolated (e.g., a dedicated container div).

## Key Files

| File | Role |
|---|---|
| `web/src/pi-web-ui/chat-components.ts` | Incremark Lit component — adds direct DOM path alongside Lit rendering |

## Design Notes

This optimization targets the ~30ms window where Lit's microtask batching would coalesce multiple micro-deltas into one render. By writing directly to the DOM, each micro-delta becomes visible on the next frame paint. The visual difference is subtle but important for perceived streaming smoothness.
