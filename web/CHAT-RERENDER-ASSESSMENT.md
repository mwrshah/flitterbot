# Chat Components & Store Re-render Assessment

## Component Overview

| Component | File | `React.memo`? |
|---|---|---|
| PiDefaultRoute | `routes/pi.default.tsx` | No |
| PiSessionRoute | `routes/pi.$sessionId.tsx` | No |
| ChatPanel | `components/chat-panel.tsx` | No |
| PiMessageList | `components/pi-message-list.tsx` | Yes |
| MessageInput | `components/ui/message-input.tsx` | Yes |

---

## Per-Component Analysis

### PiDefaultRoute / PiSessionRoute (parent routes)

**Root cause of cascade:** Both routes subscribe to the full store snapshot via `usePiSessionStore()`, which re-renders on ANY store mutation (any session, connectionState). They then read `piSessionStore.getSessionAccum(sessionId)` directly — this works but means accum is re-read on every snapshot change, not just when the relevant session changes.

**Inline arrow creates unstable `onSendMessage`:**
```tsx
// pi.default.tsx:89-91
onSendMessage={(text, deliveryMode, images) =>
  sendMessage(text, deliveryMode, images, defaultSessionId)
}
```
Both routes pass an inline arrow for `onSendMessage` — a new function ref every render. This propagates instability to ChatPanel and MessageInput.

**`sendMessage` itself is unstable:** `piSessionStore.getSendMessage()` is called on every render (line 45 in pi.default.tsx, line 35 in pi.$sessionId.tsx) without memoization. When `setSendMessage` is called, `cachedSendMessage` is nulled, and the next `getSendMessage()` call creates a new ref.

**`timeline` is a new array every render:** `mergeTimelines()` always spreads into a new array (`[...loaderItems, ...unique]`). Even when `appendedItems` is empty, the early-return `return loaderItems` is stable only if `loaderItems` ref didn't change. But `accum.appendedItems` gets a new ref on every `updateSession` call because the updater creates a new object.

### ChatPanel

**Not memoized.** Every parent re-render re-renders ChatPanel unconditionally.

**Props instability summary:**
| Prop | Stable? | Why |
|---|---|---|
| `timeline` | No | New array from `mergeTimelines` on every store change |
| `sessionId` | Yes | String primitive from route params |
| `statusPills` | No | New array ref from `accum.statusPills` on store updates |
| `connectionState` | Yes | String primitive |
| `onSendMessage` | No | Inline arrow in parent, recreated every render |

**Downstream impact:** ChatPanel derives `agentMessages` and `pendingToolCalls` via `useMemo` keyed on `timeline`. Since `timeline` is a new ref every render, both memos recompute and produce new refs every time — even when the actual data hasn't changed.

- `timelineToAgentMessages(timeline)` — always returns a new `AgentMessage[]`
- `pendingToolCallsFromTimeline(timeline)` — always returns a new `Set<string>`, even when empty

**`handleSubmit` instability:** `useCallback` deps include `onSendMessage` (unstable from parent) and `engageAndScroll` — so `handleSubmit` is recreated on every render, defeating MessageInput's `memo`.

### PiMessageList

**Memoized with `React.memo`** — but memo is defeated because props change every render:

- `messages` (`agentMessages`) — new array ref from `timelineToAgentMessages`, even when timeline content is identical
- `pendingToolCalls` — new `Set` ref from `pendingToolCallsFromTimeline`, even when empty (`Set(0) -> Set(0)`)
- `isStreaming` — boolean, stable

The component has a stable `EMPTY_PENDING` sentinel (`new Set<string>()` at module level, line 14), but it's only used as a fallback when `pendingToolCalls` prop is undefined. Since ChatPanel always passes the prop, the sentinel is never hit.

### MessageInput

**Memoized with `React.memo`** — but memo is defeated by:

- `onSubmit` (`handleSubmit`) — recreated because `onSendMessage` dep is unstable (see ChatPanel analysis)
- `onDeliveryModeChange` (`setDeliveryMode`) — stable (React setState identity)
- `skills` (`skillsData?.items`) — stable from react-query cache between refetches
- Other props (primitives) — stable

---

## Store Design Issues

### 1. Coarse-grained snapshot subscription (Critical)

`usePiSessionStore()` returns the entire `PiSessionSnapshot` (all sessions + connectionState). The `notify()` function creates a new snapshot on every mutation:

```ts
// pi-session-store.ts:87-89
function notify() {
  snapshot = { sessions: new Map(sessions), connectionState };
  for (const fn of listeners) fn();
}
```

**Impact:** Every `updateSession` (for any session), `addPill`, `removePill`, `setConnectionState` triggers ALL subscribed components to re-render, even if they only care about one session or one field.

### 2. No selector-based subscriptions

There's no way to subscribe to a specific slice (e.g., "only re-render when session X's accum changes" or "only re-render when connectionState changes"). `useSyncExternalStore` requires a single `getSnapshot` function, and since the snapshot object is replaced on every `notify()`, React always sees a "new" value.

### 3. `getAllAppendedItems()` creates new array every call

Called without memoization, returns a new sorted array each time. Not directly related to the chat re-render chain but worth noting.

---

## Callback Stability Analysis

| Callback | Location | Stable? | Root Cause |
|---|---|---|---|
| `onSendMessage` | pi.default.tsx:89 | No | Inline arrow in JSX |
| `onSendMessage` | pi.$sessionId.tsx:50 | No | Inline arrow in JSX |
| `handleSubmit` | chat-panel.tsx:189 | No | Depends on unstable `onSendMessage` |
| `handleSkillSelect` | message-input.tsx:57 | Yes | Empty deps `[]` |
| `handleDraftChange` | message-input.tsx:42 | Yes | Deps `[skills]`, stable from cache |
| `engageAndScroll` | chat-panel.tsx:88 | Unknown | From `useStickToBottom` — not investigated |

---

## Priority-Ranked Fix Recommendations

### P0 — Stabilize `onSendMessage` in parent routes

**Problem:** Inline arrow creates a new function ref every render, cascading instability through ChatPanel -> handleSubmit -> MessageInput.

**Fix:** Wrap in `useCallback` with `[sendMessage, defaultSessionId]` deps. But `sendMessage` itself is unstable (see P1).

### P1 — Add selector-based store subscriptions

**Problem:** `usePiSessionStore()` returns the full snapshot, causing all consumers to re-render on any mutation.

**Fix options:**
1. **Selector hook:** `usePiSessionSelector(selector, isEqual?)` using `useSyncExternalStore` with a selector that extracts only the needed slice, plus optional shallow-equal comparison.
2. **Split into separate hooks:** `useConnectionState()`, `useSessionAccum(sessionId)` — each with its own `getSnapshot` that returns a stable ref when the value hasn't changed.

**Example:** Parent routes only need `connectionState` and one session's accum. A selector like `(snap) => snap.connectionState` with primitive comparison would eliminate re-renders from other session updates.

### P2 — Memoize `ChatPanel` with `React.memo`

**Problem:** ChatPanel re-renders on every parent re-render regardless of prop changes.

**Fix:** Wrap in `memo()`. This only helps after P0/P1 stabilize its props.

### P3 — Structural sharing for `pendingToolCalls`

**Problem:** `pendingToolCallsFromTimeline` always returns a new `Set`, even when empty. PiMessageList's memo sees `Set(0) !== Set(0)`.

**Fix options:**
1. Return a module-level `EMPTY_SET` sentinel when no pending calls exist.
2. Use a custom comparator on PiMessageList's `memo`: `(prev, next) => setsEqual(prev.pendingToolCalls, next.pendingToolCalls) && ...`
3. Switch pendingToolCalls from `Set<string>` to a sorted array (arrays are easier to shallow-compare in memo).

### P4 — Structural sharing for `agentMessages` (timeline -> messages conversion)

**Problem:** `timelineToAgentMessages` always returns a new array. When timeline ref changes but content is identical (e.g., store notified for a different session's update), messages array is recomputed to the same result but with a new ref.

**Fix:** Cache the previous result and return it if the input timeline hasn't meaningfully changed. Options:
1. **Ref-based cache in ChatPanel:** Compare `timeline` ref — if same as last render, return cached messages.
2. **Structural sharing in `mergeTimelines`:** Return the same array ref when nothing was actually appended.

### P5 — Stabilize `sendMessage` reference

**Problem:** `piSessionStore.getSendMessage()` returns a new function after `setSendMessage` is called (nulls `cachedSendMessage`). If `setSendMessage` is called during setup, subsequent reads create a new function ref on each route render.

**Fix:** Cache the bound function in the store more aggressively, or memoize in the parent route with `useMemo(() => piSessionStore.getSendMessage(), [])` if the function identity is effectively stable after initial setup.

---

## Re-render Chain Summary

```
Store notify() (any mutation)
  -> usePiSessionStore() returns new snapshot
    -> PiDefaultRoute / PiSessionRoute re-renders
      -> new timeline ref (mergeTimelines spreads)
      -> new onSendMessage ref (inline arrow)
        -> ChatPanel re-renders (not memoized)
          -> new agentMessages ref (timelineToAgentMessages)
          -> new pendingToolCalls ref (pendingToolCallsFromTimeline)
          -> new handleSubmit ref (useCallback deps changed)
            -> PiMessageList re-renders (memo defeated by messages + pendingToolCalls)
            -> MessageInput re-renders (memo defeated by onSubmit)
```

Every store mutation — even for an unrelated session — triggers a full re-render of the entire chat tree.
