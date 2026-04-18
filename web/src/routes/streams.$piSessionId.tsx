import { useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat-panel";
import { Panel, PanelGroup, ResizeHandle } from "~/components/common/resizable";
import { DownstreamSessionsPanel } from "~/components/downstream-sessions-panel";
import { useStreamsChat } from "~/hooks/use-streams-chat";
import { parsePanelLayout, useUserConfig } from "~/hooks/use-user-config";
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
    meta: [{ title: "Flitterbot" }],
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

const STREAMS_MAIN_KEY = "panel:streams-main";
const STREAMS_MAIN_DEFAULT: Record<string, number> = { chat: 50, downstream: 50 };

function PiSessionRoute() {
  useWhyDidYouRender("PiSessionRoute", {});
  const { config, setConfig } = useUserConfig();
  const streamsLayout = parsePanelLayout(config, STREAMS_MAIN_KEY, STREAMS_MAIN_DEFAULT);
  const { piSessionId } = Route.useParams();
  const { history } = Route.useLoaderData();
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const stream = status?.streams?.find((ws) => ws.piSessionId === piSessionId);
  // Recovery kind drives which button (if any) renders in the chat header:
  //   - 'closed'  → stream itself was closed; show "Reopen"
  //   - 'dead'    → stream is open but its orchestrator pi-session ended or
  //                 crashed; show "Recover"
  //   - undefined → nothing to recover
  const recoveryKind: "closed" | "dead" | undefined =
    stream?.status === "closed"
      ? "closed"
      : stream?.piSessionStatus === "ended" || stream?.piSessionStatus === "crashed"
        ? "dead"
        : undefined;

  const { timeline, onSendMessage, effectivePiSessionId, isSessionBusy } = useStreamsChat(
    piSessionId,
    history,
  );

  return (
    <PanelGroup
      orientation="horizontal"
      className="h-full"
      defaultLayout={streamsLayout}
      onLayoutChanged={(layout) => setConfig(STREAMS_MAIN_KEY, JSON.stringify(layout))}
    >
      <Panel id="chat" defaultSize="50%" minSize="30%">
        <ChatPanel
          piSessionId={effectivePiSessionId}
          timeline={timeline}
          isSessionBusy={isSessionBusy}
          onSendMessage={onSendMessage}
          streamId={stream?.id}
          streamName={stream?.name}
          recoveryKind={recoveryKind}
        />
      </Panel>
      <ResizeHandle />
      <Panel id="downstream" defaultSize="50%" minSize="20%">
        <DownstreamSessionsPanel
          piSessionId={piSessionId}
          piSessionStatus={stream?.piSessionStatus}
        />
      </Panel>
    </PanelGroup>
  );
}
