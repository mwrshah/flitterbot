import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat-panel";
import { piSessionStore, usePiSessionStore } from "~/lib/pi-session-store";
import { piHistoryQueryOptions, statusQueryOptions } from "~/lib/queries";
import { fetchPiHistory } from "~/server/pi";
import { mergeTimelines } from "~/lib/utils";
import type { ChatTimelineItem } from "~/lib/types";

export const Route = createFileRoute("/pi/default")({
  loader: async () => {
    // Prefetch default history in surfaced mode (user + final assistant only)
    const items = await fetchPiHistory({ data: { surface: "input" } });
    return { history: items as ChatTimelineItem[] };
  },
  errorComponent: ({ error }) => (
    <div className="flex items-center justify-center h-full p-8 text-destructive">
      <p>Failed to load history: {String(error)}</p>
    </div>
  ),
  component: PiDefaultRoute,
});

/**
 * Filter accum items to only surfaced content: user messages and pi_surfaced
 * assistant messages (source === "pi_outbound"). Strips tool events,
 * intermediate assistant messages, and dividers.
 */
function filterSurfacedItems(items: ChatTimelineItem[]): ChatTimelineItem[] {
  return items.filter((item) => {
    if (item.kind !== "message") return false;
    if (item.role === "user") return true;
    if (item.role === "assistant" && item.source === "pi_outbound") return true;
    return false;
  });
}

function PiDefaultRoute() {
  const loaderData = Route.useLoaderData();
  const { apiClient } = Route.useRouteContext();
  const snapshot = usePiSessionStore();
  const sendMessage = piSessionStore.getSendMessage();

  // Read the default agent's piSessionId from the status query (already loaded by parent route)
  const statusQuery = useQuery(statusQueryOptions(apiClient));
  const defaultSessionId = statusQuery.data?.pi?.default?.sessionId;

  // History query keyed by defaultSessionId in surfaced mode — auto-refetches when session changes
  const historyQuery = useQuery({
    ...piHistoryQueryOptions(defaultSessionId, "input"),
    // Use loader data as initial data only when no sessionId is known yet
    initialData: defaultSessionId ? undefined : loaderData.history,
  });

  const history = historyQuery.data ?? [];
  const accum = piSessionStore.getSessionAccum(defaultSessionId ?? "");

  // When defaultSessionId changes, clear the old session's accum
  const prevSessionIdRef = useRef(defaultSessionId);
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    if (prev && prev !== defaultSessionId) {
      piSessionStore.clearSession(prev);
    }
    prevSessionIdRef.current = defaultSessionId;
  }, [defaultSessionId]);

  // Filter accum to surfaced content only — no tools, no intermediate assistant messages
  const surfacedAccumItems = filterSurfacedItems(accum.appendedItems);

  return (
    <ChatPanel
      timeline={mergeTimelines(history, surfacedAccumItems)}
      streamingText={accum.streamingText}
      streamingMessageId={accum.streamingMessageId}
      statusPills={accum.statusPills}
      connectionState={snapshot.connectionState}
      onSendMessage={(text, deliveryMode, images) =>
        sendMessage(text, deliveryMode, images, defaultSessionId)
      }
    />
  );
}
