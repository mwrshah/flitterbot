# Spec: Pi Agent Nested Routes

## Problem

The Pi Agent page manages tab switching via `useState("default")` in `pi.tsx`. Orchestrator workstream tabs are not URL-addressable — they can't be bookmarked, shared, or navigated with browser back/forward. Refreshing the page always resets to the default tab. This is a poor fit for a multi-session interface where users frequently switch between workstreams.

## Goal

Convert the Pi Agent page from local-state tabs to TanStack Router nested routes so each Pi session (default + orchestrator workstreams) is a distinct URL.

## Functional Requirements

### FR-1: Layout Route with Tab Bar

The `/pi` path becomes a layout route that renders a tab bar and an `<Outlet />`. The tab bar is the single place that reads orchestrator status and renders navigation links. Child routes render into the outlet without knowledge of the tab structure above them.

When no orchestrators exist (solo default Pi), the layout route should still render the tab bar — just with a single "Default" tab. This keeps the URL scheme consistent regardless of orchestrator state.

### FR-2: Each Tab is a Route

- `/pi/default` — the default Pi session
- `/pi/$sessionId` — an orchestrator workstream session

Each route renders a `ChatPanel` with the appropriate `piSessionId` prop. The default route passes no `piSessionId` (existing ChatPanel behavior). Session routes pass the `sessionId` from route params.

### FR-3: Index Redirect

Navigating to `/pi` (no child segment) redirects to `/pi/default` via `beforeLoad`. This ensures there's always an active child route — the layout never renders an empty outlet.

### FR-4: Active Tab from Route Match

Tab active state derives from the current route match, not local state. Each tab is a `<Link>` component whose active styling comes from TanStack Router's built-in active link detection. No `useState` for tab selection.

### FR-5: WebSocket Continuity Across Tab Switches

**This is the critical behavioral change.** Currently, all `TabsContent` panels stay mounted — switching tabs just hides/shows them. With nested routes, switching from `/pi/default` to `/pi/$sessionId` unmounts the default ChatPanel and mounts the session one.

ChatPanel manages three concerns that are affected by unmount:
1. **WebSocket event subscription** (`wsClient.subscribe`) — receives streaming text, tool events, message ends
2. **Session subscription** (`wsClient.subscribeSession`) — tells the server which session's events to forward
3. **History hydration** (`apiClient.getPiHistory`) — fetches message history on mount

The WebSocket connection itself lives in `useControlSurface` (shared context) and survives child unmounts. The issue is that events arriving while a ChatPanel is unmounted are lost — the user switches back and sees a gap.

**Approach:** Lift timeline state management to the layout route level. The layout maintains a map of `sessionId → ChatTimelineItem[]` and subscribes to all Pi session events. Child routes receive their timeline slice and a send function via route context or a provider. This preserves event continuity without keeping all ChatPanels mounted.

This is the only part of this spec that requires meaningful refactoring of ChatPanel. The current ChatPanel conflates "owns the WebSocket subscription" with "renders messages". These two concerns need to separate: the layout owns event subscription and timeline accumulation, while child routes own rendering and message composition.

### FR-6: Status Query in Route Loader

The layout route seeds the status query via `ensureQueryData` in its `loader`. The component continues using `useQuery` with `refetchInterval: 5_000` for polling. The loader just eliminates the initial loading flicker when navigating to `/pi`.

### FR-7: Browser Navigation

Back/forward buttons navigate between previously visited Pi tabs. Standard TanStack Router behavior — no additional work required beyond using route-based navigation instead of `setState`.

## Route Files

```
web/src/routes/
  pi.route.tsx                  ← layout: tab bar + Outlet + event subscription
  pi.index.tsx                  ← beforeLoad redirect to /pi/default
  pi.default.tsx                ← default Pi chat
  pi.$sessionId.tsx             ← orchestrator workstream chat
```

## Migration Notes

- The existing `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` UI components are no longer needed in the Pi page. The tab bar becomes a row of `<Link>` components with equivalent styling. The Tabs components remain available for other uses.
- `pi.tsx` is deleted after the layout route and children are in place. Run `tsr generate` to regenerate the route tree.
- ChatPanel's internal timeline state, WebSocket subscription, and history hydration logic move to a new provider or hook consumed at the layout level. ChatPanel itself becomes a presentational component that receives timeline data and a send callback.
- The `key` prop pattern currently used on ChatPanel (`<ChatPanel key={o.sessionId}>`) is no longer needed — route-based mounting handles instance identity.

## Risks

1. **Event loss during transition** — If the refactor is partially applied (routes exist but event subscription hasn't been lifted), switching tabs will drop in-flight streaming responses. The WebSocket lift and route conversion must ship together.
2. **Memory growth** — Keeping all session timelines in the layout means inactive sessions accumulate messages indefinitely. Acceptable for now (sessions are short-lived and message counts are small), but worth capping if usage patterns change.
3. **ChatPanel coupling** — ChatPanel is also used by InputSurface (indirectly, via shared patterns). Changes to ChatPanel's interface must not break InputSurface. InputSurface has its own timeline management and is unaffected by this refactor since it doesn't use ChatPanel.
