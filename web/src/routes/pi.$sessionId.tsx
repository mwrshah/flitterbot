import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ChatPanel } from "~/components/chat-panel";
import { piHistoryQueryOptions, statusPillsQueryOptions } from "~/lib/queries";
import type { ChatTimelineItem, ConnectionState } from "~/lib/types";
import { sendMessage } from "~/lib/ws-query-bridge";
import { fetchPiHistory } from "~/server/pi";

export const Route = createFileRoute("/pi/$sessionId")({
  loader: async ({ params, context }) => {
    try {
      const items = await fetchPiHistory({ data: { piSessionId: params.sessionId } });
      const history = items as ChatTimelineItem[];
      // Seed the Query cache so useQuery returns instantly
      context.queryClient.setQueryData(["pi-history", params.sessionId, "agent"], history);
      return { history };
    } catch (error) {
      if (error instanceof Error && /404|not found/i.test(error.message)) {
        throw redirect({ to: "/pi/default" });
      }
      throw error;
    }
  },
  errorComponent: ({ error }) => (
    <div className="flex items-center justify-center h-full p-8 text-destructive">
      <p>Failed to load session history: {String(error)}</p>
    </div>
  ),
  component: PiSessionRoute,
});

function PiSessionRoute() {
  const { sessionId } = Route.useParams();
  const { history } = Route.useLoaderData();
  const { wsClient } = Route.useRouteContext();

  // Timeline from Query cache — seeded by loader, appended by WS bridge
  const { data: timeline = history } = useQuery(piHistoryQueryOptions(sessionId));

  // Status pills from Query cache — managed by WS bridge
  const { data: statusPills = [] } = useQuery(statusPillsQueryOptions(sessionId));

  // Connection state via useSyncExternalStore on wsClient
  const connectionState = useSyncExternalStore(
    useCallback((cb: () => void) => wsClient.subscribeConnection(cb), [wsClient]),
    useCallback(() => wsClient.connectionState, [wsClient]),
    () => "disconnected" as ConnectionState,
  );

  useEffect(() => wsClient.subscribeSession(sessionId), [sessionId, wsClient]);

  return (
    <ChatPanel
      sessionId={sessionId}
      timeline={timeline}
      statusPills={statusPills}
      connectionState={connectionState}
      onSendMessage={(text, deliveryMode, images) =>
        sendMessage(text, deliveryMode, images, sessionId)
      }
    />
  );
}
