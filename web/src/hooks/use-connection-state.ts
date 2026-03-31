import { useSyncExternalStore } from "react";
import type { ConnectionState } from "~/lib/types";
import type { AutonomaWsClient } from "~/lib/ws";

/**
 * SSR-safe subscription to WebSocket connection state via useSyncExternalStore.
 *
 * Connection state is synchronous, client-only, imperative state — not fetched
 * data. Using useSyncExternalStore (instead of the query cache) ensures React
 * subscribes directly to the WS client's state machine without participating in
 * SSR dehydration/hydration. getServerSnapshot returns "disconnected" to match
 * the server render, preventing hydration mismatch.
 *
 * See: features/tanstack-patterns/references/ssr.md
 * See: features/tanstack-patterns/references/external-data-loading.md
 * (Query cache is reserved for fetched data; local reactive state uses
 * useSyncExternalStore or similar primitives.)
 */
export function useConnectionState(wsClient: AutonomaWsClient): ConnectionState {
  return useSyncExternalStore(
    (onStoreChange) => wsClient.subscribeConnection(onStoreChange),
    () => wsClient.connectionState,
    // Server snapshot: always "disconnected" — there's no WS connection during SSR.
    // This matches what the server renders, preventing hydration mismatch.
    () => "disconnected" as ConnectionState,
  );
}
