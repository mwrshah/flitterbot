# Spec: Code Highlight Caching

## Overview

Cache `hljs.highlight()` output keyed by `(code, language)`. Incremark's stable block IDs make this natural — a completed code block's ID doesn't change, so its highlight output can be cached permanently for the session.

## Functional Requirements

1. **FR-1: Highlight output cache** — Cache `hljs.highlight()` and `hljs.highlightAuto()` output keyed by `(code, language)`. Return cached HTML on cache hit instead of re-highlighting.

2. **FR-2: Stable block ID integration** — Use Incremark's stable block IDs as part of the cache strategy. Once a code block's ID stabilizes (block is complete), its highlight output is cached and never recomputed.

3. **FR-3: highlightAuto optimization** — `highlightAuto()` is significantly more expensive than `highlight()` with a known language. Track the auto-detected language and use `highlight()` with that language on subsequent calls for the same code.

4. **FR-4: Cache scope** — Module-level cache shared across all `CodeBlock` instances. Code blocks with identical content and language share cached output.

5. **FR-5: Cache bounds** — LRU cache with a configurable max size (default: 100 entries). Prevents unbounded memory growth in long conversations with many code blocks.

## Key Files

| File | Role |
|---|---|
| `web/src/pi-web-ui/chat-components.ts` | `CodeBlock` class — add cache layer around hljs calls |

## Measurement

- User Timing marks around `hljs.highlight()` / `hljs.highlightAuto()` calls
- Profile a response containing 5+ code blocks: compare total highlight time before and after caching
