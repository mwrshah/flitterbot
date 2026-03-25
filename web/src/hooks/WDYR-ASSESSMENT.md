# WDYR Hook Assessment

## Current Implementation

**File:** `web/src/hooks/use-why-did-you-render.ts` (29 lines)

The hook is minimal:
- Stores previous tracked values in a `useRef`
- On every render (no dependency array on `useEffect`), compares each key via `Object.is`
- Logs changed keys with `console.log("[WDYR] ComponentName: key changed", { old, new })`
- Production: replaced by a noop via `import.meta.env.DEV` conditional export

### Adoption

**29 consumer files**, ~45 call sites across components, UI primitives, and route files.

Tracked value patterns:
- **Props/state** (`timeline`, `sessionId`, `messages`, `entry`, etc.) — the majority
- **Callbacks** (`onSendMessage`, `onClose`, `onSelect`) — useful for detecting unstable references
- **Styling** (`className`, `variant`, `size`) — in UI primitives like Button, Card, Badge, Input
- **Empty objects `{}`** — some components track nothing, just detecting *that* a rerender happened (e.g., `PiStreamingMessage`, `DevStreamTuner`, `SessionsLayout`)
- **Duplicate calls** — several route components call the hook twice: once with `{}` (early return path) and once with actual values after data is loaded

---

## Problems with Current Logging

### P1: Collapsed objects are useless in console

```
[WDYR] ChatPanel: timeline changed {old: Array(47), new: Array(48)}
```

Chrome collapses the `{old, new}` into a summary. You have to click to expand. Can't copy-paste the diff. Can't grep terminal output.

### P2: No distinction between referential vs value change

When `Object.is` returns false, the log doesn't tell you *why*:
- **New reference, same values** — e.g., array recreated but contents identical. This is the most common perf bug (unstable selector/callback) and the most actionable.
- **Actual value change** — legitimate rerender, nothing to fix.

The developer has to manually expand both old/new and visually diff them. For arrays with 50+ items this is impractical.

### P3: No element-level diff for arrays/objects

For `timeline` (an array of message objects), the log says "timeline changed" but not:
- Which index changed?
- Was an item added/removed, or did an existing item mutate?
- Did the array just grow by one (append) or was it replaced entirely?

Same for object values — no key-level diff showing which nested field actually differs.

### P4: No render count / frequency tracking

When a component rerenders 30 times in 1 second, you see 30 individual log lines with no aggregation or rate context. No way to spot "this component is rerendering at 60fps" without manually counting.

### P5: No filtering / verbosity control

All 45 call sites log to the same stream with no way to:
- Focus on a single component
- Filter by change type (referential vs value)
- Suppress known-noisy components
- Adjust detail level (summary vs full diff)

### P6: Empty-object calls provide no actionable info

Components that call `useWhyDidYouRender("Foo", {})` detect that a rerender happened but log nothing — they never enter the comparison loop. They're placeholders that should either track something or be removed.

### P7: No timing context

No timestamp or render-count annotation. When scrolling through console output, you can't tell if two logs happened 1ms apart (same React batch) or 5 seconds apart (separate user actions).

---

## Recommended Improvements

### 1. Serialized, greppable log format

Replace `console.log(msg, object)` with a fully serialized string format:

```
[WDYR] ChatPanel.timeline REF_ONLY | len 47→48 | +1 appended
[WDYR] ChatPanel.onSendMessage REF_ONLY | fn
[WDYR] Sidebar.connectionState VALUE | "connected"→"disconnected"
[WDYR] InputSurface.loaderTimeline REF_ONLY | Array(12) identical
```

Design principles:
- **Single string** — no second argument, nothing collapsed
- **Component.key** format — greppable by component or by prop
- **REF_ONLY vs VALUE** tag — immediately tells you if this is actionable
- **Compact diff** — length changes for arrays, value preview for primitives, "identical" for same-value new-reference

### 2. Referential vs value change detection

After `Object.is` fails, perform a shallow comparison to classify:
- **Primitives**: always a value change (Object.is already handles NaN, ±0)
- **Arrays**: compare length, then element-wise `Object.is` on each index. Report: ref-only (all elements ===), appended (prefix matches + new tail), or mutated (which indices differ)
- **Objects**: compare key sets, then value-wise `Object.is` on each key. Report: ref-only, added/removed keys, or changed keys
- **Functions**: always ref-only (can't meaningfully diff). Flag as likely-unstable-callback.

Implementation approach: a `classifyChange(prev, next)` helper that returns a `ChangeSummary` with type tag and diff details. Keep it shallow (one level) — deep diffing is expensive and rarely needed for React props.

### 3. Array diff detail

For array changes, report at index level:

```
[WDYR] PiMessageList.messages VALUE | Array(11→12) +1 at end
[WDYR] PiMessageList.messages VALUE | Array(12) [3].content changed
[WDYR] SessionList.items REF_ONLY | Array(5) all elements ===
```

Algorithm: compare `Math.min(old.length, new.length)` elements with `Object.is`, then report appended/removed tail. For changed elements, report the index (but not deep diff — just "element at [i] changed").

### 4. Object diff detail

For plain-object changes:

```
[WDYR] SessionDetail.session VALUE | {status, updatedAt} changed, 12 keys same
[WDYR] SessionDetail.session REF_ONLY | 14 keys all ===
```

Report which keys changed by reference, which by value, and any added/removed keys.

### 5. Render batching / rate detection

Add a per-component counter and timestamp tracker. On each render, record `Date.now()`. If the same component logs more than N times within T ms, switch to a batched summary:

```
[WDYR] InputSurface: 12 renders in 200ms — entry (12x REF_ONLY)
```

Implementation: a module-level `Map<string, { count: number, firstTime: number }>` that resets after a quiet period (e.g., 1 second of no renders for that component).

### 6. Filtering via global config

Expose a `window.__WDYR_CONFIG` object (dev-only) for runtime control:

```ts
window.__WDYR_CONFIG = {
  include: ["ChatPanel", "InputSurface"],  // only these (empty = all)
  exclude: ["Button", "Badge"],            // suppress these
  verbosity: "normal",                     // "quiet" | "normal" | "verbose"
  onlyRefChanges: true,                    // hide legitimate value changes
}
```

- `quiet`: one line per render ("ChatPanel rendered, 3 props changed")
- `normal`: one line per changed prop (the default format above)
- `verbose`: include JSON.stringify preview of old/new values (truncated)

Read from `window.__WDYR_CONFIG` at log time (not import time) so it can be changed on the fly in DevTools.

### 7. Clean up empty-object calls

The ~8 call sites passing `{}` should either:
- Track relevant values (most should — the empty object was likely a placeholder during rollout)
- Be removed if the component genuinely has no interesting props to track

---

## Suggested Log Format Spec

```
[WDYR] {Component}.{key} {REF_ONLY|VALUE} | {type-specific detail}
```

**Type-specific detail templates:**

| Type | REF_ONLY | VALUE |
|------|----------|-------|
| Primitive | n/a (always VALUE) | `"foo"→"bar"` or `3→7` |
| Function | `fn` (unstable ref) | n/a (always REF_ONLY) |
| Array | `Array(N) identical` | `Array(N→M) +K at end` or `Array(N) [i,j] changed` |
| Object | `{K keys} identical` | `{a,b} changed, K same` or `+{c} -{d}` for key changes |
| null/undefined | — | `null→undefined` etc. |

**Verbose mode** appends truncated JSON for changed values:
```
[WDYR] ChatPanel.timeline VALUE | Array(47→48) +1 at end | last: {"role":"assistant","content":"..."}
```

**Quiet mode** collapses to per-component summary:
```
[WDYR] ChatPanel: 5 props changed (3 REF_ONLY, 2 VALUE)
```

---

## Implementation Priority

1. **Serialized format + REF_ONLY/VALUE classification** — highest impact, solves P1+P2
2. **Array/object diff detail** — solves P3, makes array-heavy components (timeline, messages) debuggable
3. **Filtering via window config** — solves P5, essential once there are 45 noisy call sites
4. **Render batching** — solves P4, nice-to-have for spotting hot components
5. **Clean up empty-object calls** — housekeeping, solves P6
6. **Timing annotations** — solves P7, lowest priority (DevTools timeline covers this)

## Estimated Scope

The core hook rewrite (items 1-3) is ~80 lines of TypeScript. No changes needed at call sites — the API (`componentName`, `trackedValues`) stays the same. The `classifyChange` helper is the only meaningful new code. Filtering config is another ~20 lines. Render batching is ~30 lines with the module-level Map.
