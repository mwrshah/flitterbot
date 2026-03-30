import { createFileRoute } from "@tanstack/react-router";
import { ChatPanel } from "~/components/chat-panel";
import { DownstreamSessionsPanel } from "~/components/downstream-sessions-panel";
import { Panel, PanelGroup, ResizeHandle } from "~/components/ui/resizable";
import { usePiChat } from "~/hooks/use-pi-chat";
import { statusQueryOptions, type StatusPill } from "~/lib/queries";
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

    // If the default session is already busy when we load the page (e.g. navigating
    // here after queue_item_start has already fired), seed a processing pill so the
    // Stop button appears immediately rather than waiting for the next WS event.
    if (defaultSessionId && status.pi?.default?.busy) {
      context.queryClient.setQueryData<StatusPill[]>(
        ["pi-status-pills", defaultSessionId],
        (old) => {
          if (old?.some((p) => p.id.startsWith("processing-"))) return old;
          return [
            ...(old ?? []),
            { id: "processing-queued", label: "Processing message", variant: "info" as const },
          ];
        },
      );
    }

    return { history, defaultSessionId };
  },
  errorComponent: ({ error }) => (
    <div className="flex items-center justify-center h-full p-8 text-destructive">
      <p>Failed to load history: {String(error)}</p>
    </div>
  ),
  component: PiDefaultRoute,
});

function PiDefaultRoute() {
  const { history, defaultSessionId } = Route.useLoaderData();
  const { timeline, statusPills, connectionState, onSendMessage, effectiveSessionId } = usePiChat(
    defaultSessionId,
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
        <DownstreamSessionsPanel piSessionId={effectiveSessionId} />
      </Panel>
    </PanelGroup>
  );
}
