import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat-panel";
import { Panel, PanelGroup, ResizeHandle } from "~/components/common/resizable";
import { DownstreamSessionsPanel } from "~/components/downstream-sessions-panel";
import { useStreamsChat } from "~/hooks/use-streams-chat";
import { statusQueryOptions } from "~/lib/queries";
import type { ChatTimelineItem } from "~/lib/types";
import { fetchStreamsHistory, fetchStreamSessions, fetchStreamsWorktree } from "~/server/streams";

export const Route = createFileRoute("/streams/default")({
  staticData: {
    wsMode: "streams-default",
  },
  head: () => ({
    meta: [{ title: "Autonoma — Streams / Default" }],
  }),
  loader: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient));
    const defaultPiSessionId = status.streamAgent?.default?.piSessionId;
    const items = await fetchStreamsHistory({ data: {} });
    const history = items as ChatTimelineItem[];

    // Seed the Query cache under the real piSessionId when available.
    if (defaultPiSessionId) {
      const [sessions, worktree] = await Promise.all([
        fetchStreamSessions({ data: { piSessionId: defaultPiSessionId } }).catch(() => []),
        fetchStreamsWorktree({ data: { piSessionId: defaultPiSessionId } }).catch(() => null),
      ]);
      context.queryClient.setQueryData(["streams-history", defaultPiSessionId, "agent"], history);
      context.queryClient.setQueryData(["streams-downstream-sessions", defaultPiSessionId], sessions);
      context.queryClient.setQueryData(["streams-worktree", defaultPiSessionId], worktree);
    }

    return { history };
  },
  errorComponent: ({ error }) => (
    <div className="flex items-center justify-center h-full p-8 text-destructive">
      <p>Failed to load history: {String(error)}</p>
    </div>
  ),
  component: StreamsDefaultRoute,
});

function StreamsDefaultRoute() {
  const { history } = Route.useLoaderData();
  const { apiClient } = Route.useRouteContext();
  // Derive defaultPiSessionId reactively from the status query cache so it
  // updates when the default Streams session restarts with a new ID, rather than
  // being frozen at the loader-time value.
  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const defaultPiSessionId = status?.streamAgent?.default?.piSessionId;
  const { timeline, statusPills, onSendMessage, effectivePiSessionId, isSessionBusy } =
    useStreamsChat(defaultPiSessionId, history);

  return (
    <PanelGroup orientation="horizontal" className="h-full">
      <Panel defaultSize="75%" minSize="40%">
        <ChatPanel
          piSessionId={effectivePiSessionId}
          timeline={timeline}
          statusPills={statusPills}
          isSessionBusy={isSessionBusy}
          onSendMessage={onSendMessage}
        />
      </Panel>
      <ResizeHandle />
      <Panel defaultSize="25%" minSize="15%">
        <DownstreamSessionsPanel piSessionId={effectivePiSessionId} />
      </Panel>
    </PanelGroup>
  );
}
