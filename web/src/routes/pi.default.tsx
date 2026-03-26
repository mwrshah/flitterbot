import { createFileRoute } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat-panel";
import { usePiChat } from "~/hooks/use-pi-chat";
import { statusQueryOptions } from "~/lib/queries";
import type { ChatTimelineItem } from "~/lib/types";
import { fetchPiHistory } from "~/server/pi";

export const Route = createFileRoute("/pi/default")({
  staticData: {
    wsMode: "pi-default",
  },
  head: () => ({
    meta: [{ title: "Autonoma — Pi / Default" }],
  }),
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
  const { timeline, statusPills, connectionState, onSendMessage, effectiveSessionId } = usePiChat(
    defaultSessionId,
    history,
  );

  return (
    <ChatPanel
      sessionId={effectiveSessionId}
      timeline={timeline}
      statusPills={statusPills}
      connectionState={connectionState}
      onSendMessage={onSendMessage}
    />
  );
}
