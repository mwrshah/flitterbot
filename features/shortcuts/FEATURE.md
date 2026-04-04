# Keyboard Shortcuts

Action-based keyboard shortcut system with vim-inspired bindings, user-overridable config, and support for both modifier combos and multi-key sequences.

## How It Works

Actions are defined with default bindings in `global-shortcuts.ts`. A single `keydown` listener on `window` matches events against parsed bindings and dispatches to registered handlers. Handlers are sorted by priority (highest first), then registration order (latest first). The first handler that returns a truthy value consumes the event.

Components register handlers via `registerShortcutHandler(actionId, handler, { priority })`. The hook `useGlobalShortcuts` wires up the root-level handlers (navigation, scrolling, composer focus) and attaches the keydown listener.

## Binding Types

**Combo** — single-step with modifiers: `Alt+KeyR`, `Ctrl+KeyD`. Matched on every keydown.

**Sequential** — multi-step sequences: `g g`, `c t`. After the first step matches, a 500ms timeout window opens for the next step. Repeating keys (`event.repeat`) cannot start or continue sequences.

**Availability modes:**
- `always` — fires even when an input/textarea is focused (modifier combos)
- `no-input-focus` — only fires when no input element is focused (bare keys)

When a user overrides a binding, availability is inferred from the spec: if any step contains Alt, Ctrl, or Meta → `always`, otherwise → `no-input-focus`.

## Config Override

Users override bindings via `AppConfig.shortcuts` (`ShortcutBindingsConfig`), a partial record of action ID → spec string or string array. If an override fails to parse, the action falls back to its default bindings.

```ts
type ShortcutBindingsConfig = Partial<Record<string, string | string[]>>;
// Example: { "nav.surface": "Alt+KeyH", "scroll.top": "Home" }
```

## Built-in Actions

| Action ID | Default Binding(s) | Description |
|---|---|---|
| `nav.surface` | `Alt+R`, `r` | Navigate to home surface |
| `nav.last-stream` | `Alt+T`, `t` | Navigate to last active stream |
| `scroll.half-page-down` | `Ctrl+D`, `d` | Scroll half page down |
| `scroll.half-page-up` | `Ctrl+U`, `u` | Scroll half page up |
| `scroll.full-page-down` | `Ctrl+F`, `f` | Scroll full page down |
| `scroll.full-page-up` | `Ctrl+B`, `b` | Scroll full page up |
| `scroll.top` | `g g` | Scroll to top |
| `scroll.bottom` | `Shift+G` | Scroll to bottom |
| `composer.focus` | `i` | Focus the composer input |
| `stream.copy-tmux-attach` | `c t` | Copy tmux attach command |
| `stream.copy-worktree-path` | `c w` | Copy worktree path |
| `panel.view.info` | `Ctrl+I` | Switch to Info panel view |
| `panel.view.diff` | `Ctrl+K` | Switch to Diff panel view |
| `nav.stream.slot.{1-9}` | `Alt+{1-9}`, `Alt+{m,comma,period,j,k,l,u,i,o}` | Navigate to stream by slot |

## Files

| File | Role |
|---|---|
| `web/src/lib/global-shortcuts.ts` | Core engine: definitions, parsing, matching, dispatch |
| `web/src/hooks/use-global-shortcuts.ts` | React hook: wires handlers + keydown listener at root |
| `web/src/lib/types.ts` | `ShortcutBindingsConfig` type, part of `AppConfig` |
| `web/src/components/sidebar.tsx` | Displays shortcut labels in navigation |
| `web/src/components/downstream-sessions-panel.tsx` | Registers stream-specific shortcut handlers |
| `web/src/components/common/message-input.tsx` | Registers composer focus target |
| `web/src/routes/__root.tsx` | Calls `useGlobalShortcuts` at root level |
