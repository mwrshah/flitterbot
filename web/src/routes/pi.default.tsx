import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat/ChatPanel";
import { piSessionStore, usePiSessionStore } from "~/lib/pi-session-store";
import { statusQueryOptions } from "~/lib/queries";
import type { ChatTimelineItem } from "~/lib/types";
import { fetchPiHistory } from "~/server/pi";
import { mergeTimelines } from "./pi.route";

export const Route = createFileRoute("/pi/default")({
  loader: async () => {
    const items = await fetchPiHistory({ data: {} });
    return { history: items as ChatTimelineItem[] };
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
  const { apiClient } = Route.useRouteContext();
  const snapshot = usePiSessionStore();
  const sendMessage = piSessionStore.getSendMessage();

  // Read the default agent's piSessionId from the status query (already loaded by parent route)
  const statusQuery = useQuery(statusQueryOptions(apiClient));
  const defaultSessionId = statusQuery.data?.pi?.default?.sessionId;
  const accum = piSessionStore.getSessionAccum(defaultSessionId ?? "");

  return (
    <ChatPanel
      timeline={mergeTimelines(history, accum.appendedItems)}
      streamingText={accum.streamingText}
      statusPills={accum.statusPills}
      connectionState={snapshot.connectionState}
      onSendMessage={(text, deliveryMode, images) =>
        sendMessage(text, deliveryMode, images, defaultSessionId)
      }
    />
  );
}
