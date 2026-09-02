# Pinned Closed Swimlanes

## Problem

Closed pinned swimlanes need a stable sidebar location separate from recently closed, unpinned swimlanes.

## Goals

- Show open swimlanes first, recently closed unpinned swimlanes second, and pinned closed swimlanes third.
- Give “Recently closed” and “Pinned closed” independent collapse state.
- Preserve the existing closed-row actions, search behavior, keyboard selection, spacing, and styling.

## Architecture

`SidebarSwimlanes` derives all sidebar rows from the status query. It groups closed rows by their current `stream.pinned` value before it builds the ordered row list. Search projects that ordered list, then partitions visible closed results into the two sections. Pin mutations invalidate the status query, so a closed row moves between sections when fresh status data arrives.

## Pseudocode Contracts and Call Graph

```ts
type ClosedSectionRows = {
  recentlyClosed: SidebarSwimlaneRow[]; // closed and unpinned
  pinnedClosed: SidebarSwimlaneRow[]; // closed and pinned
};

statusQuery.streams
  -> group open, recently closed, and pinned closed rows
  -> project rows through sidebar search
  -> render open rows
  -> render collapsible “Recently closed”
  -> render collapsible “Pinned closed”

pin or unpin row
  -> setStreamPinned
  -> invalidate status query
  -> regroup row under its current pin state
```

## Component Tree

```text
<Sidebar>
└── <SidebarSwimlanes>               status, search, mutations, row grouping
    └── <SwimlaneRows>               renders sections in sidebar order
        ├── open <SwimlaneRow> list
        ├── <CollapsibleSwimlaneSection title="Recently closed">
        │   └── unpinned closed <SwimlaneRow> list
        └── <CollapsibleSwimlaneSection title="Pinned closed">
            └── pinned closed <SwimlaneRow> list
```

Each `CollapsibleSwimlaneSection` owns only its expanded or collapsed state. Row actions remain in `SwimlaneRow`.

## Files

- `web/src/components/sidebar.tsx` — modify: group closed swimlanes by pin state and render the third collapsible section.
- `docs/sidebar-pinned-closed/FEATURE.md` — create: define sidebar grouping, order, and interaction behavior.
