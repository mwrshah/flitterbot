import { useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat-panel";
import { Panel, PanelGroup, ResizeHandle } from "~/components/common/resizable";
import { DownstreamSessionsPanel } from "~/components/downstream-sessions-panel";
import { useStreamsChat } from "~/hooks/use-streams-chat";
import {
  streamsDownstreamSessionsQueryOptions,
  streamsHistoryQueryOptions,
  streamsWorktreeQueryOptions,
  statusQueryOptions,
} from "~/lib/queries";

export const Route = createFileRoute("/streams/$sessionId")({
  staticData: {
    wsMode: "streams-session",
  },
  head: () => ({
    meta: [{ title: "Autonoma — Streams Session" }],
  }),
  loader: async ({ params, context }) => {
    // Use ensureQueryData for all three fetches so that:
    // - Active sessions (data already in cache from WS events) navigate instantly
    // - Cold/first visits still fetch normally
    // streamsHistoryQueryOptions has staleTime: Infinity — WS events keep it fresh,
    // so for any session the user has visited or that has received WS events,
    // this is a synchronous cache hit with zero network round-trips.
    const [, history] = await Promise.all([
      context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient)),
      context.queryClient
        .ensureQueryData(streamsHistoryQueryOptions(params.sessionId))
        .catch((error: unknown) => {
          if (error instanceof Error && /404|not found/i.test(error.message)) {
            throw redirect({ to: "/streams/default" });
          }
          throw error;
        }),
      // Sessions and worktree are non-blocking — kick off prefetches so they're
      // in cache when DownstreamSessionsPanel mounts, but don't hold up navigation.
      context.queryClient.prefetchQuery(streamsDownstreamSessionsQueryOptions(params.sessionId)),
      context.queryClient.prefetchQuery(streamsWorktreeQueryOptions(params.sessionId)),
    ]);

    return { history };
  },
  errorComponent: ({ error }) => (
    <div className="flex items-center justify-center h-full p-8 text-destructive">
      <p>Failed to load session history: {String(error)}</p>
    </div>
  ),
  component: StreamsSessionRoute,
});

function StreamsSessionRoute() {
  const { sessionId } = Route.useParams();
  const { history } = Route.useLoaderData();
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const stream = status?.streams_list?.find((ws) => ws.piSessionId === sessionId);
  const isStreamClosed = stream?.status === "closed";

  const { timeline, statusPills, onSendMessage, effectiveSessionId, isSessionBusy } = useStreamsChat(
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
          isSessionBusy={isSessionBusy}
          onSendMessage={onSendMessage}
          streamId={stream?.id}
          isStreamClosed={isStreamClosed}
        />
      </Panel>
      <ResizeHandle />
      <Panel defaultSize="25%" minSize="15%">
        <DownstreamSessionsPanel piSessionId={sessionId} />
      </Panel>
    </PanelGroup>
  );
}
