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
import { getBestStreamPiSessionId, isKnownStreamPiSession } from "~/lib/stream-route-targets";
import type { StatusResponse } from "~/lib/types";

export const Route = createFileRoute("/streams/$piSessionId")({
  staticData: {
    wsMode: "pi-session",
  },
  loader: async ({ params, context }) => {
    const status = await context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient));
    if (!isKnownStreamPiSession(status, params.piSessionId)) {
      redirectToBestStream(status);
    }

    void context.queryClient.prefetchQuery(
      streamsDownstreamSessionsQueryOptions(params.piSessionId),
    );
    void context.queryClient.prefetchQuery(streamsWorktreeQueryOptions(params.piSessionId));

    const history = await context.queryClient
      .ensureQueryData(streamsHistoryQueryOptions(params.piSessionId))
      .catch((error: unknown) => {
        if (error instanceof Error && /404|not found/i.test(error.message)) {
          redirectToBestStream(status);
        }
        throw error;
      });

    return { history };
  },
  head: () => ({
    meta: [{ title: "Flitterbot" }],
  }),
  errorComponent: ({ error }: ErrorComponentProps) => (
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
  const recoveryKind: "closed" | "dead" | undefined = isDefaultSession
    ? undefined
    : stream?.status === "closed"
      ? "closed"
      : stream?.piSessionStatus === "ended" || stream?.piSessionStatus === "crashed"
        ? "dead"
        : undefined;
  const selectedModel = isDefaultSession ? status?.piAgent?.default?.model : stream?.model;

  const { timeline, onSendMessage, effectivePiSessionId, isSessionBusy } = useStreamsChat(
    piSessionId,
    history,
  );

  return (
    <PanelGroup
      orientation="horizontal"
      className="h-full"
      defaultLayout={streamsLayout}
      onLayoutChanged={(layout: PanelLayout) => setConfig(STREAMS_MAIN_KEY, JSON.stringify(layout))}
    >
      <Panel id="chat" defaultSize="50%" minSize="30%">
        <ChatPanel
          piSessionId={effectivePiSessionId}
          timeline={timeline}
          isSessionBusy={isSessionBusy}
          onSendMessage={onSendMessage}
          streamId={isDefaultSession ? undefined : stream?.id}
          streamName={isDefaultSession ? "flitterbot" : stream?.name}
          streamHasWorktree={!isDefaultSession && !!stream?.worktreePath}
          selectedModelId={selectedModel?.id}
          selectedThinkingLevel={selectedModel?.thinkingLevel}
          recoveryKind={recoveryKind}
        />
      </Panel>
      <ResizeHandle />
      <Panel id="downstream" defaultSize="50%" minSize="25%" collapsible collapsedSize="2px">
        <DownstreamSessionsPanel
          key={effectivePiSessionId}
          piSessionId={effectivePiSessionId}
          piSessionStatus={isDefaultSession ? undefined : stream?.piSessionStatus}
        />
      </Panel>
    </PanelGroup>
  );
}

function redirectToBestStream(status: StatusResponse): never {
  const piSessionId = getBestStreamPiSessionId(status);
  if (piSessionId) {
    throw redirect({ to: "/streams/$piSessionId", params: { piSessionId } });
  }
  throw redirect({ to: "/" });
}
