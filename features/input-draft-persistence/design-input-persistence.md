# Design: MessageInput Draft Persistence Across Route Navigation

## Problem

`MessageInput` (`web/src/components/common/message-input.tsx:59`) initializes its draft with `useState("")`. When the user navigates between routes, the component unmounts and the draft is lost.

## Current Architecture

### Component Hierarchy

```
__root__ (RootComponent)
  AppShell (persists across all routes)
    Sidebar
    <Outlet />                              <-- route content swaps here
      /             -> SurfacePage -> Surface -> MessageInput
      /streams/default -> StreamsDefaultRoute -> ChatPanel -> MessageInput
      /streams/$id     -> PiSessionRoute      -> ChatPanel -> MessageInput
      /runtime         -> RuntimePage         (no MessageInput)
```

### When Does MessageInput Unmount?

| Navigation                                     | Unmounts? | Why                                           |
|------------------------------------------------|-----------|-----------------------------------------------|
| `/` -> `/streams/default`                      | Yes       | Surface unmounts, ChatPanel mounts             |
| `/streams/default` -> `/streams/$id`           | Yes       | Different route components (sibling routes)    |
| `/streams/$id` -> `/streams/$otherId`          | No*       | Same route definition, params change           |
| `/streams/*` -> `/`                            | Yes       | ChatPanel unmounts, Surface mounts             |
| `/streams/*` -> `/runtime`                     | Yes       | ChatPanel unmounts, RuntimePage has no input   |

*When navigating between two `$piSessionId` routes, TanStack Router reuses the `PiSessionRoute` component and updates params in-place. ChatPanel re-renders with new props but does NOT unmount. MessageInput survives. Draft is preserved already.

### How Draft State Currently Works

1. **Initialization**: `useState("")` (line 59) -- always starts empty
2. **Updates**: `handleDraftChange(value)` calls `setDraft(value)` on every keystroke (line 182)
3. **Submission**: `handleKeyDown` and form `onSubmit` both call `setDraft("")` after sending
4. **Ref sync**: `draftRef.current = draft` kept in sync via useEffect (line 119-126) for stable closures

### Consumers

1. **Surface** (`surface.tsx:882-889`) -- rendered on `/`, no `streamId` prop
2. **ChatPanel** (`chat-panel.tsx:285-296`) -- rendered on `/streams/*`, passes `streamId` prop

## Hard Constraints

- NO useEffect for syncing or persistence
- NO React-based syncing mechanisms (state managers, context providers)
- ZERO additional CPU cost on the hot path (input delay is ~40ms, cannot increase)
- Must be pure imperative browser primitives
- The text string should live in ONE place, accessed by old and new component instances

## Approach Evaluation

### A. Module-Level Variable

```ts
// At module scope, outside the component
let savedDraft = '';

// Inside the component
const [draft, setDraft] = useState(() => savedDraft);     // lazy init, runs once

// In handleDraftChange (already fires on every keystroke):
const handleDraftChange = useCallback((value: string) => {
  savedDraft = value;    // <-- one line added
  setDraft(value);
  // ... existing picker logic unchanged
}, [skills, computeSlashLeft]);
```

**Constraint check**:
- useEffect? None. Lazy initializer for seeding, imperative write in onChange.
- React syncing? None. Module variable is outside React's tree.
- CPU cost? `savedDraft = value` is a pointer assignment. Literally zero measurable cost.
- Single source of truth? Yes -- `savedDraft` is the one canonical location. `draft` state is just the React rendering copy.

**Properties**:
- Survives route navigation: Yes (JS module stays loaded)
- Survives page refresh: No
- Survives tab close: No
- Multiple tabs: Each tab has its own module scope (correct behavior)
- Picker interaction: No impact -- picker state is all useState/useRef, orthogonal to draft storage

**Edge cases**:
- After submission, `setDraft("")` clears React state but `savedDraft` still holds the old text. Must also write `savedDraft = ''` in the submit paths (handleKeyDown line 436, form onSubmit line 485).
- HMR: Vite HMR re-executes the module, resetting `savedDraft = ''`. Acceptable in dev.

**Verdict**: Viable. Simplest possible solution. Zero overhead. Recommended if page-refresh persistence is not needed.

### B. sessionStorage Written Imperatively

```ts
// At module scope
let savedDraft = sessionStorage.getItem('autonoma:draft') ?? '';

// Inside the component
const [draft, setDraft] = useState(() => savedDraft);

// In handleDraftChange:
const handleDraftChange = useCallback((value: string) => {
  savedDraft = value;
  sessionStorage.setItem('autonoma:draft', value);   // <-- write-through
  setDraft(value);
  // ... picker logic
}, [skills, computeSlashLeft]);
```

**Constraint check**:
- useEffect? None.
- React syncing? None.
- CPU cost? `sessionStorage.setItem` is synchronous. For typical draft strings (<1KB): **~0.01-0.05ms** in Chrome, Firefox, Safari. This is 0.025-0.125% of the 40ms budget. Effectively zero. However, for very long messages (>10KB), serialization overhead could reach 0.1-0.5ms. Still well within budget.
- Single source of truth? `savedDraft` module var is the primary; sessionStorage is a persistence backing store.

**Properties**:
- Survives route navigation: Yes
- Survives page refresh: Yes (sessionStorage persists within tab lifetime)
- Survives tab close: No (sessionStorage is per-tab, cleared on close)
- Multiple tabs: Independent (each tab has its own sessionStorage context)

**Edge cases**:
- Storage quota: sessionStorage has a 5-10MB quota. A draft won't hit this.
- SSR: `sessionStorage` doesn't exist on the server. The module-level read (`sessionStorage.getItem(...)`) must be guarded or placed in a client-only module. Since `message-input.tsx` is a client component used inside route components, and the TanStack Start SSR renders the route tree on the server, this line would throw during SSR. **Fix**: guard with `typeof window !== 'undefined'` or use the lazy init pattern inside useState only (which runs client-side).
- Must also clear sessionStorage on submit.

**Verdict**: Viable. Slightly more complex than (A) due to SSR guard. Adds page-refresh resilience. The per-keystroke sessionStorage write is measurably near-zero.

### C. Shared Ref Object Outside React Tree

```ts
const draftStore = { current: '' };
```

Functionally identical to approach (A) with `let savedDraft = ''`. The `{ current: '' }` wrapper adds no value since we're not passing it through React's ref system. It's just a variable with extra indirection.

**Verdict**: Viable but pointless over (A). Use (A) instead.

### D. Lifting State Above the Router

This means adding state at the AppShell or root level:

```tsx
function AppShell() {
  const [draft, setDraft] = useState("");  // lifted
  return (
    <DraftContext.Provider value={{ draft, setDraft }}>
      <Outlet />
    </DraftContext.Provider>
  );
}
```

**Constraint check**:
- React-based syncing mechanism? **Yes** -- this is a context provider that triggers React renders.
- CPU cost? Every keystroke updates context, potentially causing re-renders in consumers up the tree.

**Verdict**: Violates constraints. Rejected.

### E. DOM-Based (Hidden Input or Textarea Survival)

React owns the textarea. When MessageInput unmounts, React removes the textarea from the DOM. There is no way to keep a React-managed DOM node alive across route transitions without keeping the component mounted (which means lifting it above the router -- see D).

One variant: a hidden `<input>` placed in AppShell's DOM, written to imperatively. But this is just approach (A) with extra DOM overhead and no benefit.

**Verdict**: Not viable. React controls the DOM lifecycle.

### F. Keyed by Route (Per-Stream vs Global Draft)

The question: should navigating from Stream A to Stream B restore Stream A's draft when you return?

**Arguments for global (single draft)**:
- Simpler mental model -- "what I was typing" is one thing
- The user is unlikely to have half-written messages in multiple streams simultaneously
- MessageInput clears on submit anyway, so drafts are transient

**Arguments for per-stream keying**:
- Each stream is a separate conversation
- Navigating away and back shouldn't lose context
- Surface (/) is conceptually different from any individual stream

**Implementation cost for keying**:
```ts
// Module scope
const draftStore = new Map<string, string>();

// Inside the component -- needs a new prop for the key
const [draft, setDraft] = useState(() => draftStore.get(draftKey) ?? '');

// In handleDraftChange:
draftStore.set(draftKey, value);
```

The `draftKey` would be:
- `"__surface__"` for Surface (/)
- `streamId` or `piSessionId` for stream routes

ChatPanel already receives `streamId` as a prop. Surface has no streamId. MessageInput would need a new `draftKey?: string` prop, with the consumers providing the key.

**Verdict**: Per-stream keying is the richer UX. The implementation cost is trivial (Map instead of string, one new prop). Worth doing if the keyed behavior is desired.

## Recommendation

**Primary: Module-level Map + sessionStorage write-through (A+B+F combined)**

```ts
// web/src/components/common/message-input.tsx — module scope

const draftStore = new Map<string, string>();

// Hydrate from sessionStorage on first load (client only)
if (typeof window !== 'undefined') {
  try {
    const saved = sessionStorage.getItem('autonoma:drafts');
    if (saved) {
      const entries: [string, string][] = JSON.parse(saved);
      for (const [k, v] of entries) draftStore.set(k, v);
    }
  } catch { /* corrupt storage, start fresh */ }
}

function persistDrafts() {
  sessionStorage.setItem('autonoma:drafts', JSON.stringify([...draftStore]));
}
```

Inside the component:
```ts
// New prop
draftKey?: string;

// Initialization (lazy, runs once, no useEffect)
const [draft, setDraft] = useState(() => draftStore.get(draftKey ?? '__default__') ?? '');

// In handleDraftChange (already fires every keystroke):
const handleDraftChange = useCallback((value: string) => {
  const key = draftKeyRef.current ?? '__default__';
  draftStore.set(key, value);
  persistDrafts();           // sessionStorage write-through
  setDraft(value);
  // ... existing picker logic
}, [skills, computeSlashLeft]);

// In submit handlers -- clear the stored draft:
draftStore.delete(draftKeyRef.current ?? '__default__');
persistDrafts();
setDraft("");
```

Consumer changes:
```tsx
// Surface (surface.tsx)
<MessageInput draftKey="__surface__" ... />

// ChatPanel (chat-panel.tsx) -- use streamId when available
<MessageInput draftKey={streamId ?? piSessionId} ... />
```

### Why This Combination

| Property                        | Module var (A) | +sessionStorage (B) | +keying (F) |
|---------------------------------|:-:|:-:|:-:|
| Survives route nav              | Y | Y | Y |
| Survives page refresh           | N | Y | Y |
| Per-conversation drafts         | N | N | Y |
| Zero useEffect                  | Y | Y | Y |
| Zero React syncing              | Y | Y | Y |
| Zero measurable CPU cost        | Y | Y* | Y* |

*sessionStorage.setItem + JSON.stringify of a small Map is ~0.05ms per keystroke. The Map typically has 1-3 entries (surface + 1-2 open streams), so the serialized string is tiny.

### Simplification Option

If page-refresh persistence is not needed, drop sessionStorage entirely and use just the module-level Map. This is approach (A+F) -- zero external API calls, zero serialization, just Map.get/Map.set:

```ts
const draftStore = new Map<string, string>();
// That's it. No sessionStorage, no JSON, no SSR guard.
```

This is the absolute minimum viable solution and is what I recommend starting with. sessionStorage can be added later if refresh-persistence proves valuable.

## Changes Required

### Files Modified

| File | Change |
|------|--------|
| `web/src/components/common/message-input.tsx` | Add module-level `draftStore` Map. Add `draftKey` prop. Seed `useState` from Map. Write to Map in `handleDraftChange`. Clear Map entry on submit. |
| `web/src/components/surface.tsx` | Pass `draftKey="__surface__"` to MessageInput |
| `web/src/components/chat-panel.tsx` | Pass `draftKey={streamId ?? piSessionId}` to MessageInput |

### Lines of Code

- ~5 lines at module scope (Map declaration, optional sessionStorage hydration)
- ~3 lines in handleDraftChange (Map write, optional sessionStorage write)
- ~2 lines in each submit path (Map delete + optional sessionStorage write)
- ~1 line per consumer (add draftKey prop)
- Total: ~15 lines changed/added

### Risk Assessment

- **Stale draft after stream deletion**: If a stream is deleted, its draft entry persists in the Map. This is harmless (small memory footprint) but could show stale text if a new stream reuses the same ID. Mitigation: use stream IDs that don't recycle, or prune Map entries periodically.
- **Memory**: A Map with 100 entries of 1KB each = 100KB. Not a concern.
- **HMR**: Vite HMR re-executes the module, clearing the Map. Only affects dev experience. Acceptable.
- **Ref staleness for draftKey**: Since `draftKey` may change (e.g., ChatPanel re-renders with a new streamId), the handleDraftChange callback must use a ref to read the current key, not capture it in the closure. Use `draftKeyRef` pattern (same as existing `draftRef`, `onSubmitRef`).
