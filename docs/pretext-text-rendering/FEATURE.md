# Feature: Pretext Text Rendering Integration

**Status: Partially implemented**

## What Pretext Does

Pretext is a text measurement library. `prepare()` caches character/segment widths for a given font. `layout()` computes line breaks and heights using pure arithmetic (~0.0002ms). No DOM reflow needed.

Font config: `'400 14px "Geist Variable", sans-serif'` for surface, `'400 12px "Geist Variable", ...'` for path picker.

## Current Implementation

### Surface timeline virtualization — `web/src/components/surface.tsx`

Module-level `Map<string, PreparedText>` cache. For each timeline entry:
1. `prepare(text, font, { whiteSpace: "pre-wrap" })` — cached by content string
2. `layout(prepared, containerWidth, lineHeight)` — returns line count, used for height estimation
3. Feeds a custom virtualizer: binary search for visible rows, overscan ratios (0.5 above, 1.0 below), renders only visible entries in a positioned container
4. `isOverflowing` detection (>30 lines) drives "read more" collapse

This is real virtualization — offscreen entries are not in the DOM.

### Cursor positioning — `web/src/components/common/message-input.tsx`

Uses `prepareWithSegments()` + `layoutWithLines()` to compute the X offset of the cursor at a trigger character (`/` or `@`). Positions the skill picker and path picker popovers at that offset. Fresh computation on each keystroke (single text, acceptable cost).

### Path truncation — `web/src/components/path-picker.tsx`

`measureTextWidth()` wraps `prepareWithSegments()` + `layoutWithLines()` (huge width = single line). `smartMiddleTruncate()` binary-searches for the longest suffix that fits: `"pa...tures"`. Called per path result during render.

## Spec Status

| Spec | Status |
|---|---|
| `specs/01-virtualization-height-prediction/` | **Implemented** in surface.tsx. Module-level prepare cache, layout-based height estimation, custom virtualizer with binary search. |
| `specs/02-chat-bubble-shrinkwrap/` | Not implemented. Bubbles use CSS max-width. |
| `specs/03-streaming-layout-integration/` | Not implemented. No height prediction during streaming. |
| `specs/04-sidebar-label-measurement/` | Not implemented. Sidebar uses CSS truncation. |

## Key Files

| File | Pretext usage |
|---|---|
| `web/src/components/surface.tsx` | `prepare()` + `layout()` — virtualization, height estimation, overflow detection |
| `web/src/components/common/message-input.tsx` | `prepareWithSegments()` + `layoutWithLines()` — cursor X offset for picker placement |
| `web/src/components/path-picker.tsx` | `prepareWithSegments()` + `layoutWithLines()` — smart middle truncation of directory paths |
