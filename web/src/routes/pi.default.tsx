import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useSyncExternalStore } from "react";
import { ChatPanel } from "~/components/chat-panel";
import { piHistoryQueryOptions, statusPillsQueryOptions, statusQueryOptions } from "~/lib/queries";
import type { ChatTimelineItem, ConnectionState } from "~/lib/types";
import { sendMessage } from "~/lib/ws-query-bridge";
import { fetchPiHistory } from "~/server/pi";

export const Route = createFileRoute("/pi/default")({
  staticData: {
    wsMode: "pi-default",
  },
  loader: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(
      statusQueryOptions(context.apiClient),
    );
    const defaultSessionId = status.pi?.default?.sessionId;
    const items = await fetchPiHistory({ data: {} });
    const history = items as ChatTimelineItem[];

    // Seed the Query cache under the real sessionId when available.
    if (defaultSessionId) {
      context.queryClient.setQueryData(["pi-history", defaultSessionId, "agent"], history);
    }

    return { history, defaultSessionId };
  },
  errorComponent: ({ error }) => (
    <div className="flex items-center justify-center h-full p-8 text-destructive">
      <p>Failed to load history: {String(error)}</p>
    </div>
  ),
  component: PiDefaultRoute,
});

function PiDefaultRoute() {
  const { history, defaultSessionId } = Route.useLoaderData();
  const { wsClient } = Route.useRouteContext();

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
