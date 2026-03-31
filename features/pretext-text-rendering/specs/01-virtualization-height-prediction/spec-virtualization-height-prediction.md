# Spec: Virtualization Height Prediction

## Summary

Introduce a pretext-based measurement oracle that predicts chat message heights without DOM measurement, enabling window-based virtualization of the message list.

## Functional Requirements

- FR1: Create a `PretextOracle` service that caches `PreparedText` handles per message, keyed by text content + font config
- FR2: Expose `getMessageHeight(messageId, containerWidth): number` that returns predicted pixel height using `layout()`
- FR3: Handle resize by re-calling `layout()` on all cached handles (arithmetic-only, no re-prepare)
- FR4: Provide a fallback height estimation for messages containing markdown/rich content that pretext cannot measure
- FR5: Integrate with the message list rendering to use predicted heights for offscreen items while using actual DOM heights for visible items
- FR6: Validate pretext height predictions against actual DOM heights for the `Geist Variable` font family

## Technical Approach

- The oracle wraps `prepare()` and `layout()` from `@chenglou/pretext`
- Font string must exactly match the CSS font declaration for chat messages
- For rich content (markdown, code blocks), estimate height as `pretextPlainTextHeight * richContentMultiplier` where the multiplier is empirically determined
- Cache invalidation on theme change (font may differ between light/dark) and on message edit
- Consider `WeakRef` or LRU eviction for `PreparedText` cache to bound memory

## Open Questions

- What virtualization library to use? (TanStack Virtual, custom, or enhance Lit component directly)
- How does the React-Lit bridge need to change to support windowed rendering?
- What's the acceptable height prediction error margin before it causes visible layout shift?
