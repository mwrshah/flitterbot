# Spec: Streaming Layout Integration

## Summary

Integrate pretext height prediction into the streaming pipeline so that incoming text deltas can predict layout changes before DOM updates, enabling smooth scroll anchoring without layout shift.

## Functional Requirements

- FR1: On each streaming text delta, re-prepare the message text and predict the new height
- FR2: Compare predicted height to current height; if changed, pre-allocate space before the DOM update
- FR3: Maintain scroll anchor position: if user is scrolled to bottom, keep them at bottom; if scrolled up, keep their viewport position stable
- FR4: Height prediction must not block the ~30Hz streaming update cycle -- it must complete within the frame budget
- FR5: Handle the transition from streaming to final message (streaming uses incremental text, final message may include markdown rendering)

## Technical Approach

- Hook into the streaming store's text callback to run `prepare()` + `layout()` on the accumulated text
- `prepare()` cost: benchmarked at ~0.04ms per message (19ms / 500 texts). At 30Hz with one active stream, this is ~1.2ms/s -- negligible
- Pre-set the message container height to the predicted value before Lit renders the text update
- On `message_end` / `turn_end`, discard the streaming PreparedText and let the final rendered DOM determine height (markdown content may differ from plain text prediction)

## Open Questions

- Does re-preparing on every delta cause GC pressure from discarded PreparedText handles?
- Should we debounce prepare() to every Nth delta or use requestIdleCallback?
- How to handle thinking blocks and tool calls interspersed with text during streaming?
