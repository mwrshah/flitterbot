# Application tooltips

## Contract

Native hover hints use the shared Base UI tooltip component. Heading, metadata, and domain `title` properties keep their existing meaning. Tooltips supplement accessible names; icon controls retain `aria-label`, and essential information is not touch-hover-only.

```tsx
<Tooltip content="Copy message">
  <button type="button" aria-label="Copy message">...</button>
</Tooltip>
```

`Tooltip` accepts `content: ReactNode`, one `children: ReactElement`, and an optional Base UI positioning `side` (default `top`). Rendered custom triggers forward DOM props and refs. Empty content disables the tooltip without replacing its trigger subtree. A stable popup ID links the trigger's `aria-describedby` to `role="tooltip"`; existing description IDs remain intact. With nested Base UI render composition, existing `aria-describedby` belongs on Tooltip's immediate child (for example, `Popover.Trigger`), not its inner `render` element: inner attributes can override the combined IDs.

## Component tree

```text
RootDocument
└── Tooltip.Provider (300ms open delay, 0ms close delay, 400ms instant-peer window)
    ├── Application and root error content
    ├── Toaster
    └── Tooltip
        └── Base UI Root (owns open state)
            ├── Trigger render={children} (existing element; no layout wrapper)
            └── Portal (mounted only while open)
                └── Positioner (collision handling; 6px offset)
                    └── Popup (shared Tailwind theme styles)
```

## Behavior and performance

One provider coordinates delays across routes and portaled controls. Keyboard focus, Escape dismissal, hover transfer, pointer-rest timing, and positioning use Base UI. Popups portal outside panel clipping and use the application's existing portal stacking styles. Popup text wraps within the available width and scrolls within the available height. Closed popup content stays unmounted.

Compact multi-key `ShortcutHint` labels use a separate, bounded 200ms mouse-rest timer before revealing hidden modifier keys. Meaningful pointer movement restarts that timer; pointer exit cancels it and collapses the hint. Touch pointers do not start it. Only expandable hints mount this interaction state.

Disabled controls with hints use Base UI Button's `focusableWhenDisabled`: they remain focusable without executing disabled actions. Existing menu, popover, and toggle triggers keep their composition and event handling. Noninteractive hint targets use explicit keyboard focus where needed. Marker buttons retain their 420px hover hitboxes and 18×9px activation targets; tooltip composition adds no sibling layout elements.

## Files

- `web/src/components/common/tooltip.tsx` — shared trigger composition and popup styling.
- `web/src/routes/__root.tsx` — application-wide provider, including root error content.
- `web/src/components/{auth-providers-section,model-selector,downstream-sessions-panel,sidebar,surface}.tsx` — settings, model, status, and navigation hints.
- `web/src/components/{chat-panel,chat-tool-message,chat-message-row,message-actions-menu,streams-message-list}.tsx` — conversation and marker hints.
- `web/src/components/common/{message-input,code-block,copyable-code}.tsx` — input and copy hints.
- `web/src/components/common/kbd.tsx` — compact shortcut mouse-rest expansion.
- `web/src/styles.css` — existing portal layering and theme tokens; unchanged.
- `web/tests/tooltip.test.ts` — native-title migration guard.

## Verification

`pnpm run audit:ts` checks formatting, tests, TypeScript, and unused files/dependencies. The migration guard scans JSX. Separate server-rendered fixtures verify trigger composition and closed-popup DOM; neither establishes browser timing or full-app performance.
