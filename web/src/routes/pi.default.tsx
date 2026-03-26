import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useSyncExternalStore } from "react";
import { ChatPanel } from "~/components/chat-panel";
import { piHistoryQueryOptions, statusPillsQueryOptions, statusQueryOptions } from "~/lib/queries";
import type { ChatTimelineItem, ConnectionState, StatusResponse } from "~/lib/types";
import { sendMessage } from "~/lib/ws-query-bridge";
import { fetchPiHistory } from "~/server/pi";

export const Route = createFileRoute("/pi/default")({
  loader: async ({ context }) => {
    const items = await fetchPiHistory({ data: {} });
    const history = items as ChatTimelineItem[];

    // Seed the Query cache under the real sessionId if status is already cached
    // (parent pi.route loader ensures status is loaded before this runs)
    const status = context.queryClient.getQueryData<StatusResponse>(["status"]);
    const defaultSessionId = status?.pi?.default?.sessionId;
    if (defaultSessionId) {
      context.queryClient.setQueryData(["pi-history", defaultSessionId, "agent"], history);
    }

    return { history };
  },
  errorComponent: ({ error }) => (
    <div className="flex items-center justify-center h-full p-8 text-destructive">
      <p>Failed to load history: {String(error)}</p>
    </div>
  ),
  component: PiDefaultRoute,
});

function PiDefaultRoute() {
  const { history } = Route.useLoaderData();
  const { apiClient, wsClient } = Route.useRouteContext();

  // Read the default agent's piSessionId from the status query (already loaded by parent route)
  const statusQuery = useQuery(statusQueryOptions(apiClient));
  const defaultSessionId = statusQuery.data?.pi?.default?.sessionId;

  // Timeline from Query cache — seeded by loader, appended by WS bridge.
  // Falls back to loader history when defaultSessionId is not yet resolved
  // (piHistoryQueryOptions has enabled: false when sessionId is undefined).
  const { data: timeline = history } = useQuery({
    ...piHistoryQueryOptions(defaultSessionId),
  });

  // Status pills from Query cache — managed by WS bridge
  const { data: statusPills = [] } = useQuery(
    statusPillsQueryOptions(defaultSessionId ?? "default"),
  );

  // Connection state via useSyncExternalStore on wsClient
  const connectionState = useSyncExternalStore(
    useCallback((cb: () => void) => wsClient.subscribeConnection(cb), [wsClient]),
    useCallback(() => wsClient.connectionState, [wsClient]),
    () => "disconnected" as ConnectionState,
  );

  return (
    <ChatPanel
      sessionId={defaultSessionId ?? "default"}
      timeline={timeline}
      statusPills={statusPills}
      connectionState={connectionState}
      onSendMessage={(text, deliveryMode, images) =>
        sendMessage(text, deliveryMode, images, defaultSessionId)
      }
    />
  );
}
