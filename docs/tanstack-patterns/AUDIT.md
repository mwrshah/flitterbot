# Surface Page Audit: Hydration Mismatches & Data-Loading Patterns

## Current Implementation Summary

The app uses **TanStack Start** (via `@tanstack/react-start/plugin/vite`) with **TanStack Router** + **TanStack Query** for SSR. The router is created in `web/src/router.tsx:14` via `getRouter()`, which:

1. Creates a `QueryClient` and wires it into router context
2. Calls `setupRouterSsrQueryIntegration()` for automatic dehydration/hydration of query cache between server and client
3. On the client (`typeof window !== "undefined"`), immediately calls `wsClient.connect()` and `setupWsQueryBridge()` during router construction

The Surface page (`/`) uses a loader that calls `ensureQueryData(surfaceTimelineQueryOptions())`, and the component reads data via `useQuery(surfaceTimelineQueryOptions())`. The root route similarly loads status data via `ensureQueryData`.

The `RuntimeHealthIndicator` component reads WS connection state from the query cache via `useQuery(connectionStateQueryOptions())` and has a manual `mounted` state workaround for hydration mismatch.

---

## Issues Found

### Issue 1: Hydration Mismatch in RuntimeHealthIndicator (WS state seeded before hydrate)

**File:** `web/src/lib/ws-query-bridge.ts:601`, `web/src/router.tsx:42-44`, `web/src/components/runtime-health-indicator.tsx:39-48`

**Problem:** In `router.tsx:42-44`, the WS client connects and `setupWsQueryBridge()` runs during `getRouter()` — which is called during both server and client initialization. On the client, this happens *before* `React.hydrateRoot()` runs. The bridge immediately seeds the query cache at line 601:

```ts
queryClient.setQueryData<ConnectionState>(["connection-state"], wsClient.connectionState);
```

By the time React hydrates, the query cache already contains `"connecting"` or `"connected"`, but the server rendered with the `queryFn` default of `"disconnected"`. This creates a hydration mismatch.

**Current workaround:** `runtime-health-indicator.tsx:46-48` uses a `useState(false)` + `useEffect` to defer reading the live value until after mount. This is a brittle band-aid that:
- Adds complexity to every component that reads WS-managed cache entries
- Causes a visible flash (disconnected -> connected) on first render
- Would need to be replicated for any new component reading `connectionStateQueryOptions`

**What the docs say:** The `query.md` reference (lines 69-71) is clear: `useQuery` does not execute on the server. The `queryFn` returning `"disconnected"` is the server-rendered value. The integration (`setupRouterSsrQueryIntegration`) dehydrates/hydrates the query cache automatically. But the WS bridge writes to the cache *before* hydration runs, overwriting the dehydrated value.

**Fix recommendation:**
1. Move `wsClient.connect()` and `setupWsQueryBridge()` out of `getRouter()` and into a client-only lifecycle that runs *after* hydration completes. Options:
   - Use a `useEffect` in the root route component (runs after hydrate)
   - Use `router.subscribe("onResolved", ...)` with a one-shot handler that fires after the first client-side resolution
2. Remove the `setQueryData` seed on line 601. Instead, let the connection state subscriber (`ws-query-bridge.ts:605-618`) write to the cache only after hydration. The `queryFn` default of `"disconnected"` is correct for the initial SSR+hydration render.
3. Remove the `mounted` workaround from `RuntimeHealthIndicator`.

### Issue 2: Missing `defaultPreloadStaleTime: 0` for external data loading

**File:** `web/src/router.tsx:26-33`

**Problem:** The router is configured with `defaultPreload: "intent"` but does not set `defaultPreloadStaleTime: 0`. Per the TanStack docs (`preloading.md:137` and `data-loading.md:313-319`), when using an external cache like TanStack Query, you must set `defaultPreloadStaleTime: 0` to ensure that every preload/load/reload event triggers the loader functions, allowing TanStack Query to manage its own staleness via its `staleTime`.

Without this, the router's built-in 30-second preload cache suppresses loader calls for 30 seconds after a preload. If data changes during that window (e.g., via WS bridge `setQueryData`), the next navigation to a preloaded route may not call `ensureQueryData`, causing stale data to persist until the query's own refetch logic kicks in.

**What the docs say:** From `preloading.md:136-137`: *"To customize the preloading behavior in TanStack Router and fully leverage your external library's caching strategy, you can bypass the built-in caching by setting `defaultPreloadStaleTime` to 0."* From `data-loading.md:313-319`: *"As long as you are using the defaults, the only change you'll need to make is to set the `defaultPreloadStaleTime` option on the router to `0`."*

**Fix recommendation:** Add `defaultPreloadStaleTime: 0` to the `createRouter()` call in `router.tsx`.

### Issue 3: `useQuery` instead of `useSuspenseQuery` for SSR-critical data

**File:** `web/src/components/surface.tsx:357`, `web/src/components/runtime-health-indicator.tsx:34-36`

**Problem:** The Surface component reads timeline data with `useQuery(surfaceTimelineQueryOptions())` at line 357, and RuntimeHealthIndicator reads status with `useQuery({...statusQueryOptions(apiClient)})` at line 34. Both queries are seeded by their route loaders via `ensureQueryData`, so the data is available at render time. However, the `query.md` reference (lines 75-78) is explicit:

> - `useSuspenseQuery`: runs on the server during SSR when its data is required and will be streamed to the client as it resolves.
> - `useQuery`: does not execute on the server; it will fetch on the client after hydration.

Using `useQuery` means these queries don't participate in the SSR streaming/dehydration pipeline. The data is only available because the loader happened to `ensureQueryData` first, but:
- If `ensureQueryData` is removed or fails (as in the try/catch at `index.tsx:14-18`), `useQuery` will show a loading flash on the client
- The `data: timeline = []` fallback at `surface.tsx:357` means the SSR render can show "No activity yet" followed by a flash of data after hydration

**Fix recommendation:** Use `useSuspenseQuery` for data that is critical to the initial render and was seeded by the loader. This ensures proper SSR streaming behavior and eliminates the need for fallback defaults:

```tsx
// surface.tsx
const { data: timeline } = useSuspenseQuery(surfaceTimelineQueryOptions());

// runtime-health-indicator.tsx
const { data: status } = useSuspenseQuery(statusQueryOptions(apiClient));
```

For `connectionStateQueryOptions`, `useQuery` is correct since this is client-only state that has no server-side value.

### Issue 4: `connectionStateQueryOptions` abuses query cache for synchronous client-only state

**File:** `web/src/lib/queries.ts:119-126`, `web/src/lib/ws-query-bridge.ts:601-618`

**Problem:** The connection state is purely client-side, synchronous, imperative state — it's never fetched from a server. Using TanStack Query for it creates several problems:
- The `queryFn: () => "disconnected"` is a lie — it's only there to provide a default, never actually called as a "fetch"
- `staleTime: Infinity` prevents refetching, which confirms this isn't real query data
- The WS bridge writes to it via `setQueryData`, bypassing the query lifecycle entirely
- This is the root cause of the hydration mismatch (Issue 1): query cache state set before hydrate

**What the docs say:** The `external-data-loading.md` guide describes query cache integration for *fetched data*. Connection state is not fetched data — it's local reactive state derived from the WS client.

**Fix recommendation:** Replace with a proper reactive primitive that doesn't participate in SSR dehydration:
- Use `useSyncExternalStore` to subscribe to `wsClient.subscribeConnection()` directly
- Or use a tiny Zustand store / signal for connection state
- This eliminates the hydration mismatch entirely since the value is never serialized to the server

### Issue 5: Phased data loading — loader `ensureQueryData` with `staleTime: 0` causes re-fetch flash

**File:** `web/src/lib/queries.ts:129-137`, `web/src/routes/index.tsx:13-18`

**Problem:** `surfaceTimelineQueryOptions` has `staleTime: 0`, and the route loader calls `ensureQueryData()`. The behavior of `ensureQueryData` with `staleTime: 0`:
- On first load: fetches and caches — works correctly
- On subsequent navigations: if cached data exists, `ensureQueryData` returns it immediately (it only fetches if there's *no* data), but `useQuery` in the component will immediately trigger a background refetch because `staleTime: 0` marks it stale instantly

This creates a visual "phase" effect:
1. **Phase 1:** Loader runs `ensureQueryData` — if data exists, returns immediately; if not, fetches
2. **Phase 2:** Component renders with cached data (possibly stale)
3. **Phase 3:** `useQuery` triggers background refetch because `staleTime: 0`
4. **Phase 4:** WS bridge `setQueryData` updates arrive, causing additional re-renders

The `staleTime: 0` comment says: *"WS setQueryData resets dataUpdatedAt while viewing; on route leave WS unsubscribes so data goes stale naturally."* This is a valid reason for `staleTime: 0` — the data is kept fresh by WS while viewing, and should refetch on re-entry. However, the refetch-on-entry creates the visible "loading in phases" effect.

**Fix recommendation:** The `staleTime: 0` is intentional for reconnection scenarios, but the phased loading can be mitigated:
1. Use `useSuspenseQuery` instead of `useQuery` — this suspends until data is available, preventing the empty-to-populated flash
2. The try/catch in the loader (`index.tsx:14-18`) silently swallows errors, which means on server failure the component renders empty. Consider removing the try/catch and letting the route's error component handle it, or at minimum log the error.

### Issue 6: Skills query not seeded by loader — causes waterfall

**File:** `web/src/components/surface.tsx:349-354`

**Problem:** The skills query is fetched inline in the component with `useQuery`:

```tsx
const { data: skillsData } = useQuery({
  queryKey: ["skills"],
  queryFn: () => apiClient.listSkills(),
  staleTime: 5 * 60 * 1000,
  refetchOnWindowFocus: false,
});
```

This is not seeded by any loader, creating a waterfall: the route loads timeline data, renders the component, *then* kicks off the skills fetch. The skills data is used for the `MessageInput` autocomplete, so it's non-critical UI data — but it could be preloaded in the route loader with `prefetchQuery` to start earlier.

**What the docs say:** From `external-data-loading.md:39-43`: *"It's very important to preload your critical render data in the loader... No waterfall data fetching, caused by component based fetching."*

**Fix recommendation:** Since skills data is non-critical, use `prefetchQuery` (not `ensureQueryData`) in the route loader to kick off the fetch without blocking navigation:

```tsx
loader: async ({ context }) => {
  context.queryClient.prefetchQuery({ queryKey: ["skills"], queryFn: ... });
  await context.queryClient.ensureQueryData(surfaceTimelineQueryOptions());
},
```

### Issue 7: `statusQueryOptions` duplicated across root and streams layout loaders

**File:** `web/src/routes/__root.tsx:27-29`, `web/src/routes/streams.route.tsx:9-11`

**Problem:** Both the root route and the streams layout route call `ensureQueryData(statusQueryOptions(apiClient))` in their loaders. Per the data-loading lifecycle (`data-loading.md:14-29`), route loaders run in parallel after `beforeLoad`. The root loader and child loaders run in parallel, so both will call `ensureQueryData` simultaneously. TanStack Query dedupes concurrent fetches for the same key, so this doesn't cause double-fetching. However, it's redundant code — the child route loader's `ensureQueryData` is a no-op since the root already ensures it.

**Fix recommendation:** This is minor — the deduping makes it harmless. But for clarity, the streams route could rely on the root's loader having already seeded status. Remove the duplicate `ensureQueryData` from `streams.route.tsx` if the root is guaranteed to run first (which it is — root `beforeLoad` runs before child loaders).

---

## Summary

| # | Issue | Severity | File(s) |
|---|-------|----------|---------|
| 1 | WS bridge seeds query cache before hydrate | **High** | `router.tsx`, `ws-query-bridge.ts`, `runtime-health-indicator.tsx` |
| 2 | Missing `defaultPreloadStaleTime: 0` | **Medium** | `router.tsx` |
| 3 | `useQuery` instead of `useSuspenseQuery` for SSR data | **Medium** | `surface.tsx`, `runtime-health-indicator.tsx` |
| 4 | Connection state abuses query cache | **Medium** | `queries.ts`, `ws-query-bridge.ts` |
| 5 | `staleTime: 0` + `ensureQueryData` causes phased loading | **Medium** | `queries.ts`, `index.tsx` |
| 6 | Skills query not seeded by loader (waterfall) | **Low** | `surface.tsx` |
| 7 | Redundant `ensureQueryData` in child route | **Low** | `streams.route.tsx` |

Issues 1 and 4 are the same root cause (WS connection state in query cache) and should be fixed together. Issue 3 directly contributes to the phased-loading symptom. Issue 2 is a configuration gap that could cause subtle staleness bugs with preloading.
