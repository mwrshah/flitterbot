# Spec: Sidebar Label Measurement

## Summary

Use pretext to measure sidebar label widths (workstream names, session descriptions) to implement precise text truncation and tooltip triggers based on actual text measurement rather than CSS overflow detection.

## Functional Requirements

- FR1: Measure workstream name labels to determine if they overflow their container
- FR2: When a label overflows, apply intelligent truncation (not just CSS `truncate`) and show a tooltip with the full text
- FR3: Measure session count and status indicators to ensure they don't collide with truncated names
- FR4: Recompute on sidebar resize (if sidebar becomes resizable) or font change

## Technical Approach

- Use `prepare()` + `layout()` with `maxWidth` set to the label container width
- If `lineCount > 1`, the text overflows and needs truncation
- Use `walkLineRanges()` to find the first line's width and cursor end, then truncate to that boundary with ellipsis
- Font string: matches sidebar CSS (`text-sm` = 14px, `font-medium` = 500 weight, Geist Variable family)

## Open Questions

- Is this a meaningful improvement over CSS `truncate` (text-overflow: ellipsis)?
- Could this enable smarter truncation (e.g., truncate from the middle for paths, or abbreviate common prefixes)?
- Is the overhead of preparing every sidebar label justified given they change infrequently?
