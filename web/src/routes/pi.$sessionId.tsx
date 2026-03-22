import { createFileRoute } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat/ChatPanel";
import { usePiSession } from "./pi.route";

export const Route = createFileRoute("/pi/$sessionId")({
  component: PiSessionRoute,
});

function PiSessionRoute() {
  const { sessionId } = Route.useParams();
  const { getSessionState, sendMessage, connectionState } = usePiSession();
  const session = getSessionState(sessionId);

  return (
    <ChatPanel
      timeline={session.timeline}
      streamingText={session.streamingText}
      statusPills={session.statusPills}
      connectionState={connectionState}
      onSendMessage={(text, deliveryMode, images) =>
        sendMessage(text, deliveryMode, images, sessionId)
      }
    />
  );
}
