import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat-panel";
import { DownstreamSessionsPanel } from "~/components/downstream-sessions-panel";
import { Panel, PanelGroup, ResizeHandle } from "~/components/ui/resizable";
import { usePiChat } from "~/hooks/use-pi-chat";
import {
  piDownstreamSessionsQueryOptions,
  piHistoryQueryOptions,
  piWorktreeQueryOptions,
  statusQueryOptions,
  type StatusPill,
} from "~/lib/queries";

export const Route = createFileRoute("/pi/$sessionId")({
  staticData: {
    wsMode: "pi-session",
  },
  head: () => ({
    meta: [{ title: "Autonoma — Pi Session" }],
  }),
  loader: async ({ params, context }) => {
    // Use ensureQueryData for all three fetches so that:
    // - Active sessions (data already in cache from WS events) navigate instantly
    // - Cold/first visits still fetch normally
    // piHistoryQueryOptions has staleTime: Infinity — WS events keep it fresh,
    // so for any session the user has visited or that has received WS events,
    // this is a synchronous cache hit with zero network round-trips.
    const [status, history] = await Promise.all([
      context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient)),
      context.queryClient
        .ensureQueryData(piHistoryQueryOptions(params.sessionId))
        .catch((error: unknown) => {
          if (error instanceof Error && /404|not found/i.test(error.message)) {
            throw redirect({ to: "/pi/default" });
          }
          throw error;
        }),
      // Sessions and worktree are non-blocking — kick off prefetches so they're
      // in cache when DownstreamSessionsPanel mounts, but don't hold up navigation.
      context.queryClient.prefetchQuery(piDownstreamSessionsQueryOptions(params.sessionId)),
      context.queryClient.prefetchQuery(piWorktreeQueryOptions(params.sessionId)),
    ]);

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
