# Spec: Pi Agent Nested Routes

## Problem

Pi Agent tabs use `useState("default")` — not URL-addressable, lost on refresh. All data fetching (history, status) happens client-side via `useEffect`, causing a loading flash. Both `/api/pi/history` and `/status` are available on the same host; TanStack Start's route loaders should fetch this data server-side before render.

## Goal

Convert Pi Agent from local-state tabs to nested routes with server-side data loading. Each session (default + orchestrator workstreams) gets a distinct URL. History loads via route loaders — no flash, no hydration race.

## Functional Requirements

### FR-1: Server Functions for Pi Data

`createServerFn` wrappers in `web/src/server/pi.ts` for two backend endpoints:

```
GET /api/pi/history              → ChatTimelineItem[] for default session
GET /api/pi/history?piSessionId= → ChatTimelineItem[] for a specific session
GET /status                      → orchestrator list, busy state, queue depth
```

Backend URL: `process.env.VITE_AUTONOMA_BASE_URL` or `http://127.0.0.1:18820`. Bearer token: `process.env.VITE_AUTONOMA_TOKEN`. No localStorage dependency. Thin fetch wrappers — no business logic.

### FR-2: Layout Route with Server-Seeded Status

`/pi` is a layout route rendering a tab bar and `<Outlet />`.

**Loader:** Seeds the status query via `context.queryClient.ensureQueryData` — eliminates tab bar flicker. Component polls via `useQuery` with `refetchInterval: 5_000`.

**Tab bar:** `<Link>` components per session; active state from route match. Always shows at least "Default".

### FR-3: Child Routes with Server-Loaded History

- `/pi/default` — default Pi session
- `/pi/$sessionId` — orchestrator workstream session

Each child's `loader` calls the history server function. Component accesses data via `Route.useLoaderData()` — history present on first render.

### FR-4: Index Redirect

`/pi` redirects to `/pi/default` via `beforeLoad`. Layout never renders an empty outlet.

### FR-5: Active Tab from Route Match

Active styling from `<Link>` route matching. No `useState` for tab selection.

### FR-6: WebSocket Event Accumulation in Layout

The WS connection (in `useControlSurface`) survives route changes. The layout subscribes to all Pi session events, accumulating client-side state per session.

WS events are real-time streaming — loaders can't handle persistent subscriptions.

**State shape:** `sessionId → { appendedItems: ChatTimelineItem[], streamingText: string | null, statusPills: StatusPill[] }` — events arriving *after* loader history. Child routes merge:

```
displayed timeline = loaderHistory ++ appendedItems
```

Layout subscribes to all orchestrator sessions (`wsClient.subscribeSession`); default session events arrive without explicit subscribe. Provides accumulated state + `sendMessage` callback to children via React context.

### FR-7: ChatPanel Becomes Presentational

Props only:
- `timeline: ChatTimelineItem[]` — merged loader + WS-appended items
- `streamingText: string | null`
- `statusPills: StatusPill[]`
- `connectionState: ConnectionState`
- `onSendMessage: (text, deliveryMode, images?) => Promise<void>`

No internal `apiClient` or `wsClient` calls. Pure rendering component, reusable anywhere.

### FR-8: Browser Navigation

Back/forward navigates between Pi tabs — standard TanStack Router behavior.

## Route Files

```
web/src/
  server/
    pi.ts                         ← createServerFn: fetchPiHistory, fetchPiStatus
  routes/
    pi.route.tsx                  ← layout: loader seeds status, tab bar, Outlet, WS accumulation
    pi.index.tsx                  ← beforeLoad redirect to /pi/default
    pi.default.tsx                ← loader fetches default history, renders ChatPanel
    pi.$sessionId.tsx             ← loader fetches session history, renders ChatPanel
  components/chat/
    ChatPanel.tsx                 ← presentational: all data as props
```

## Data Flow

```
                     SSR / Navigation
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        pi.route.tsx   pi.default   pi.$sessionId
         loader:        loader:       loader:
         ensureQuery    fetchPi       fetchPi
         Data(status)   History()     History(id)
              │            │            │
              ▼            ▼            ▼
         ┌─────────────────────────────────┐
         │        Page Renders (SSR)       │
         │  Tab bar from status query      │
         │  ChatPanel from loader history  │
         └─────────────────────────────────┘
                           │
                    Client Hydrates
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         useQuery       usePi        usePi
         (status,       Session      Session
         polling)       Context      Context
              │            │            │
              │     ┌──────┴──────┐    │
              │     │  WS Events  │    │
              │     │  append to  │    │
              │     │  session    │    │
              │     │  state map  │    │
              │     └─────────────┘    │
              ▼            ▼            ▼
         Tab bar      ChatPanel     ChatPanel
         updates      renders:      renders:
         live         loader data   loader data
                      + appended    + appended
                      WS items      WS items
```

## Migration Notes

- First `createServerFn` in the web app — establishes the pattern for future server-loaded endpoints.
- `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` replaced by `<Link>` components in the tab bar.
- Delete `pi.tsx`; regenerate `routeTree.gen.ts`.
- `key` prop on ChatPanel no longer needed — route mounting handles identity.
- ChatPanel's `useEffect` history fetch, `wsClient.subscribe`, and `wsClient.subscribeSession` move to loaders (history) and layout (WS). ChatPanel becomes props-in, UI-out.

## Risks

1. **Server function failures** — Backend unreachable during SSR causes loader throw. Use `errorComponent` for retry UI; 3s timeout on server functions to prevent SSR hang.
2. **Event loss during transition** — Routes without lifted WS subscription drop in-flight streaming. WS lift and route conversion must ship together.
3. **Stale loader data** — Events between loader fetch and client hydration could be missed. Deduplicate by item ID when merging loader history with WS-appended items.
4. **Memory growth** — All session timelines accumulate in layout. Acceptable for now — sessions are short-lived, message counts small.
5. **Token mismatch** — Server functions use env var token, not localStorage overrides. Acceptable for localhost v1.
