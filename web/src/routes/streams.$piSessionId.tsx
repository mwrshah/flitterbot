import { useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat-panel";
import { Panel, PanelGroup, ResizeHandle } from "~/components/common/resizable";
import { DownstreamSessionsPanel } from "~/components/downstream-sessions-panel";
import { useStreamsChat } from "~/hooks/use-streams-chat";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import {
  statusQueryOptions,
  streamsDownstreamSessionsQueryOptions,
  streamsHistoryQueryOptions,
  streamsWorktreeQueryOptions,
} from "~/lib/queries";

export const Route = createFileRoute("/streams/$piSessionId")({
  staticData: {
    wsMode: "pi-session",
  },
  head: () => ({
    meta: [{ title: "Autonoma — Pi Session" }],
  }),
  loader: async ({ params, context }) => {
    // Seed from cache when available so route transitions stay instant.
    // The component query revalidates in the background on mount, giving us
    // stale-while-revalidate behavior instead of trusting cached history forever.
    const [, history] = await Promise.all([
      context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient)),
      context.queryClient
        .ensureQueryData(streamsHistoryQueryOptions(params.piSessionId))
        .catch((error: unknown) => {
          if (error instanceof Error && /404|not found/i.test(error.message)) {
            throw redirect({ to: "/streams/default" });
          }
          throw error;
        }),
      // Sessions and worktree are non-blocking — kick off prefetches so they're
      // in cache when DownstreamSessionsPanel mounts, but don't hold up navigation.
      context.queryClient.prefetchQuery(streamsDownstreamSessionsQueryOptions(params.piSessionId)),
      context.queryClient.prefetchQuery(streamsWorktreeQueryOptions(params.piSessionId)),
    ]);

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
  useWhyDidYouRender("PiSessionRoute", {});
  const { piSessionId } = Route.useParams();
  const { history } = Route.useLoaderData();
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const stream = status?.streams?.find((ws) => ws.piSessionId === piSessionId);
  const isStreamClosed = stream?.status === "closed";

  const { timeline, statusPills, onSendMessage, effectivePiSessionId, isSessionBusy } =
    useStreamsChat(piSessionId, history);

  return (
    <PanelGroup orientation="horizontal" className="h-full">
      <Panel defaultSize="75%" minSize="40%">
        <ChatPanel
          piSessionId={effectivePiSessionId}
          timeline={timeline}
          statusPills={statusPills}
          isSessionBusy={isSessionBusy}
          onSendMessage={onSendMessage}
          streamId={stream?.id}
          streamName={stream?.name}
          isStreamClosed={isStreamClosed}
        />
      </Panel>
      <ResizeHandle />
      <Panel defaultSize="25%" minSize="15%">
        <DownstreamSessionsPanel
          piSessionId={piSessionId}
          piSessionStatus={stream?.piSessionStatus}
        />
      </Panel>
    </PanelGroup>
  );
}
