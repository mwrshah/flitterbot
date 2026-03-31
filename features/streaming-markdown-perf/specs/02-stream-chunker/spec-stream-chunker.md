# Spec: Stream Chunker

## Overview

Implement a stream chunker between WebSocket message delivery and Incremark's `append()`. Takes bursty text deltas from the network, buffers them, and releases micro-deltas at a controlled ~60fps cadence (~3 characters per tick). Ensures visually smooth streaming regardless of network burst patterns.

## Functional Requirements

1. **FR-1: Buffer incoming deltas** — Accept text chunks of any size from the WebSocket `onmessage` handler. Append to an internal character queue.

2. **FR-2: Fixed-cadence release** — Drain the queue at ~16ms intervals (aligned with `requestAnimationFrame` or a 60fps timer). On each tick, release ~3 characters (configurable) to the downstream consumer via a callback.

3. **FR-3: Adaptive chunk size** — If the buffer grows beyond a threshold (e.g., >50 chars queued), increase the release size to prevent the display from falling too far behind the actual stream position. The chunker should never be more than ~500ms behind the network.

4. **FR-4: Flush on stream end** — When the stream ends (message_end event), immediately flush all remaining buffered characters. No delay after the stream completes.

5. **FR-5: Reset** — Provide a `reset()` method to clear the buffer and stop the release timer. Called when a new message stream begins.

6. **FR-6: Framework-agnostic** — The chunker is a plain TypeScript class, not a Lit component. It takes a callback `onChunk(text: string)` and exposes `push(delta: string)`, `flush()`, `reset()`.

## Key Files

| File | Role |
|---|---|
| `web/src/lib/streaming-store.ts` | Integration point — chunker sits between WebSocket handler and Incremark component |

## Design Notes

The chunker's purpose is visual smoothness, not performance. Incremark handles the performance problem (O(n) parsing). The chunker handles the perception problem (choppy burst rendering → smooth character flow).
