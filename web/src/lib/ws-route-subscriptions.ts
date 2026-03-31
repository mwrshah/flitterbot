import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import type { StatusResponse } from "~/lib/types";
import type { AutonomaWsClient } from "~/lib/ws";

const INPUT_SURFACE_EVENT_TYPES = ["stream_surfaced"];

type WsMode = "surface" | "streams-default" | "pi-session";

type SubscriptionTarget = {
  piSessionId: string;
  eventTypes?: string[];
};

type MatchWithWsData = {
  staticData?: { wsMode?: WsMode };
  params?: { piSessionId?: string };
  loaderData?: { defaultPiSessionId?: string };
};

function defaultPiSessionIdFromCache(queryClient: QueryClient): string | undefined {
  return queryClient.getQueryData<StatusResponse>(["status"])?.piAgent?.default?.piSessionId;
}

function resolveSubscriptionTarget(
  router: AnyRouter,
  queryClient: QueryClient,
): SubscriptionTarget | null {
  const matches = router.state.matches as MatchWithWsData[];
  const activeMatch = [...matches].reverse().find((match) => match.staticData?.wsMode);
  if (!activeMatch) return null;

  switch (activeMatch.staticData?.wsMode) {
    case "surface":
      return { piSessionId: "*", eventTypes: INPUT_SURFACE_EVENT_TYPES };
    case "streams-default": {
      // Prefer the live cache value over stale loader data — the default Streams
      // session may have restarted with a new piSessionId since the loader ran.
      const piSessionId =
        defaultPiSessionIdFromCache(queryClient) ?? activeMatch.loaderData?.defaultPiSessionId;
      return piSessionId ? { piSessionId } : null;
    }
    case "pi-session":
      return activeMatch.params?.piSessionId ? { piSessionId: activeMatch.params.piSessionId } : null;
    default:
      return null;
  }
}

function sameTarget(a: SubscriptionTarget | null, b: SubscriptionTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.piSessionId !== b.piSessionId) return false;
  if (a.eventTypes === undefined || b.eventTypes === undefined)
    return a.eventTypes === b.eventTypes;
  if (a.eventTypes.length !== b.eventTypes.length) return false;
  const bEventTypes = b.eventTypes;
  return a.eventTypes.every((eventType, index) => eventType === bEventTypes[index]);
}

export function setupWsRouteSubscriptions(
  router: AnyRouter,
  wsClient: AutonomaWsClient,
  queryClient: QueryClient,
): () => void {
  let activeTarget: SubscriptionTarget | null = null;

  const apply = () => {
    const nextTarget = resolveSubscriptionTarget(router, queryClient);
    if (sameTarget(activeTarget, nextTarget)) return;

    activeTarget = nextTarget;

    if (nextTarget) {
      wsClient.setSessionSubscription(nextTarget.piSessionId, nextTarget.eventTypes);
    } else {
      wsClient.clearSessionSubscription();
    }
  };

  apply();
  const unsubscribeRouter = router.subscribe("onResolved", apply);
  const unsubscribeStatusCache = queryClient.getQueryCache().subscribe((event) => {
    const key = event.query?.queryKey;
    if (!key || key[0] !== "status") return;
    apply();
  });

  return () => {
    unsubscribeRouter();
    unsubscribeStatusCache();
    wsClient.clearSessionSubscription();
  };
}
