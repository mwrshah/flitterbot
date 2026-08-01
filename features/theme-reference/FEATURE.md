# Canonical Theme System

## Problem

Flitterbot has two color systems loaded at once. `styles.css` owns the shadcn vocabulary while `alternate-theme.css` owns the approved semantic vocabulary under `.alternate-theme`. The `@source inline(...)` expression is a Tailwind safelist for dynamically named reference utilities; it is not an old-to-new compatibility map. The duplicate scopes and value sources are the compatibility problem.

The application contains old color utilities across 38 TS, TSX, and CSS files, plus literal palette classes and component-local colors. App-owned call sites need canonical roles. Shadcn is different: `components.json` enables CSS variables for the Base Nova style, and generated components use shadcn's documented utility contract. One stylesheet adapter supplies that contract from canonical app tokens so generated components stay compatible with the shadcn CLI.

## Goals

- `styles.css` is the single source of truth for all light and dark theme colors.
- App-owned code uses only the canonical background, text, and border families.
- Generated `components/ui/**` files keep shadcn's documented vocabulary and receive colors through one adapter in `styles.css`.
- Hover, selected, focus, disabled, pop, and contrast states use explicit semantic tiers.
- Status, syntax highlighting, diffs, and scrims use narrowly scoped canonical specialist tokens.
- No duplicate value source, route scope, safelist, component mapping, or compatibility layer exists outside the required shadcn adapter.
- No component owns literal theme colors or Tailwind palette colors.
- `/theme` documents the same global tokens used by every application surface.

## Canonical Contract

```ts
type BackgroundFamily = {
  background: Color
  backgroundMuted: Color
  backgroundHover: Color
  backgroundSelected: Color
  backgroundPop: Paint
  backgroundContrast: Color
  backgroundContrastMuted: Color
}

type TextFamily = {
  text: Color
  textMuted: Color
  textPop: Color
  textContrast: Color
  textContrastMuted: Color
}

type BorderFamily = {
  border: Color
  borderMuted: Color
  borderPop: Color
}

type FlitterbotStatusFamily = {
  active: Color
  activeMuted: Color
  supervising: Color
  supervisingMuted: Color
  waiting: Color
  waitingMuted: Color
  info: Color
  infoMuted: Color
  idle: Color
  idleMuted: Color
  stale: Color
  staleMuted: Color
  ended: Color
  endedMuted: Color
  crashed: Color
  crashedMuted: Color
}

type SpecialistFamily = {
  scrim: Color
  syntax: SyntaxColors
  diff: DiffColors
}

textContrast = background
textContrastMuted = backgroundMuted
backgroundContrast = text
backgroundContrastMuted = textMuted
```

The core surface trajectory is always `background` → `background-muted` → `background-hover` → `background-selected`, moving from the ordinary surface toward persistent selection. The approved values below are locked; changing one requires light/dark review on `/theme` before implementation.

The contrast pairs are first-class tokens with derived values. `text-contrast` and `text-contrast-muted` alias `background` and `background-muted`; `background-contrast` and `background-contrast-muted` alias `text` and `text-muted`. Inverse pairings follow light and dark changes without separate color values. `background-pop` always owns its paint value; even when it visually matches another token, it never aliases that token.

Core Tailwind utilities derive directly from the core variables:

```text
bg-background | bg-background-muted | bg-background-hover | bg-background-selected | bg-background-pop
bg-background-contrast | bg-background-contrast-muted
text-text     | text-text-muted      | text-text-pop
text-text-contrast | text-text-contrast-muted
border-border | border-border-muted | border-border-pop
ring-border   | ring-border-muted   | ring-border-pop
```

## Approved Value Lock

These are the approved cutover values. `styles.css` becomes their sole owner; `alternate-theme.css` holds them only until cutover.

Light:

```css
--background: oklch(0.985 0.002 80);
--background-muted: oklch(0.974 0.0025 73);
--background-hover: oklch(0.956 0.0053 73);
--background-selected: oklch(0.936 0.0086 73);
--background-pop: transparent;
--background-pop-image: linear-gradient(
  135deg,
  rgba(217, 79, 0, 0.12),
  rgba(255, 107, 0, 0.12),
  rgba(212, 165, 0, 0.12)
);
--background-contrast: var(--text);
--background-contrast-muted: var(--text-muted);
--text: oklch(0.18 0.006 255);
--text-muted: oklch(0.48 0.008 255);
--text-pop: oklch(0.4 0.18 240);
--text-contrast: var(--background);
--text-contrast-muted: var(--background-muted);
--border: oklch(0.89 0.006 95);
--border-muted: oklch(0.93 0.004 95);
--border-pop: rgba(255, 107, 0, 0.25);
```

Dark:

```css
--background: oklch(0.145 0.002 80);
--background-muted: oklch(0.177 0.0025 80);
--background-hover: oklch(0.222 0.0054 80);
--background-selected: oklch(0.272 0.0074 80);
--background-pop: oklch(0.64 0.16 48 / 0.15);
--background-pop-image: none;
--background-contrast: var(--text);
--background-contrast-muted: var(--text-muted);
--text: oklch(0.9 0.012 90);
--text-muted: oklch(0.68 0.01 90);
--text-pop: oklch(0.82 0.14 78);
--text-contrast: var(--background);
--text-contrast-muted: var(--background-muted);
--border: oklch(0.38 0.006 130);
--border-muted: oklch(0.3 0.005 130);
--border-pop: oklch(0.64 0.13 55 / 0.28);
```

Flitterbot status utilities use `status-active`, `status-supervising`, `status-ended`, and `status-crashed`, each with a muted companion. `status-waiting`, `status-info`, `status-idle`, and `status-stale` are semantic aliases of one orange attention color. Status treatments use dots or muted fills with text and never add status-colored borders. Syntax, diff, and scrim variables remain specialist stylesheet contracts rather than aliases for general UI colors.

Light statuses, whose muted companions use 22% of their base:

```css
--status-active: oklch(0.74 0.15 145);
--status-supervising: oklch(0.81 0.15 125);
--status-stale: oklch(0.83 0.16 45);
--status-ended: oklch(0.75 0.008 100);
--status-crashed: oklch(0.78 0.17 25);
```

Dark statuses, whose muted companions use 15% of their base, followed by the semantic aliases shared by both themes:

```css
--status-active: oklch(0.62 0.12 145);
--status-supervising: oklch(0.66 0.11 125);
--status-stale: oklch(0.64 0.13 55);
--status-ended: oklch(0.52 0.008 100);
--status-crashed: oklch(0.6 0.14 25);

--status-waiting: var(--status-stale);
--status-info: var(--status-stale);
--status-idle: var(--status-stale);
```

## Shadcn Boundary

Flitterbot keeps shadcn's documented Tailwind contract because `components.json` uses `cssVariables: true` with Base Nova. `styles.css` contains one adapter that maps shadcn variables to canonical app tokens; it owns no color values.

The `@theme inline` block declares the canonical app utilities first, then the shadcn boundary utilities; the excerpt below is abridged, and the real block spells out the complete documented shadcn contract.

```css
@theme inline {
  --color-text: var(--text);
  --color-background-muted: var(--background-muted);
  --color-background-hover: var(--background-hover);

  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
}
```

In `:root`, the canonical values come first and are the only entries holding real colors; every adapter alias after them is a pure `var()` reference.

```css
:root {
  --text: <approved-color>;
  --background-muted: <approved-color>;
  --background-hover: <approved-color>;

  --foreground: var(--text);
  --card: var(--background);
  --card-foreground: var(--text);
  --primary: var(--text);
  --primary-foreground: var(--text-contrast);
  --muted: var(--background-muted);
  --muted-foreground: var(--text-muted);
  --accent: var(--background-hover);
  --accent-foreground: var(--text);
  --destructive: var(--status-crashed);
  --ring: var(--border-pop);
}
```

Generated files under `web/src/components/ui/**` keep stock shadcn classes such as `bg-primary` and `text-muted-foreground`. App components, routes, common wrappers, and adapters use canonical app utilities. Adding a shadcn component does not create another translation layer.

## Semantic Cutover Rules

The migration is contextual rather than a global search-and-replace:

```text
legacy foreground                         → text
legacy muted-foreground                   → text-muted
legacy accent-foreground / emphasized link→ text-pop
legacy primary button fill                → bg-text + text-text-contrast
legacy subtly contrasted panel            → background-muted + text
legacy background / card / popover         → background
legacy sidebar                            → background
legacy muted / secondary surface           → background-muted
legacy hover                                → background-hover
legacy selected                             → background-selected
legacy input                               → border or border-muted
legacy ring                                → border-pop
legacy border / sidebar-border             → border or border-muted
legacy destructive                         → status-crashed / status-crashed-muted
literal status palette classes             → status-{meaning} tokens
literal user-message gradient and border   → background-pop + border-pop
```

Opacity is not used to manufacture hierarchy. Existing `/20`, `/50`, `/80`, and similar color modifiers become the appropriate explicit muted, selected, contrast, or specialist token. Disabled controls apply state opacity to the whole control only.

## Architecture and Call Graph

```text
styles.css
  → canonical light/dark values
  → @theme inline canonical app utilities
  → shadcn adapter aliases (no values)
    → generated components/ui primitives keep stock shadcn classes
  → base element defaults
  → specialist adapters (toast, markdown, syntax, diff, scrim)
    → app utilities
      → common wrappers
      → application components and routes
      → vendored pi-web-ui adapter
      → /theme live reference

useTheme()
  → toggles .dark on documentElement
    → one global variable set changes every application surface
```

`alternate-theme.css`, `.alternate-theme`, duplicate token values, and the inline utility safelist do not exist in the target architecture. Shadcn aliases exist only in the documented adapter block.

## Component Tree

```text
<Root>
├── <Sidebar>                         [background tiers; no sidebar palette]
├── <RouteSurface>                    [background tiers]
│   ├── shared/common primitives      [canonical core and status utilities]
│   ├── generated ui primitives       [stock shadcn utilities through adapter]
│   ├── chat and message surfaces     [background tiers; user message uses background-pop]
│   ├── runtime/downstream surfaces   [core + status utilities]
│   └── overlays/dialogs/menus        [background + scrim]
└── <ThemeReferencePage>              [reads the same global variables]
```

No component owns theme state beyond `useTheme`, synchronizes colors in React, or receives old/new token translation props.

## Cutover Inventory

The cutover covers every current semantic or palette-color caller under `web/src`:

- **Foundation and adapters:** `styles.css`, `alternate-theme.css`, `pi-web-ui.css`, `pi-web-ui/chat-components.ts`.
- **Shared app primitives:** `components/common/badge.tsx`, `button.tsx`, `card.tsx`, `copyable-code.tsx`, `input.tsx`, `kbd.tsx`, `markdown-content.tsx`, `message-input.tsx`, and `resizable.tsx`.
- **Application surfaces:** `components/auth-providers-section.tsx`, `chat-panel.tsx`, `downstream-sessions-panel.tsx`, `model-selector.tsx`, `not-found.tsx`, `path-picker.tsx`, `runtime-health-indicator.tsx`, `settings-drawer.tsx`, `sidebar.tsx`, `skill-picker.tsx`, `streams-message-list.tsx`, `surface.tsx`, and `whatsapp-controls.tsx`.
- **Routes:** `routes/index.tsx`, `runtime.tsx`, `streams.$piSessionId.tsx`, `streams.route.tsx`, and `theme.tsx`.
- **Generated shadcn callers, audited but not rewritten:** `components/ui/button.tsx`, `command.tsx`, `context-menu.tsx`, `dialog.tsx`, `input-group.tsx`, `textarea.tsx`, and `toggle.tsx`.

The structural `Card` component API remains a layout abstraction; its colors use canonical background tokens and do not create a card color family. The integration audit repeats the inventory search so newly added callers cannot escape the cutover.

## Cutover Plan

### 1. Lock the canonical stylesheet

- Move the approved values and canonical `@theme inline` declarations from `alternate-theme.css` into `styles.css`.
- Add canonical status and scrim tokens required by existing behavior.
- Keep syntax and diff colors as specialist contracts in `styles.css`.
- Keep `shadcn/tailwind.css` and implement the complete documented shadcn variable contract as one adapter block.
- Map each shadcn alias to a canonical app token; the adapter contains no OKLCH, HSL, RGB, or hex values.
- Replace base styles and non-shadcn stylesheet adapters with canonical variables.
- Delete duplicate legacy values, unused chart tokens, `alternate-theme.css`, its import, `.alternate-theme`, and `@source inline(...)`.

### 2. Migrate shared primitives

- Convert `web/src/components/common/**` first because application surfaces inherit its recipes.
- Keep generated `web/src/components/ui/**` files aligned with the installed shadcn version. Do not rewrite their stock color vocabulary.
- Confirm every shadcn utility used by generated components resolves through the central adapter.
- Rebuild app-owned button variants around default, subtle, selected, pop, and danger recipes.

### 3. Migrate application surfaces in parallel

After the stylesheet contract and primitives are fixed, use disjoint file ownership:

1. **Shell and routes** — sidebar, settings, auth, path/skill/model selectors, route layouts, not-found, and route pages.
2. **Messaging** — chat panel, message input/list, surface rendering, `pi-web-ui.css`, and `pi-web-ui/chat-components.ts`.
3. **Runtime and downstream** — runtime health, downstream sessions, WhatsApp controls, status badges, and diff containers.

Each stream migrates app-owned semantics at the call site and removes palette literals. Only the foundation owner edits the shadcn adapter. Shared stylesheet or primitive changes return to that owner rather than being duplicated across streams.

### 4. Rebuild the reference as a global audit surface

- Remove the route-level alternate scope.
- Keep live swatches and interaction recipes.
- Show only utilities the final stylesheet actually supports.
- Include status and specialist examples separately from the core families.

### 5. Prove deletion and parity

- Search app-owned code outside `components/ui/**` for every shadcn-only variable and utility family; the result is empty.
- Search TS, TSX, and adapter CSS for Tailwind palette colors and literal theme colors; the result is empty.
- Audit the adapter against the installed shadcn contract and every utility used under `components/ui/**`.
- Verify `alternate-theme.css`, `.alternate-theme`, duplicate value sources, component-level mappings, and safelists are absent.
- Run Biome, TypeScript, Knip, and the repository test suite.
- Human-check light and dark shell, sidebar, dialogs, menus, forms, chat/user messages, markdown, runtime statuses, downstream diffs, disabled states, hover, selection, and keyboard focus.

## Parallelization Gates

```text
Gate 1: canonical stylesheet + shadcn adapter + status contract approved
  ↓
Gate 2: common primitives migrated; generated shadcn primitives audited
  ↓
Parallel: shell/routes | messaging | runtime/downstream
  ↓
Gate 3: integration grep + static checks
  ↓
Gate 4: light/dark human visual review
  ↓
Delete any migration-only notes; retain this FEATURE.md only
```

## Acceptance Criteria

- One global theme scope supplies the entire app.
- Every color value resolves to a canonical variable in `styles.css`.
- Shadcn terms remain only in the central adapter and generated `components/ui/**` files.
- The shadcn adapter maps to canonical variables and owns no color values.
- App-owned code contains no shadcn-only term, arbitrary palette class, or component-local theme literal.
- `/theme` demonstrates both `background → background-hover` and `background-muted → background-hover`; selection remains a distinct tier.
- The focus recipe uses a real input control and `border-pop` so keyboard focus can be reviewed directly.
- User messages use `background-pop` and the approved border in both modes.
- Status meaning remains explicit through canonical status tokens, labels, and icons.
- Light and dark appearances pass human review without route-local overrides.

## Files

- `web/src/styles.css` — modify: sole canonical theme, base rules, and specialist tokens.
- `web/src/alternate-theme.css` — remove: alternate scope and duplicate token source.
- `web/src/routes/theme.tsx` — modify: global canonical reference without alternate scoping.
- `web/src/pi-web-ui.css` — modify: canonical markdown, syntax, message, and adapter colors.
- `web/src/pi-web-ui/chat-components.ts` — modify: canonical message-component utilities.
- `web/src/components/ui/**` — audit: keep generated recipes aligned with shadcn and verify adapter coverage.
- `web/src/components/common/**` — modify: canonical shared primitive recipes.
- `web/src/components/*.tsx` — modify: canonical application and status semantics.
- `web/src/routes/*.tsx` — modify: canonical route surfaces.
