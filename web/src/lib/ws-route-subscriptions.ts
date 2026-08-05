import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import type { FlitterbotWsClient } from "~/lib/ws";
import { latestHistoryPosition } from "./conversation-history.ts";
import { conversationState } from "./conversation-state.ts";
import type { StreamsHistoryResponse } from "./types.ts";

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
  queryClient: QueryClient,
  wsClient: FlitterbotWsClient,
): () => void {
  let activeTarget: SubscriptionTarget | null = null;

  const apply = () => {
    const nextTarget = resolveSubscriptionTarget(router);
    if (sameTarget(activeTarget, nextTarget)) return;

    if (activeTarget && activeTarget.piSessionId !== "*") {
      conversationState.clear(activeTarget.piSessionId);
    }
    activeTarget = nextTarget;

    if (nextTarget) {
      if (nextTarget.piSessionId !== "*") {
        const data = queryClient.getQueryData<{
          pages: StreamsHistoryResponse[];
        }>(["streams-history", nextTarget.piSessionId, "agent"]);
        const newestPage = data?.pages.at(-1);
        conversationState.installSnapshot(nextTarget.piSessionId, newestPage?.live);
        wsClient.setResumePosition(
          nextTarget.piSessionId,
          latestHistoryPosition(queryClient, nextTarget.piSessionId),
        );
      }
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
