import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat-panel";
import { DownstreamSessionsPanel } from "~/components/downstream-sessions-panel";
import { Panel, PanelGroup, ResizeHandle } from "~/components/ui/resizable";
import { usePiChat } from "~/hooks/use-pi-chat";
import type { ChatTimelineItem } from "~/lib/types";
import { fetchPiHistory, fetchPiSessions, fetchPiWorktree } from "~/server/pi";

export const Route = createFileRoute("/pi/$sessionId")({
  staticData: {
    wsMode: "pi-session",
  },
  head: () => ({
    meta: [{ title: "Autonoma — Pi Session" }],
  }),
  loader: async ({ params, context }) => {
    const [items, sessions, worktree] = await Promise.all([
      fetchPiHistory({ data: { piSessionId: params.sessionId } }).catch((error: unknown) => {
        if (error instanceof Error && /404|not found/i.test(error.message)) {
          throw redirect({ to: "/pi/default" });
        }
        throw error;
      }),
      fetchPiSessions({ data: { piSessionId: params.sessionId } }).catch(() => []),
      fetchPiWorktree({ data: { piSessionId: params.sessionId } }).catch(() => null),
    ]);
    const history = items as ChatTimelineItem[];
    // Seed the Query cache so useQuery returns instantly
    context.queryClient.setQueryData(["pi-history", params.sessionId, "agent"], history);
    context.queryClient.setQueryData(["pi-downstream-sessions", params.sessionId], sessions);
    context.queryClient.setQueryData(["pi-worktree", params.sessionId], worktree);
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
    <PanelGroup orientation="horizontal" className="h-full">
      <Panel defaultSize={75} minSize={40}>
        <ChatPanel
          sessionId={effectiveSessionId}
          timeline={timeline}
          statusPills={statusPills}
          connectionState={connectionState}
          onSendMessage={onSendMessage}
        />
      </Panel>
      <ResizeHandle />
      <Panel defaultSize={25} minSize={15}>
        <DownstreamSessionsPanel piSessionId={sessionId} />
      </Panel>
    </PanelGroup>
  );
}
