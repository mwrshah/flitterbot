import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat-panel";
import { piSessionStore, usePiSessionStore } from "~/lib/pi-session-store";
import type { ChatTimelineItem } from "~/lib/types";
import { fetchPiHistory } from "~/server/pi";
import { mergeTimelines } from "~/lib/utils";

export const Route = createFileRoute("/pi/$sessionId")({
  loader: async ({ params }) => {
    try {
      const items = await fetchPiHistory({ data: { piSessionId: params.sessionId } });
      return { history: items as ChatTimelineItem[] };
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
  const history = Route.useLoaderData()?.history ?? [];
  const snapshot = usePiSessionStore();
  const accum = piSessionStore.getSessionAccum(sessionId);
  const sendMessage = piSessionStore.getSendMessage();

  return (
    <ChatPanel
      sessionId={sessionId}
      timeline={mergeTimelines(history, accum.appendedItems)}
      statusPills={accum.statusPills}
      connectionState={snapshot.connectionState}
      onSendMessage={(text, deliveryMode, images) =>
        sendMessage(text, deliveryMode, images, sessionId)
      }
    />
  );
}
