# TanStack Patterns

Move WebSocket subscription ownership out of route component effects and into TanStack Router primitives. The subscription mode depends on resolved route state (wildcard for `/`, real session ID for the default stream, exact param for specific sessions), making it a router concern rather than a view concern.

## Server Functions for SSR-Safe Data Loading

When data needs to be available during SSR (server-side rendering) AND on the client, you MUST use TanStack Start server functions (`createServerFn`), NOT the browser `apiClient`.

### Why apiClient breaks SSR

The `apiClient` (in `web/src/lib/api.ts`) builds HTTP requests using the `settingsStore` (which reads from localStorage). During SSR:
- There's no `window`/`localStorage`
- The apiClient's base URL may not resolve from the SSR server context
- If the fetch fails, `.catch(() => ({}))` silently gives empty data
- Server renders with fallback values, client renders with real values → hydration mismatch

### The correct pattern: Server Functions

TanStack Start server functions (`createServerFn`) execute on the Node server during SSR AND transparently become RPC calls from the browser on the client. Same code path, same result, no hydration mismatch.

Pattern:
1. Create a server function in `web/src/server/` using `createServerFn`
2. Use `process.env` for base URL/token (available on the server, not in the browser)
3. Wire it into `queryOptions` as the `queryFn`
4. Call `ensureQueryData` in the route loader — this runs server-side during SSR
5. TanStack Query dehydrates the result → sends it in the HTML → client hydrates it
6. Client and server render with identical data — no mismatch

### Example: User Config

```ts
// web/src/server/user-config.ts — Server function
export const fetchUserConfig = createServerFn({ method: 'GET' }).handler(async () => {
  const url = `${process.env.VITE_AUTONOMA_BASE_URL}/api/user-config/default_user`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.VITE_AUTONOMA_TOKEN}` } });
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()).config;
});

// web/src/lib/queries.ts — Query options (no apiClient needed)
export function userConfigQueryOptions() {
  return {
    queryKey: ['user-config'] as const,
    queryFn: () => fetchUserConfig(),
    staleTime: 30_000,
  };
}

// web/src/routes/__root.tsx — Root loader seeds the cache
loader: async ({ context }) => {
  await context.queryClient.ensureQueryData(userConfigQueryOptions());
},

// Any component — reads from cache, zero fetch
const { data: config } = useQuery(userConfigQueryOptions());
```

### When to use which

| Pattern | Use when |
|---------|----------|
| Server function + `ensureQueryData` in loader | Data needed at first render (SSR). Panel layouts, theme, user prefs. |
| `apiClient` + `useQuery` in component | Client-only data not needed for SSR. Real-time status polling, WS-driven state. |
| `apiClient` + `useMutation` | Client-only writes. But prefer server function for mutations too if you want consistent error handling. |

### Gotcha: `.catch(() => ({}))` hides SSR failures

If the root loader does `ensureQueryData(...).catch(() => ({}))`, a server-side fetch failure silently returns empty data. The query cache gets seeded with `{}`, server renders with fallback defaults, and the client later fetches real data → hydration mismatch. Either let the error propagate (shows error boundary) or accept the fallback explicitly with `suppressHydrationWarning` on affected elements.
