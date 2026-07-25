# Theme Token Reference

## Problem

Flitterbot's Tailwind v4 theme is CSS-first: `web/src/styles.css` replaces a JavaScript `tailwind.config.*`. Its semantic tokens are available throughout the app, but no visual reference shows their live values, utility names, or current interaction recipes.

## Goals

- Show every general and sidebar semantic color from `styles.css` as a live swatch.
- Show the `bg-*`, `text-*`, `border-*`, `fill-*`, and `stroke-*` utilities each token enables.
- Demonstrate current base, subtle, hover, selected, primary, and focus recipes.
- Follow the active light, dark, or system theme without duplicating color values.
- Record semantic gaps without inventing replacement tokens.

## Architecture

The `/theme` route renders token metadata while every swatch reads its color directly through `var(--token)`. Tailwind utility examples resolve through the `@theme inline` aliases in `web/src/styles.css`; light and dark values remain owned by `:root` and `.dark` there.

## Pseudocode Contracts and Call Graph

```ts
type ThemeColor = {
  name: string
  role: string
}

ThemeReferencePage()
  → useTheme()                         // active mode and mode mutation
  → InteractionRecipe[]               // canonical class combinations in use
  → TokenSection[]
    → TokenCard(themeColor)
      → style.backgroundColor = var(--{name})
      → utility labels = bg/text/border/fill/stroke-{name}
```

## Component Tree

```text
<ThemeReferencePage>                  [route: /theme]
├── <Header>
│   └── theme mode buttons            [state owned by useTheme]
├── interaction recipe samples
├── <TokenSection title="Surface fills">
│   └── <TokenCard> × 8
├── <TokenSection title="Text colors">
│   └── <TokenCard> × 8
├── <TokenSection title="Borders and focus">
│   └── <TokenCard> × 3
├── <TokenSection title="Sidebar">
│   └── <TokenCard> × 8
└── schema-gap note
```

The page owns no copied color values, synchronized state, effects, data fetching, or expensive client-side derivation. `useTheme` owns global theme persistence and system-theme synchronization.

## Files

- `web/src/styles.css` — reference: master Tailwind v4 theme and light/dark token values.
- `web/src/routes/theme.tsx` — create: live token reference and interaction recipes.
- `web/src/routeTree.gen.ts` — generated: registers `/theme` in TanStack Router.
