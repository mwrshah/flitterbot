import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  type ErrorComponentProps,
  getRouteApi,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import type { Layout as PanelLayout } from "react-resizable-panels";
import { ChatPanel } from "@/components/chat-panel";
import { Panel, PanelGroup, ResizeHandle } from "@/components/common/resizable";
import { DownstreamSessionsPanel } from "@/components/downstream-sessions-panel";
import { useStreamsChat } from "@/hooks/use-streams-chat";
import { parsePanelLayout, useUserConfig } from "@/hooks/use-user-config";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import {
  statusQueryOptions,
  streamsDownstreamSessionsQueryOptions,
  streamsHistoryInfiniteQueryOptions,
  streamsWorktreeQueryOptions,
} from "@/lib/queries";
import { getStreamRecoveryKind } from "@/lib/stream-recovery";
import { isKnownStreamPiSession } from "@/lib/stream-route-targets";

export const Route = createFileRoute("/streams/$piSessionId")({
  staticData: {
    wsMode: "pi-session",
  },
  loader: async ({ params, context }) => {
    const status = await context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient));
    if (!isKnownStreamPiSession(status, params.piSessionId)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      throw redirect({ to: "/streams/default" });
    }

    await Promise.all([
      context.queryClient.ensureInfiniteQueryData(
        streamsHistoryInfiniteQueryOptions(params.piSessionId),
      ),
      context.queryClient.prefetchQuery(streamsDownstreamSessionsQueryOptions(params.piSessionId)),
      context.queryClient.prefetchQuery(streamsWorktreeQueryOptions(params.piSessionId)),
    ]);
  },
  head: () => ({
    meta: [{ title: "Flitterbot" }],
  }),
  errorComponent: ({ error }: ErrorComponentProps) => (
    <div className="flex h-full items-center justify-center p-8 text-status-crashed">
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
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const navigate = useNavigate();
  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const defaultPiSessionId = status?.piAgent?.default?.piSessionId;
  const isDefaultSession = piSessionId === defaultPiSessionId;
  const previousDefaultPiSessionIdRef = useRef(defaultPiSessionId);

  useEffect(() => {
    const previousDefaultPiSessionId = previousDefaultPiSessionIdRef.current;
    if (defaultPiSessionId) previousDefaultPiSessionIdRef.current = defaultPiSessionId;

    if (!previousDefaultPiSessionId || !defaultPiSessionId) return;
    if (piSessionId !== previousDefaultPiSessionId || piSessionId === defaultPiSessionId) return;
    navigate({
      to: "/streams/$piSessionId",
      params: { piSessionId: defaultPiSessionId },
      replace: true,
    });
  }, [defaultPiSessionId, navigate, piSessionId]);

  const stream = status?.streams?.find((ws) => ws.piSessionId === piSessionId);

  const recoveryKind = isDefaultSession ? undefined : getStreamRecoveryKind(stream);
  const selectedModel = isDefaultSession ? status?.piAgent?.default?.model : stream?.model;

  const {
    timeline,
    turnQueue,
    onSendMessage,
    effectivePiSessionId,
    isSessionBusy,
    isSessionCompacting,
    contextUsage,
    loadPreviousPage,
    hasPreviousPage,
    isFetchingPreviousPage,
  } = useStreamsChat(piSessionId);

  return (
    <PanelGroup
      orientation="horizontal"
      className="h-full"
      style={{ overflow: "visible" }}
      defaultLayout={streamsLayout}
      onLayoutChanged={(layout: PanelLayout) => setConfig(STREAMS_MAIN_KEY, JSON.stringify(layout))}
    >
      <Panel id="chat" defaultSize="50%" minSize="30%" style={{ overflow: "visible" }}>
        <ChatPanel
          piSessionId={effectivePiSessionId}
          timeline={timeline}
          turnQueue={turnQueue}
          isSessionBusy={isSessionBusy}
          isSessionCompacting={isSessionCompacting}
          contextUsage={contextUsage}
          onSendMessage={onSendMessage}
          onLoadPrevious={loadPreviousPage}
          hasPreviousPage={hasPreviousPage}
          isFetchingPreviousPage={isFetchingPreviousPage}
          streamId={isDefaultSession ? undefined : stream?.id}
          streamName={isDefaultSession ? "flitterbot" : stream?.name}
          streamType={isDefaultSession ? "defaultStream" : stream?.type}
          streamHasWorktree={!isDefaultSession && stream?.type === "work" && !!stream?.worktreePath}
          selectedModelId={selectedModel?.id}
          selectedThinkingLevel={selectedModel?.thinkingLevel}
          recoveryKind={recoveryKind}
          messageInputDisabled={!isDefaultSession && !stream}
        />
      </Panel>
      <ResizeHandle />
      <Panel id="downstream" defaultSize="50%" minSize="25%" collapsible collapsedSize="2px">
        <DownstreamSessionsPanel
          key={effectivePiSessionId}
          piSessionId={effectivePiSessionId}
          piSessionStatus={isDefaultSession ? undefined : stream?.piSessionStatus}
          showSettings={isDefaultSession}
        />
      </Panel>
    </PanelGroup>
  );
}
