# Web UI Primitives Discussion Spec

## Purpose

Flitterbot web has a primitive system, but it is split:

- `web/src/components/ui/*` — shadcn/Base UI generated primitives. Managed directory; leave untouched except through shadcn-style generation/update flows.
- `web/src/components/common/*` — hand-written app primitives and composites.

Goal: agree on a stricter primitive system for buttons, inputs, panels, menus, badges, status indicators, copy controls, drawers, and form controls before any broad refactor.

## Current primitive inventory

### Shadcn/Base UI primitives (`web/src/components/ui/`)

- `button.tsx` — Base UI button with `cva` variants `default`, `outline`, `secondary`, `ghost`, `destructive`, `link`; sizes `default`, `xs`, `sm`, `lg`, icon sizes.
- `dialog.tsx` — Base UI dialog wrapper: overlay, popup, header/footer/title/description/close button.
- `command.tsx` — cmdk command primitives: dialog/input/list/item/group/empty/separator/shortcut.
- `input-group.tsx` — grouped input shell/addons/buttons/text/input/textarea; imports `common/Input` and `ui/Button`.
- `textarea.tsx` — standalone textarea primitive.
- `toggle.tsx`, `toggle-group.tsx` — Base UI toggle/toggle-group wrappers.

### App/common primitives (`web/src/components/common/`)

- `button.tsx` — separate button, not backed by `ui/button`; overlapping variants, different sizing/ring/active/`as/render` behavior.
- `input.tsx` — standalone input, used by settings and `ui/input-group`.
- `card.tsx` — Card, CardHeader, CardTitle, CardDescription, CardContent.
- `badge.tsx` — variants `default`, `muted`, `error`, `success`, `warning`.
- `copyable-code.tsx` — clickable `span` copy control.
- `message-input.tsx` — large composer composite with bespoke textarea, attach/remove buttons, hover suggestion buttons, send/stop/recover actions.
- `resizable.tsx` — Panel/PanelGroup/ResizeHandle wrappers.
- `markdown-content.tsx` — content renderer, not an interaction primitive.

## Main architectural issue

The app has both generated `ui/*` primitives and app-facing `common/*` primitives. `common/Button` is acceptable as the app button source; the stricter primitive work should focus on controls still hand-rolled around it: keyboard shortcut hints, command popovers, copy controls, status dots/pills, drawers, menus, badges, and form controls.

## Mega-list: non-primitive or inconsistent usages

### Buttons and button-like controls

- `web/src/components/common/message-input.tsx:263` — raw hover suggestion `<button>` with custom `h-10 sm:h-7`, border/background/focus classes; needs compact “composer suggestion/chip button” primitive or Button variant/size.
- `web/src/components/common/message-input.tsx:910` — raw absolute circular destructive pending-image remove button, no accessible label; needs icon/destructive icon button primitive and `aria-label`.
- `web/src/components/common/message-input.tsx:958` — raw composer `<textarea>` instead of `ui/textarea` or app `Textarea`; needs composer textarea primitive or explicit `Composer` composite exception.
- `web/src/components/common/message-input.tsx:972` — raw attach-image icon button, `tabIndex={-1}`, title-only label; needs icon button primitive and accessible-label policy, including whether it should be tabbable or intentionally shortcut-only.
- `web/src/components/surface.tsx:323` — raw “Read more / Show less” text button; needs `Button variant="link/ghost" size="xs"` or `DisclosureButton`.
- `web/src/components/surface.tsx:375` — raw absolute message-copy icon button, title-only label; needs shared `CopyButton` / `IconButton`.
- `web/src/components/surface.tsx:848` — raw settings gear icon button; needs shared `IconButton`.
- `web/src/components/runtime-health-indicator.tsx:46` — raw `<button>` used for navigation; needs `StatusNavButton` or link-based navigation primitive if it represents route navigation.
- `web/src/components/settings-drawer.tsx:45` — raw `<div onClick>` backdrop; needs Drawer/Dialog primitive with Base UI dialog/dismissable semantics.
- `web/src/components/settings-drawer.tsx:51` — raw text `×` close button, missing title/label; needs Dialog/Drawer close primitive or shared icon button.
- `web/src/components/settings-drawer.tsx:67` — raw theme-choice buttons with active/inactive custom classes; needs ToggleGroup or SegmentedControl.
- `web/src/components/settings-drawer.tsx:106` — raw checkbox with minimal Tailwind; needs Checkbox/Switch primitive and label/hit-target standard.
- `web/src/components/model-selector.tsx:168` — Base UI `Menu.Trigger` styled directly; needs Dropdown/Menu trigger composing app Button.
- `web/src/components/model-selector.tsx:277` — raw menu search `<input>`; needs primitive input/search field or CommandInput-like control.
- `web/src/components/model-selector.tsx:333` — raw thinking-level pill buttons; needs ToggleGroup/SegmentedControl.
- `web/src/components/model-selector.tsx:398` — directly styled `Menu.Item`, with row hover on parent `div`; needs MenuItem primitive owning highlight/selected/disabled states.
- `web/src/components/model-selector.tsx:418` — raw pin/star icon button inside menu row; needs icon button primitive and consistent disabled/focus styles.
- `web/src/components/common/copyable-code.tsx:12` — clickable `span`, not keyboard-accessible by default; needs copy control rendered as button or Button-rendered inline control.
- `web/src/components/not-found.tsx:14` — raw Back button; needs app Button.
- `web/src/components/default-catch-boundary.tsx:28` — raw button with legacy `button button-secondary` classes outside current primitive system; needs app Button.
- `web/src/pi-web-ui/chat-components.ts:199,301,362,415,986,1003` — Lit raw buttons for copy, code copy, console copy, thinking toggle, message actions, prune menu item; needs Lit-compatible primitive layer or explicit boundary: legacy Pi web UI owns its style system until removed.

### Panels, cards, surfaces, containers

- `web/src/components/surface.tsx` — one-off message bubbles, stream badges, outbound/inbound/hook row panels, empty state, header; needs `Panel`, `MessageBubble`, `StatusBadge`, `EmptyState` primitives/composites.
- `web/src/components/downstream-sessions-panel.tsx` — one-off right panel shell, status banner, section headers, summary warning, active-session rows, worktree rows; needs `SidePanel`, `SectionHeader`, `StatusPill`, `KeyValueRow`, `CopyToken`.
- `web/src/components/sidebar.tsx` — hand-rolled nav item, stream rows, status dot, section labels; needs `NavItem`, `StreamListItem`, `StatusDot`, `SidebarSection`.
- `web/src/components/chat-panel.tsx:520` — hand-rolled header/title/cwd row; needs `PageHeader` / `ChatHeader`.
- `web/src/components/settings-drawer.tsx` — hand-rolled drawer despite existing `ui/dialog`; needs `Drawer`, likely Base UI Dialog-based, not ad hoc fixed panel.
- `web/src/components/common/card.tsx` — Card only exists in `common` while shadcn-style primitives live in `ui`; decide placement: app primitives outside `ui`, or generated/card primitive plus app wrapper. Do not leave both patterns ambiguous.

### Menus, command pickers, popovers

- `web/src/components/model-selector.tsx` — uses Base UI Menu directly instead of shared `DropdownMenu`; popup, sections, rows, auth badges, pin actions, thinking toggle, search box are custom. Missing: `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `MenuSection`, `MenuSearch`, `MenuActionButton`.
- `web/src/components/path-picker.tsx` — uses `ui/command`, but custom portal/positioner and local item classes; needs shared `FloatingCommandPicker` for slash/path pickers.
- `web/src/components/skill-picker.tsx` — same as PathPicker: `ui/command` plus local portal/positioning and repeated list/item styling; needs shared `FloatingCommandPicker`.
- `web/src/pi-web-ui/chat-components.ts:986` — hand-rolled message actions menu with `role="menu"` and button `role="menuitem"`; needs Base UI Menu or legacy boundary decision.

### Inputs and forms

- `web/src/components/settings-drawer.tsx:90,98` — uses `common/Input`, not `ui/input-group` or unified app Input; needs one Input primitive source.
- `web/src/components/model-selector.tsx:277` — raw search input; stops key propagation because Base UI Menu typeahead steals focus. `MenuSearch` should own this interaction.
- `web/src/components/common/message-input.tsx:921` — hidden file input is valid implementation detail, but attach control should be primitive-driven.
- `web/src/components/common/message-input.tsx:958` — bespoke composer textarea with custom parent focus ring; should become first-class `Composer` composite, not pretend to be a normal textarea.

### Badges, status, copy tokens

- `web/src/components/common/badge.tsx` — Badge exists, but much of the app does not use it.
- `web/src/components/surface.tsx:408` — custom blue `StreamBadge` pill/link; needs Badge variant/link mode.
- `web/src/components/model-selector.tsx:464` — custom `AuthBadge` for `subscription/api key/no auth`; needs Badge variants or semantic `AuthBadge` built on Badge.
- `web/src/components/runtime-health-indicator.tsx`, `web/src/components/sidebar.tsx`, `web/src/components/downstream-sessions-panel.tsx` — duplicated status dot functions/color mappings; need shared `StatusDot` and `StatusPill` with semantic status mapping.
- `web/src/components/common/copyable-code.tsx` — copy token is inaccessible and not shared with message/code copy buttons; needs `CopyButton`, `CopyToken`, likely `CopyableCodeBlock` variants.

## Missing primitives for a stricter system

### Foundation exports outside `components/ui/`

Feature code should not import shadcn-managed components directly unless the file is itself a primitive/composite. Create a stable app layer: e.g. `web/src/components/primitives/`, or make `common/` the only app-facing layer.

Required foundation set:

- `Button` — keep `common/Button` as the app-facing button with semantic variants and app sizes.
- `IconButton` — button with required accessible label and icon sizing.
- `Input` — one source; choose generated input style or current common input.
- `Textarea` — one source.
- `Checkbox` / `Switch` — includes label/hit-target.
- `Badge` — semantic variants plus optional link/render behavior.
- `StatusDot`, `StatusPill` — shared runtime/session/stream/connection/auth status mapping.
- `Card` / `Panel` / `Section` — app surfaces with header/content/footer.
- `Dialog`, `Drawer` — Base UI wrappers; settings drawer should use Drawer.
- `DropdownMenu` — Base UI Menu wrapper; model selector should not style Base UI Menu directly.
- `CommandPicker` / `FloatingCommandPicker` — shared shell for skills and paths.
- `CopyButton`, `CopyToken`, `CopyableCodeBlock` — one copy interaction pattern.
- `SegmentedControl` — wraps ToggleGroup for theme/thinking/info-diff choices.
- `NavItem` / `ListItemButton` — link/button rows for sidebar and menus.
- `EmptyState`, `SectionHeader`, `KeyValueRow` — repeated structural primitives.

### Composite components worth systemizing

- `Composer` — textarea, attachment button, pending image chips, hover suggestion chips, model selector slot, send/stop/recover buttons.
- `MessageBubble` — sender/source badge, copy action, overflow disclosure, image stack.
- `SidePanel` — right-panel shell, headers, scroll regions, sections.
- `ModelDropdown` internals — menu search, section, row, pin action, auth badge, thinking segmented control.

## Proposed cutover plan

1. Keep `common/` as the app-facing primitive layer and leave `web/src/components/ui/` shadcn-managed.
2. Add missing primitives around accepted `common/Button`: `Kbd`/`KbdGroup`, `IconButton`, status, copy, menu, drawer, and form controls.
3. Collapse input/textarea duplication.
   - Move one Input source into primitives; update `ui/input-group` if needed.
   - Replace raw settings/model search/composer controls where appropriate.
4. Add status/badge/copy primitives.
   - Replace local status dot functions in runtime/sidebar/downstream panel.
   - Replace `CopyableCode` clickable span with accessible copy token.
   - Replace message copy icon buttons with `CopyButton`.
5. Add menu/drawer/segmented primitives.
   - Convert settings drawer from fixed divs to Drawer.
   - Convert theme/thinking toggles to SegmentedControl.
   - Wrap Base UI Menu in DropdownMenu primitives before further model selector cleanup.
6. Systemize panel/list/message surfaces.
   - Convert downstream panel and sidebar rows after foundations are stable.
   - Convert surface message bubbles and stream badges last; they are dense and performance-sensitive.
7. Decide the Lit `pi-web-ui` boundary.
   - If legacy/soon removed, document it as outside React primitive migration.
   - If user-facing long-term, create Lit-compatible class helpers or web-component primitives mirroring React tokens and accessibility rules.

## Discussion decisions needed

- Which feature code may import `components/ui/*` directly, versus app-facing `common/*`?
- Keep expanding `common/` as the primitive layer, or split generic primitives later?
- Is `pi-web-ui/chat-components.ts` in scope or a legacy boundary?
- Should `Composer` stay bespoke, or should its sub-controls use normal primitives wherever possible?
- Enforcement level: documentation only, import restriction, or custom lint rule?

## Acceptance criteria for implementation phase

- `common/Button` remains the app-facing Button for React feature code.
- One Input and one Textarea source of truth.
- Icon-only controls require accessible labels through the primitive API.
- Copy actions are keyboard-accessible and share feedback behavior.
- Menus/drawers use Base UI-backed primitives, not hand-rolled positioning/backdrop/menu roles.
- Status dots/pills and badges use shared semantic mappings.
- No changes inside `web/src/components/ui/` unless intentionally regenerated through the shadcn-managed path.
