# Spec: Chat Bubble Shrinkwrap

## Summary

Use pretext's `walkLineRanges()` + binary search to compute tight-fitting widths for chat message bubbles, eliminating the trailing whitespace waste inherent in CSS `max-width`.

## Functional Requirements

- FR1: For plain-text messages, compute the tightest bubble width that preserves the same line count as CSS max-width layout
- FR2: Apply the tight width as an inline style on the bubble element
- FR3: Recompute on container resize (arithmetic-only via `layout()`)
- FR4: Fall back to CSS max-width for messages with rich content (markdown, code, images)
- FR5: The shrinkwrap must not change line breaks compared to CSS -- it should produce identical wrapping, just in a tighter container

## Technical Approach

- Follow the pattern from pretext's bubbles demo: `walkLineRanges()` to find max line width, then binary search via `layout()` to find minimum width preserving the line count
- Integrate into the Lit `<assistant-message>` and `<user-message>` components
- Reuse `PreparedText` handles from the measurement oracle (spec 01) to avoid double-prepare
- Only apply to messages where the entire content is a single plain-text block

## Open Questions

- How significant is the visual improvement? Need before/after comparison
- Should this apply to user messages, assistant messages, or both?
- Performance impact of binary search per bubble on initial render with many messages
