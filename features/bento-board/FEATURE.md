# Feature: Bento Board Layout

The Pi agent web UI displays workstreams and sessions as a flat list. At scale (27+ entries) this becomes unnavigable. A Bento-style variable-size grid replaces it — cards occupy different amounts of screen real estate based on their state, the layout is gap-minimised and fully responsive to window width, and transitions are smooth.

## Goals

- Display workstream/session cards in a responsive, tightly-packed grid with minimal gaps
- Eight discrete card sizes across three width tiers (1-col chip, 2-col card, 4-col panel) with heights from 1–16 rows
- Card positions are stable during interaction — no reordering except on window resize
- Smooth animated transitions when cards expand, collapse, or are swapped
- Cards expand in-place; neighbors compress to accommodate
- New cards enter via slot swap, not full repack

## Grid Unit System

The base unit is the **chip** — a rectangular cell, not a square. The chip's aspect ratio is roughly 3:1 (wider than tall). All larger card sizes are integer multiples of the chip in both dimensions.

```
Base unit (chip):  1 column × 1 row
Pixel reference:   160px × 56px  (at 1440px viewport)
```

"1×1" means 1 chip-column wide × 1 chip-row tall. "2×2" means 2 chip-columns wide × 2 chip-rows tall. Because columns and rows have different pixel sizes (160px vs 56px), a "2×2" card is not square — it's a wide rectangle (330×122px). This is intentional and matches the terminal-minimal aesthetic.

When two chips sit side by side, the gap between them is included in the next size up:
- 2 chip-widths + 1 gap = card width: `160 + 10 + 160 = 330px`
- 2 chip-heights + 1 gap = card height: `56 + 10 + 56 = 122px`
- 4 chip-widths + 3 gaps = panel width: `160×4 + 10×3 = 670px`

### Viewport Fitting

The chip's pixel dimensions are not hardcoded — they flex within a small range to ensure the grid fills the viewport edge-to-edge with no partial cuts.

**Width fitting:** Given the viewport width, determine how many chip-columns fit. Then adjust the chip width (within ±10% of 160px) and gap so that `(colCount × chipWidth) + ((colCount - 1) × gap) = viewportWidth - padding`. The column count itself is fixed for a given viewport width bracket.

**Height fitting:** Same principle vertically. Adjust chip height (within ±10% of 56px) so that a target row count fills the visible viewport cleanly. The bento board scrolls vertically (the grid can exceed one screenful), but the visible portion should never show a cut through the middle of a row.

The algorithm: measure viewport → pick column count → solve for chipWidth and chipHeight that produce clean edges → derive all card sizes from those base values.

### Confirmed Card Sizes

Three width tiers (1-col, 2-col, 4-col) with varying heights:

| Name | Grid | Reference Pixels | Scrollable | Description |
|---|---|---|---|---|
| **Chip** | 1×1 | 160×56 | No | Minimal — agent name + token count + elapsed time |
| **Card** | 2×2 | 330×122 | No | Status, last activity, question prompt, input bar |
| **Tall Card** | 2×3 | 330×188 | No | Card with more vertical room — useful for grid filling |
| **Tall Panel** | 3×4 | 500×254 | Yes | Mid-width panel with scrollable conversation |
| **Full Panel** | 4×5 | 670×320 | Yes | Standard wide panel with conversation + input |
| **Mega Panel** | 4×10 | 670×650 | Yes | Extended conversation view |
| **Deep Panel** | 4×8 | 670×518 | Yes | Deep conversation view, fits within viewport |
| **Max Panel** | 4×11 | 670×716 | Yes | Maximum size — long conversation history |

**Design cards** (created in Paper): Chip 1×1, Card 2×2, Tall Card 2×3, Tall Panel 3×4, Full Panel 4×5, Deep Panel 4×8, Max Panel 4×11.

**Valid but no dedicated design**: Mega Panel 4×10 (670×650) — interpolates naturally from the designed variants.

### Size Rules

- **Width tiers**: 1-col (chip), 2-col (card), 3-col (tall panel), 4-col (panel).
- **Chips never grow tall**: 1×1 only. No 1×2 or 1×3.
- **Cards start at 2×2**: No 2×1 wide chip. Minimum card height is 2 rows.
- **Panels start at 4×5**: Minimum panel height is 5 rows. Tall panels use 3-col width at 4 rows.
- **Scrollable threshold**: Cards at 2×4 or larger, and all 4×* panels scroll their conversation area internally. The card frame stays fixed; content scrolls inside.
- **Inactive agents**: Always collapsed to 1×1 chip, rendered at reduced opacity with transparent background.

## Layout Algorithm

Two distinct modes with different algorithms.

### Mode 1 — Full Repack (mount + window resize)

Triggered on initial mount and on window resize (debounced ~150ms). Cards may change position. Steps:

1. Derive `cellSizePx` and `colCount` from container width (base unit is fixed px, always an integer divisor of available width)
2. For each card, determine its current size state → compute `colSpan × rowSpan`
3. Sort cards largest-first
4. Run **MAXRECTS** bin-packing to assign `{col, row, colSpan, rowSpan}` to each card
5. Emit the resulting slot graph as the new canonical layout; card positions from prior layout are discarded

MAXRECTS is the right algorithm here because: the surface area is unknown until runtime, templates are therefore impossible, and MAXRECTS minimises gaps by construction. The `maxrects-packer` npm package is a candidate implementation; evaluate before writing from scratch.

### Mode 2 — Slot Graph (interaction, no resize)

After Mode 1 runs, the layout is frozen as a **slot graph**: a map of card IDs to fixed grid positions. Interactions operate on the slot graph without triggering a repack.

```
SlotGraph = Map<cardId, BentoSlot>

BentoSlot {
  id: string
  col: number          // 1-indexed
  row: number
  colSpan: number
  rowSpan: number
  sizeUnits: number    // 1 | 4 | 10..16
  neighborIds: string[]
}
```

Neighbor relationships are computed once after each repack by checking grid adjacency.

#### Expand / Collapse (local resize)

When card A expands (e.g. 1 → 16 units, delta = +15):

1. Walk A's neighbor graph outward, accumulating neighbors sorted by size descending
2. Greedily collapse neighbors until freed units ≥ delta
3. Update `sizeUnits`, `colSpan`, `rowSpan` for A and each affected neighbor
4. No card changes its `col`/`row` anchor — only spans change
5. Wrap DOM update in `startViewTransition`

Cascade example: expanding 1→16 needs 15 units. Nearest neighbor is size 14 → collapse to 1 → frees 13. Still need 2. Next neighbor is size 4 → collapse to 1 (partial collapse acceptable if min size is respected) → frees 3. Done.

#### New Card Introduction (swap, not repack)

Inserting a new card at target size S:

- **S = 1**: find any size-1 slot, swap content in place
- **S = 4**: find an existing size-4 slot → swap content; if none, collapse a large card by 4 units to create a 4-slot adjacent vacancy
- **S = large**: find an existing large slot → swap content; if none, collapse an existing large card to 1, freeing its slot for the new card

The incoming card replaces the evicted card's slot. The evicted card collapses to size 1 and takes the smallest available slot (or the slot just vacated if a cascaded collapse created one nearby).

#### Large Batch Addition / Forced Repack

If N new cards arrive simultaneously and slot swaps cannot accommodate them without cascading beyond a threshold (TBD, e.g. >3 forced collapses), trigger a full Mode 1 repack. Cards may move.

## CSS Implementation

### Grid Container

```css
.bento-grid {
  display: grid;
  grid-template-columns: repeat(var(--col-count), var(--cell-size));
  grid-auto-rows: var(--cell-size);
  gap: var(--bento-gap);
  align-content: start;
}
```

`--col-count` and `--cell-size` set as CSS custom properties on the container element from JS after width measurement. Gap is a design token.

### Card Placement

Algorithm output applied as inline styles — not Tailwind classes, because values are dynamic integers:

```tsx
<div
  style={{
    gridColumn: `${slot.col} / span ${slot.colSpan}`,
    gridRow: `${slot.row} / span ${slot.rowSpan}`,
    viewTransitionName: `bento-card-${card.id}`,
  }}
/>
```

Tailwind handles all appearance properties (background, radius, border, padding, text).

### View Transitions API (Smooth Reflow)

All layout mutations — expand, collapse, swap, full repack — wrapped in `startViewTransition`:

```ts
document.startViewTransition(() => {
  flushSync(() => dispatch({ type: 'APPLY_LAYOUT', layout: newLayout }));
});
```

Each card's unique `viewTransitionName` gives the browser identity across states. Cards that move get positional animations automatically (FLIP-equivalent). Cards that resize animate their bounding box. Near-zero JS animation code required.

Custom timing in a dedicated CSS file (not Tailwind — pseudo-elements are not addressable via utility classes):

```css
/* bento-transitions.css */
::view-transition-old(root),
::view-transition-new(root) {
  animation-duration: 250ms;
  animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
}
```

Fallback: if `startViewTransition` is unavailable (Firefox until support lands), apply layout change directly — no animation, layout still correct.

### Container Queries (Card Content Adaptation)

Each card wraps its content in a container query context. The card component renders different content density based on its own size, not the viewport:

```css
.bento-card { container-type: inline-size; }

@container (min-width: 200px) { /* medium: show status, subtitle */ }
@container (min-width: 400px) { /* large: show diff, messages, actions */ }
```

This decouples card content from the layout system — the card doesn't need to receive its size state as a prop to decide what to render.

### Tailwind Integration

| Concern | Approach |
|---|---|
| Grid container setup | Tailwind (`grid`, `gap-N`) |
| Dynamic column/row spans | Inline styles only |
| `view-transition-name` | Inline styles only (must be unique per element) |
| `::view-transition-*` tuning | `bento-transitions.css` (small global file) |
| Card appearance | Tailwind as normal |
| Container query breakpoints | `bento-transitions.css` or component CSS module |

No `twMerge` needed — `twMerge` resolves Tailwind class conflicts; this pattern has no conflicts to resolve.

## State Management

Layout state lives in a dedicated store (pattern: `useSyncExternalStore`, consistent with existing `PiSessionStore`/`SettingsStore`):

```ts
BentoStore {
  layout: BentoLayout | null      // null until first repack
  pendingTransition: boolean      // true while startViewTransition is running
  
  // actions
  repack(containerWidth: number, cards: CardDescriptor[]): void
  expand(cardId: string): void
  collapse(cardId: string): void
  swapIn(newCard: CardDescriptor, targetSlotId: string): void
}

BentoLayout {
  slots: Record<string, BentoSlot>
  colCount: number
  cellSizePx: number
  gapPx: number
}
```

`BentoGrid` mounts a `ResizeObserver` on the container element. On size change (debounced), calls `BentoStore.repack()`.

## Key Files

All files in ``:

| File | Purpose |
|---|---|
| `web/src/lib/bento/maxrects.ts` | MAXRECTS bin-packing implementation (or thin wrapper around `maxrects-packer`) |
| `web/src/lib/bento/slot-graph.ts` | SlotGraph data structure — neighbor computation, adjacency queries |
| `web/src/lib/bento/layout-engine.ts` | Layout orchestration: initial pack, expand, collapse, swap, large-batch logic |
| `web/src/lib/bento/bento-store.ts` | `useSyncExternalStore`-backed store for layout state |
| `web/src/components/BentoGrid.tsx` | Grid container, ResizeObserver, repack trigger |
| `web/src/components/BentoCard.tsx` | Individual card — container query context, size-state-aware content slots |
| `web/src/styles/bento-transitions.css` | `::view-transition-*` tuning + container query breakpoints |

## Open Questions

1. **Large card aspect ratio** — is the large state always a fixed shape (e.g. 2×wide columns), or can it be square (4×4)? This affects packing efficiency and needs to be pinned before implementing MAXRECTS.
2. **Base cell size in px** — what is the pixel size of one grid unit? Determines how many columns fit at common window widths.
3. **Size state persistence** — should a card's size state (collapsed/medium/large) survive page reload (localStorage) or reset to default each session?
4. **Default size assignment** — which cards start large, which medium, which collapsed? By recency? By activity? User-controlled?
5. **Max large size** — is 16 a hard cap or can a card ever go larger on very wide screens?
6. **Repack threshold** — how many forced collapses during a swap-in before triggering a full repack? Needs a defined policy.

## Dependencies

- `maxrects-packer` (npm) — evaluate fit before writing from scratch
- View Transitions API — Chrome 111+, Edge 111+; Safari/Firefox support pending (graceful degradation: no animation)
- CSS Container Queries — all modern browsers, well-supported
- `ResizeObserver` — all modern browsers
