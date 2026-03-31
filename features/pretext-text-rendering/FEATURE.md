# Feature: Pretext Text Rendering Integration

## Problem

Autonoma's web UI is a text-heavy chat application where text measurement drives layout quality and performance. Current pain points stem from the standard DOM text rendering model:

1. **Virtualization without height prediction**: The chat message list (`streams-message-list.tsx` -> Lit `<message-list>`) renders all messages in DOM. Virtualizing this list requires knowing message heights before rendering -- today that means either DOM measurement (expensive reflow) or fixed-height guesstimates (visually broken). Pretext's `prepare()` + `layout()` can predict heights from cached widths with pure arithmetic (~0.0002ms per block), enabling true virtualization without measurement.

2. **Chat bubble width waste**: Message bubbles use CSS `max-width` which leaves trailing whitespace on wrapped lines. Pretext's `walkLineRanges()` + binary-search shrinkwrap (demonstrated in the bubbles demo) eliminates this waste, producing tighter, more polished bubbles.

3. **Streaming layout prediction**: The streaming store (`streaming-store.ts`) pushes ~30Hz text deltas to Lit components. Each delta changes text content, and the browser must reflow to determine the new height. With pretext, height can be predicted before the DOM update, enabling smooth scroll anchoring and pre-allocated space for incoming text.

4. **Layout shift on text load**: When messages first appear or stream in, the DOM must lay them out before heights are known. This causes visible layout shift, especially when scrolled to the bottom of the chat.

## Goals

- **Virtualized message list**: Use pretext height prediction to enable window-based virtualization of the chat timeline, dramatically reducing DOM node count for long conversations.
- **Tight bubble widths**: Eliminate CSS max-width waste on chat bubbles using pretext shrinkwrap.
- **Smooth streaming**: Pre-calculate heights during streaming to prevent scroll jumps and layout shift.
- **Zero rendering changes initially**: Adopt pretext purely for measurement/layout decisions. Keep DOM rendering via Lit web components unchanged.

## Non-goals

- **Replace DOM text rendering with canvas/WebGL**: Pretext can render to canvas, but doing so sacrifices text selection, copy-paste, accessibility, and screen reader support -- all critical for a chat UI. The DOM stays as the rendering layer.
- **Rich text layout via pretext**: Pretext operates on single-font plain text. Autonoma's markdown rendering (marked.js + highlight.js) produces mixed-font HTML with inline code, links, bold, etc. These cannot be measured by pretext. Pretext integration targets plain-text surfaces and height estimation for known-font blocks.
- **Replace CSS layout engine**: Pretext handles text measurement, not element layout. Flexbox/grid for page structure stays.
- **Server-side rendering**: Pretext requires Canvas API. SSR is out of scope.

## Architecture

### Current rendering stack

```
React 19 (routes, layout, sidebar, input)
  |
  +-- Lit 3.3 web components (chat messages, markdown, code, tools)
  |     |-- <message-list>: container, streaming updates
  |     |-- <assistant-message>: text + thinking + tool calls
  |     |-- <user-message>: text + images
  |     |-- <tool-message>: specialized per-tool renderers
  |     |-- <markdown-block>: marked.js HTML
  |     |-- <code-block>: highlight.js syntax highlighting
  |     +-- <console-block>: terminal output
  |
  +-- Streaming store: ~30Hz imperative updates bypassing React
  +-- TanStack Query: server state + cache
  +-- WebSocket: real-time updates
```

### Integration layer

Pretext integrates as a **measurement oracle** sitting between the data layer and the rendering layer:

```
Data (TanStack Query + WS + streaming store)
  |
  +-- Pretext measurement layer (new)
  |     |-- prepare() on message text arrival / mutation
  |     |-- layout() on container resize
  |     +-- Cache: PreparedText per message, keyed by content hash
  |
  +-- Rendering layer (unchanged)
        |-- Lit components render DOM as before
        +-- Virtualization window uses pretext heights
```

### Key integration points

1. **Message height oracle** (`lib/pretext-oracle.ts` -- new):
   - Maintains a cache of `PreparedText` handles keyed by message content + font config
   - Exposes `getMessageHeight(text, containerWidth)` for virtualizer
   - Invalidates on font/theme change
   - Handles the limitation that only plain-text portions can be measured (markdown blocks need fallback estimation)

2. **Virtualizer** (wrapping `<message-list>`):
   - Uses pretext heights for offscreen items
   - Falls back to DOM measurement for visible items (handles rich content accurately)
   - Recalculates on resize using `layout()` (arithmetic-only, safe to call frequently)

3. **Bubble shrinkwrap** (in Lit `<assistant-message>` / `<user-message>`):
   - After `prepare()`, use `walkLineRanges()` + binary search to find tight width
   - Apply as inline `width` style on the bubble element
   - Only applies to plain-text messages; markdown messages keep CSS max-width

4. **Streaming height prediction** (in `streaming-store.ts` bridge):
   - Incrementally update `PreparedText` as streaming deltas arrive
   - Pre-calculate expected height before Lit DOM update
   - Pass predicted height to scroll anchor logic

### Font configuration

Pretext requires explicit font strings matching CSS declarations. Current fonts:
- Sans: `Geist Variable` (via `@fontsource-variable/geist`)
- Mono: Tailwind default mono stack
- The font string passed to `prepare()` must match the CSS `font` shorthand exactly (size, weight, style, family)

**Risk**: `Geist Variable` is a variable font. Pretext's canvas measurement should handle this, but accuracy needs validation against DOM rendering with the exact variable font instance.

## Surfaces to Convert

### Phase 1: Chat message height prediction
- **Component**: `streams-message-list.tsx` + Lit `<message-list>`
- **What changes**: Add pretext height oracle for plain-text messages, enable virtualization window
- **Complexity**: Medium -- need to handle mixed content (some messages are plain text, some are markdown with code blocks)

### Phase 2: Chat bubble shrinkwrap
- **Component**: Lit `<assistant-message>`, `<user-message>` in `chat-components.ts`
- **What changes**: Compute tight bubble width via pretext, apply as inline style
- **Complexity**: Low for plain-text bubbles, not applicable to markdown-heavy messages

### Phase 3: Streaming layout prediction
- **Component**: `streaming-store.ts`, `streams-message-list.tsx`
- **What changes**: Predict height during streaming, pre-allocate space, smooth scroll anchoring
- **Complexity**: High -- incremental prepare() on deltas, coordination with Lit imperative updates

### Phase 4: Sidebar label measurement
- **Component**: `sidebar.tsx` (stream names with `truncate` class)
- **What changes**: Use pretext to measure label widths, implement smarter truncation or tooltip triggers based on actual text measurement rather than CSS overflow
- **Complexity**: Low

### Surfaces NOT converted
- **Markdown blocks** (`<markdown-block>`): Mixed fonts, inline HTML -- beyond pretext's single-font model
- **Code blocks** (`<code-block>`): Monospace but syntax-highlighted with mixed colors/weights
- **Tool call output** (`<tool-message>`): Structured layout with icons, badges, expandable sections
- **Message input** (`message-input.tsx`): Uses native `<textarea>` with `field-sizing-content` -- browser handles this well
- **Console blocks** (`<console-block>`): Terminal output with scrollable area

## Incremental Adoption Strategy

See spec stubs in `specs/` for phased rollout:

1. **01-virtualization-height-prediction**: Core measurement oracle + virtualizer integration
2. **02-chat-bubble-shrinkwrap**: Tight-fitting bubble widths for plain-text messages
3. **03-streaming-layout-integration**: Height prediction during streaming for scroll anchoring
4. **04-sidebar-label-measurement**: Text measurement for sidebar labels and truncation

Each phase is independently shippable and provides standalone value.

## Risks and Open Questions

### Risks

1. **Accuracy with variable fonts**: Pretext is validated against named static fonts. `Geist Variable` may have measurement discrepancies between canvas and DOM. Needs empirical validation.

2. **Library maturity**: Version 0.0.3, single maintainer, no documented production users, 5 days old. API may change. Consider vendoring/forking if adopting.

3. **Mixed content estimation**: Most chat messages contain markdown (code spans, links, bold). Pretext can only measure plain text with a single font. The height oracle needs a fallback strategy for rich content -- either a heuristic multiplier or measured-once cached heights.

4. **Bundle size**: The library is small (~1200 lines across 5 source files), but adds `Intl.Segmenter` dependency (built into modern browsers) and internal caches that grow with unique text content.

5. **Cache management**: `PreparedText` handles cache segment widths per font. In a chat app with potentially thousands of messages, cache growth needs bounds. `clearCache()` exists but is global.

6. **Streaming incremental prepare()**: There's no incremental/append API -- `prepare()` must be called on the full text each time it changes. For streaming messages, this means re-preparing the entire message on each delta. The README notes `prepare()` is ~19ms for 500 texts, so per-message cost should be sub-millisecond, but this needs benchmarking.

### Open questions

1. **Is virtualization actually needed?** How many messages does a typical Autonoma session contain? If sessions are short (< 100 messages), the DOM cost may be negligible and pretext adds complexity without meaningful gain.

2. **Does the Lit web component architecture support virtualization?** The current `<message-list>` manages its own DOM tree. Virtualizing it may require restructuring the React-Lit bridge.

3. **What's the actual performance win?** Need to benchmark current reflow cost during streaming and resize against pretext-predicted layouts to quantify the improvement.

4. **Should we wait for pretext to mature?** The library is days old. Watching for a few months to see if it gains traction and stabilizes may be prudent.

5. **Alternative: CSS `content-visibility: auto`?** Modern CSS has `content-visibility: auto` which lets the browser skip rendering offscreen content. This provides some virtualization benefits without a JS measurement library. Is it sufficient?
