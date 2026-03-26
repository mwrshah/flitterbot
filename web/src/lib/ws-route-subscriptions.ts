import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import type { StatusResponse } from "~/lib/types";
import type { AutonomaWsClient } from "~/lib/ws";

const INPUT_SURFACE_EVENT_TYPES = ["pi_surfaced"];

type WsMode = "input-surface" | "pi-default" | "pi-session";

type SubscriptionTarget = {
  sessionId: string;
  eventTypes?: string[];
};

type MatchWithWsData = {
  staticData?: { wsMode?: WsMode };
  params?: { sessionId?: string };
  loaderData?: { defaultSessionId?: string };
};

function defaultPiSessionIdFromCache(queryClient: QueryClient): string | undefined {
  return queryClient.getQueryData<StatusResponse>(["status"])?.pi?.default?.sessionId;
}

function resolveSubscriptionTarget(router: AnyRouter, queryClient: QueryClient): SubscriptionTarget | null {
  const matches = router.state.matches as MatchWithWsData[];
  const activeMatch = [...matches].reverse().find((match) => match.staticData?.wsMode);
  if (!activeMatch) return null;

  switch (activeMatch.staticData?.wsMode) {
    case "input-surface":
      return { sessionId: "*", eventTypes: INPUT_SURFACE_EVENT_TYPES };
    case "pi-default": {
      const sessionId =
        activeMatch.loaderData?.defaultSessionId ?? defaultPiSessionIdFromCache(queryClient);
      return sessionId ? { sessionId } : null;
    }
    case "pi-session":
      return activeMatch.params?.sessionId ? { sessionId: activeMatch.params.sessionId } : null;
    default:
      return null;
  }
}

function sameTarget(a: SubscriptionTarget | null, b: SubscriptionTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.sessionId !== b.sessionId) return false;
  if (a.eventTypes === undefined || b.eventTypes === undefined) return a.eventTypes === b.eventTypes;
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
      wsClient.setSessionSubscription(nextTarget.sessionId, nextTarget.eventTypes);
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
