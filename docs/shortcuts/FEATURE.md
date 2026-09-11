# Keyboard shortcuts

## Contract

Shortcuts dispatch browser-page actions, not OS-global hotkeys. A shared static catalog defines each action's default bindings (each with its own input rule), repeat behavior, and handler owners in fallback order. Components supply implementations through one React registration hook. Registration order and numeric priorities do not affect dispatch.

The registry rejects complete-binding prefixes by default. `allowPrefixes: true` enables exact sequence matching on inactivity-timeout closure. This is a registry policy, not a parser limitation. Flitterbot explicitly opts in to preserve its existing `t a` and `t a a` tmux bindings without terminators. Its sequence timeout is 750 ms.

## Pseudocode contracts and call graph

```ts
type Binding = {
  keys: string;
  input?: "allow" | "ignore"; // defaults to allow; requires Alt/Ctrl/Cmd on every step
};

type Definition = {
  bindings: readonly Binding[];
  owners: readonly string[]; // first enabled owner wins
  repeat?: boolean; // false by default; applies to single-step shortcuts
};

type Handler = {
  enabled?: boolean | ((event: ShortcutKeyboardEvent) => boolean);
  run: (event: ShortcutKeyboardEvent) => void;
};

type Overrides = Partial<Record<ShortcutActionId, Binding[]>>;

createShortcutRegistry({
  catalog,
  overrides,
  allowPrefixes: false,
  sequenceTimeoutMs: 750,
});

useShortcuts("stream", {
  "stream.copy-worktree-path": {
    enabled: Boolean(worktreePath),
    run: () => copy(worktreePath!),
  },
});

useShortcuts("app", {
  "stream.copy-worktree-path": {
    run: () => toast.error("No worktree path available"),
  },
});
```

```text
Configuration
  ~/.flitterbot/config.json
    → loadConfig(): read file; validate shortcut values and effective bindings
    → runtime status response
    → TanStack Query ["status"]
    → ShortcutsProvider: atomically apply validated overrides

Registration
  mounted component
    → useShortcuts(owner, handlers)
    → instance registry: one registration per (owner, action)
    → token-safe cleanup on unmount

Keyboard
  local text/picker handlers get first refusal
    → provider window keydown listener
    → text-input editing preprocessor
    → input / composition / already-handled guards
    → compiled binding matcher
    → complete immediately OR close exact sequence after timeout
    → first enabled owner from action definition
    → execute one handler

Labels
  same effective compiled bindings
    → registry subscription
    → useShortcutBindingLabel(actionId)
    → navigation / model / composer / tmux hints

Tests
  shared catalog + registry + fake clock / keyboard events
    → parsing, validation, exact closure, ownership, cleanup
  product catalog tests
    → defaults compile without binding conflicts
```

`ShortcutKeyboardEvent` is the core's DOM-independent structural subset; native browser keyboard events satisfy it without conversion. Handler availability is checked before execution. A disabled owner permits the next declared owner for the same action; it does not permit another action to compete for the binding. `run` does not return an acceptance boolean. Synchronous failures—including a throwing availability predicate—are reported, not retried through a fallback. Handlers that start async operations own rejection handling.

Duplicate `(owner, action)` registrations and owner/action pairs absent from the catalog are errors. A batch either registers completely or changes nothing. Callback updates do not change ownership order. Unmount cleanup cannot delete a newer registration.

## Separation of duties

- `src/shortcuts/registry.ts`: framework-independent parser, formatter, validation, matching, sequence lifetime, and ordered owner dispatch. State belongs to an instance; the core does not query the DOM or import React.
- `src/shortcuts/catalog.ts`: Flitterbot action IDs, finite action families, defaults, owners, input/repeat policies, and its explicit prefix-policy override.
- `web/src/lib/shortcuts.tsx`: provider, one registration hook, label subscriptions, fresh React callbacks, browser listener lifecycle.
- `web/src/lib/shortcut-dom.ts`: browser focus/input checks and product DOM scroll targeting.
- Components and product hooks: navigation, mutations, clipboard, local form editing, search coordination, and virtualized message navigation.

No global mutable composer-focus slot, numeric priorities, raw component registration effects, arbitrary action discovery, or second binding parser is part of this contract.

## Binding grammar and validation

A binding is a whitespace-separated sequence of steps. A step combines modifiers with one key using `+`:

```text
Alt+KeyR         modifier plus physical key
Ctrl+KeyD        exact Control combination
g g             produced character g, then g
Shift+KeyG      Shift plus physical G position
Home            named browser key
```

Modifier aliases normalize to Alt/Ctrl/Meta/Shift. Exact code spellings (`KeyQ`, `ArrowUp`, `Home`) match `event.code`; lowercase named aliases (`home`, `up`) and single characters match `event.key`. Uppercase characters do not imply Shift. Physical keys and produced characters remain distinct; exact modifier state matters. Parser validation rejects malformed tokens rather than dropping empty pieces. Labels use the parsed representation, not a parallel string table.

The effective catalog is validated before use, including unmounted actions. Duplicate gestures across actions are rejected; key/code overlaps are checked conservatively because a physical key and produced character can refer to the same event. Owner fallbacks belong to one action and do not create duplicate gesture registrations. If a different keyboard layout creates a collision that static alias checks cannot prove, dispatch reports both actions instead of choosing by traversal order.

### Prefix policy

With the registry default `allowPrefixes: false`:

```text
Q A + Q B       valid shared prefix
Q + Q A         rejected complete-binding prefix
Q A + Q A B     rejected complete-binding prefix
Alt+R + Alt+R   rejected duplicate gesture
```

A complete binding executes immediately. The timeout only discards unfinished sequences.

With `allowPrefixes: true`, sequences close after inactivity:

```text
input: t a       closure: execute exactly t a
input: t a a     closure: execute exactly t a a
input: t a a b   closure: execute t a a b only if it exists; otherwise nothing
```

There is no eager sequence-leaf execution, shorter-prefix fallback, suffix restart, or terminator. Each collected key restarts the timeout. A bare single-key binding that prefixes a longer binding waits for closure too. Ordinary unambiguous modifier combinations remain immediate.

Sequence repeats do not advance progress. Modifier-only events neither advance nor terminate a sequence. Focus changes, window blur, teardown, or effective configuration changes cancel pending work. Delayed execution rechecks handler eligibility rather than calling an unmounted or disabled owner. Events that must be consumed are prevented when received, not retroactively at timeout.

### Input and repeat policies

Each binding has its own input rule; actions only define ownership and repeat behavior:

- `allow` (default): every binding step must require Alt, Ctrl, or Cmd. Registry creation and override validation reject bare or Shift-only steps, including unmodified tails in sequences.
- `ignore`: this binding does not run while a text input/select/contenteditable surface has focus, even if its keys include modifiers.

One action can combine `{ keys: "Alt+KeyF" }` and `{ keys: "Slash", input: "ignore" }`, with one search handler. Matching, prefix eligibility, and delayed execution check the matched binding, never another alternative's permission. Input-rule changes invalidate the effective config signature. Duplicate identical gestures with conflicting input rules are rejected. There is no blanket permission for bare keys while typing. Composition and already-prevented events are excluded. Local handlers stop propagation when consuming editing or picker commands.

Single-step repeat is opt-in. Scrolling and adjacent-stream selection allow repeat; creation, copying, and other commands do not repeat by default.

## Configuration

`shortcuts` is a required object in `~/.flitterbot/config.json`:

```json
{
  "shortcuts": {
    "nav.surface": [{ "keys": "Alt+KeyH" }],
    "scroll.top": [{ "keys": "Home", "input": "ignore" }],
    "scroll.full-page-down": [{ "keys": "Ctrl+KeyJ" }, { "keys": "Space", "input": "ignore" }],
    "panel.view.diff": []
  }
}
```

- Absent action: catalog defaults.
- Nonempty binding-object array: replace its bindings and input rules together. No string shorthand or inherited policy.
- Empty array: disable the action and remove its hint.
- Unknown action, wrong value type, blank string, invalid syntax, or collision: reject with an error. No silent partial parsing or default fallback.

Validation is shared by backend configuration loading and browser registry updates. Backend validation caches the last successfully validated shortcut value to avoid recompiling unchanged bindings on every runtime config read. A failed browser update leaves the prior valid effective bindings intact.

`Runtime.config` rereads the file on access. Edits become visible on the next successful status fetch; no backend restart is needed. WebSocket status/stream events and normal query refreshes fetch updated status. A failed request remains a query error and retains cached successful data; it does not fabricate an offline response that clears overrides.

## Component tree

```text
RootComponent
└─ ShortcutsProvider [one instance, configuration, browser lifecycle]
   ├─ root shortcut actions [owner: app]
   └─ AppShell / active route
      ├─ Sidebar [owner: sidebar]
      │    search focus, adjacent selection; local accept/cancel/rename keys
      ├─ Surface [main scroll container]
      └─ ChatPanel [owner: conversation]
         │    find, cwd editing, latest-user-message scroll override
         ├─ StreamsMessageList [virtualized main scroll container]
         ├─ MessageInput [owner: composer]
         │    composer focus, hover slot actions; local draft/completion keys
         ├─ ModelSelector [owner: model-selector]
         │    model search; local thinking-level navigation
         └─ DownstreamSessionsPanel [owner: stream]
              paths/branches, info/diff selection
              ├─ active tmux rows [owner: tmux, one action per session]
              └─ conditional diff scroll container
```

Root app fallbacks report unavailable paths/branches. Tmux commands exist only while their owning session rows are mounted; there is no catalog-wide collection of no-session toast handlers. Stream-specific owners take precedence only for the same action and only while enabled. `scroll.bottom` prefers the conversation owner, which navigates to the latest user message when main owns scrolling; otherwise the app handler scrolls the resolved container to its bottom.

Scroll target resolution queries mounted DOM on each action: the first diff container wins, otherwise the first main container. It is not pointer- or focus-based. Small/half/full scrolling moves 20%/60%/90% of viewport height. Top/bottom use absolute scroll positions.

Opening one search surface and dismissing another is UI coordination, not a side-effecting handler that declines after running. Normal widget keys remain local: submission, Escape, completion navigation, token deletion, and thinking-level changes are not arbitrary application bindings.

## Default catalog

```text
nav.surface                        Alt+KeyR
nav.last-stream                    Alt+KeyT
nav.stream.next / previous         Alt+ArrowDown / Alt+ArrowUp
nav.stream.slot.1…9                Alt+Digit1…9
swimlane.create                    Alt+KeyN
swimlane.search                    Alt+KeyF | Slash
model.search                       Alt+KeyM
conversation.find                  Meta+KeyF | Ctrl+KeyF | f
scroll.small-down / up             j / k
scroll.half-page-down / up         Ctrl+KeyD | d / Ctrl+KeyU | u
scroll.full-page-down / up         no default
scroll.top                         g g
scroll.bottom                      Shift+KeyG
composer.focus                     i
stream.copy-worktree-path           c w
stream.copy-repo-path               c r
stream.edit-current-directory      c d
stream.copy-branch                  c b
stream.copy-target-branch           c t
stream.copy-tmux-attach.<session>   t followed by session letters
panel.view.info / diff             Alt+KeyI / Alt+KeyK
message-input.button.slot.1…10     Alt+A/S/G/W/Y/E/Z/X/V/B
```

Tmux names cover `a`–`z`, then `aa`–`ax`. The session-specific `a` action owns `t a`; there is no separate generic action with the same gesture. External tmux names outside the finite catalog remain copyable but have no shortcut or hint. Composer slots five/six use Y/E rather than colliding with R/T navigation. Shortcut hints—including sidebar stream slots, composer slots, cwd controls, and two-letter tmux names—follow overrides and disabling. Multi-step labels separate steps with “then”; aliases and modifier order format canonically. Navigation and sidebar rows share one stream-slot target calculation. The old hardcoded “Press f” find hint is absent because it could contradict remapping or disabling.

## Files

- `src/shortcuts/registry.ts` — core instance, compiler/validation, matcher, formatter, timers, owners.
- `src/shortcuts/catalog.ts` — static product definitions and registry options.
- `src/shortcuts.test.ts` — core contracts: validation, atomic updates, ownership, lifecycle, input policy, exact-buffer matching, and keyboard-layout ambiguity.
- `src/shortcut-catalog.test.ts` — product defaults compile without binding conflicts.
- `web/tests/text-input.test.ts` — token editing must decline composition and consumed events.
- `src/config/load-config.ts`, `src/contracts/control-surface-api.ts` — validated, typed override boundary.
- `web/src/lib/shortcuts.tsx`, `web/src/lib/shortcut-dom.ts` — React/browser integration.
- `web/src/hooks/use-global-shortcuts.ts`, `web/src/routes/__root.tsx` — app handlers and provider mounting.
- `web/src/lib/queries.ts`, `web/src/lib/types.ts`, `web/src/routes/runtime.tsx` — status data/error contract and visible runtime errors.
- `web/src/lib/stream-route-targets.ts` — shared navigation/hint slot ordering.
- `web/src/components/sidebar.tsx`, `model-selector.tsx`, `chat-panel.tsx`, `downstream-sessions-panel.tsx`, `common/message-input.tsx` — registrations and reactive labels.
- `web/src/hooks/use-textarea-completions.tsx`, `web/src/lib/text-input.ts`, `web/src/components/chat-tool-message.tsx` — local keyboard boundaries.
- `web/src/components/streams-message-list.tsx`, `surface.tsx` — scroll targets and virtualized navigation.
