import type { AnyRouter } from "@tanstack/react-router";
import type { FlitterbotWsClient } from "~/lib/ws";

const INPUT_SURFACE_EVENT_TYPES = ["stream_surfaced"];

type WsMode = "surface" | "pi-session";

type SubscriptionTarget = {
  piSessionId: string;
  eventTypes?: string[];
};

type MatchWithWsData = {
  staticData?: { wsMode?: WsMode };
  params?: { piSessionId?: string };
};

function resolveSubscriptionTarget(router: AnyRouter): SubscriptionTarget | null {
  const matches = router.state.matches as MatchWithWsData[];
  const activeMatch = [...matches].reverse().find((match) => match.staticData?.wsMode);
  if (!activeMatch) return null;

  switch (activeMatch.staticData?.wsMode) {
    case "surface":
      return { piSessionId: "*", eventTypes: INPUT_SURFACE_EVENT_TYPES };
    case "pi-session":
      return activeMatch.params?.piSessionId
        ? { piSessionId: activeMatch.params.piSessionId }
        : null;
    default:
      return null;
  }
}

function sameTarget(a: SubscriptionTarget | null, b: SubscriptionTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.piSessionId !== b.piSessionId) return false;
  if (a.eventTypes === undefined || b.eventTypes === undefined)
    return a.eventTypes === b.eventTypes;
  const bEventTypes = b.eventTypes;
  return (
    a.eventTypes.length === bEventTypes.length &&
    a.eventTypes.every((eventType, index) => eventType === bEventTypes[index])
  );
}

export function setupWsRouteSubscriptions(
  router: AnyRouter,
  wsClient: FlitterbotWsClient,
): () => void {
  let activeTarget: SubscriptionTarget | null = null;

  const apply = () => {
    const nextTarget = resolveSubscriptionTarget(router);
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

  return () => {
    unsubscribeRouter();
    wsClient.clearSessionSubscription();
  };
}
