import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat-panel";
import { DownstreamSessionsPanel } from "~/components/downstream-sessions-panel";
import { Panel, PanelGroup, ResizeHandle } from "~/components/ui/resizable";
import { usePiChat } from "~/hooks/use-pi-chat";
import { statusQueryOptions, type StatusPill } from "~/lib/queries";
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
    const [status, items, sessions, worktree] = await Promise.all([
      context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient)),
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

    // If the session is already busy when we load the page (e.g. the user navigated
    // here after queue_item_start already fired), seed a processing pill so the Stop
    // button appears immediately rather than waiting for the next WS event.
    const allSessions = [
      status.pi?.default,
      ...(status.pi?.orchestrators ?? []),
    ].filter(Boolean);
    const thisSession = allSessions.find((s) => s!.sessionId === params.sessionId);
    if (thisSession?.busy) {
      context.queryClient.setQueryData<StatusPill[]>(
        ["pi-status-pills", params.sessionId],
        (old) => {
          // Don't duplicate if a real pill was already added by a WS event
          if (old?.some((p) => p.id.startsWith("processing-"))) return old;
          return [
            ...(old ?? []),
            { id: "processing-queued", label: "Processing message", variant: "info" as const },
          ];
        },
      );
    }

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
      <Panel defaultSize="75%" minSize="40%">
        <ChatPanel
          sessionId={effectiveSessionId}
          timeline={timeline}
          statusPills={statusPills}
          connectionState={connectionState}
          onSendMessage={onSendMessage}
        />
      </Panel>
      <ResizeHandle />
      <Panel defaultSize="25%" minSize="15%">
        <DownstreamSessionsPanel piSessionId={sessionId} />
      </Panel>
    </PanelGroup>
  );
}
