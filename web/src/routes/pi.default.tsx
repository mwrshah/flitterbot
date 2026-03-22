import { createFileRoute } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat/ChatPanel";
import { usePiSession } from "./pi.route";

export const Route = createFileRoute("/pi/default")({
  component: PiDefaultRoute,
});

function PiDefaultRoute() {
  const { getSessionState, sendMessage, connectionState } = usePiSession();
  const session = getSessionState("default");

  return (
    <ChatPanel
      timeline={session.timeline}
      streamingText={session.streamingText}
      statusPills={session.statusPills}
      connectionState={connectionState}
      onSendMessage={(text, deliveryMode, images) =>
        sendMessage(text, deliveryMode, images, undefined)
      }
    />
  );
}
