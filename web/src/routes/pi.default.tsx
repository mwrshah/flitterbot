import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat-panel";
import { DownstreamSessionsPanel } from "~/components/downstream-sessions-panel";
import { Panel, PanelGroup, ResizeHandle } from "~/components/ui/resizable";
import { usePiChat } from "~/hooks/use-pi-chat";
import { statusQueryOptions } from "~/lib/queries";
import type { ChatTimelineItem } from "~/lib/types";
import { fetchPiHistory, fetchPiSessions, fetchPiWorktree } from "~/server/pi";

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
      const [sessions, worktree] = await Promise.all([
        fetchPiSessions({ data: { piSessionId: defaultSessionId } }).catch(() => []),
        fetchPiWorktree({ data: { piSessionId: defaultSessionId } }).catch(() => null),
      ]);
      context.queryClient.setQueryData(["pi-history", defaultSessionId, "agent"], history);
      context.queryClient.setQueryData(["pi-downstream-sessions", defaultSessionId], sessions);
      context.queryClient.setQueryData(["pi-worktree", defaultSessionId], worktree);
    }

    return { history };
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
  // Derive defaultSessionId reactively from the status query cache so it
  // updates when the default Pi session restarts with a new ID, rather than
  // being frozen at the loader-time value.
  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const defaultSessionId = status?.pi?.default?.sessionId;
  const { timeline, statusPills, connectionState, onSendMessage, effectiveSessionId, isSessionBusy } = usePiChat(
    defaultSessionId,
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
          isSessionBusy={isSessionBusy}
          onSendMessage={onSendMessage}
        />
      </Panel>
      <ResizeHandle />
      <Panel defaultSize="25%" minSize="15%">
        <DownstreamSessionsPanel piSessionId={effectiveSessionId} />
      </Panel>
    </PanelGroup>
  );
}
