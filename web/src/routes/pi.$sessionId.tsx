import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat-panel";
import { usePiChat } from "~/hooks/use-pi-chat";
import type { ChatTimelineItem } from "~/lib/types";
import { fetchPiHistory } from "~/server/pi";

export const Route = createFileRoute("/pi/$sessionId")({
  staticData: {
    wsMode: "pi-session",
  },
  head: () => ({
    meta: [{ title: "Autonoma — Pi Session" }],
  }),
  loader: async ({ params, context }) => {
    const items = await fetchPiHistory({ data: { piSessionId: params.sessionId } }).catch(
      (error: unknown) => {
        if (error instanceof Error && /404|not found/i.test(error.message)) {
          throw redirect({ to: "/pi/default" });
        }
        throw error;
      },
    );
    const history = items as ChatTimelineItem[];
    // Seed the Query cache so useQuery returns instantly
    context.queryClient.setQueryData(["pi-history", params.sessionId, "agent"], history);
    return { history };
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
  const { timeline, statusPills, connectionState, onSendMessage, effectiveSessionId } = usePiChat(
    sessionId,
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
