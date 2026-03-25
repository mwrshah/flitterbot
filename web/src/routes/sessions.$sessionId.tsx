import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SessionDetail } from "~/components/session-detail";
import { SessionList } from "~/components/session-list";
import { TranscriptViewer } from "~/components/transcript-viewer";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";

export const Route = createFileRoute("/sessions/$sessionId")({
  component: SessionDetailPage,
});

function SessionDetailPage() {
  useWhyDidYouRender("SessionDetailPage", {});
  const { sessionId } = Route.useParams();
  const { apiClient } = Route.useRouteContext();

  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiClient.listSessions(),
    refetchInterval: 10_000,
  });

  const detailQuery = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => apiClient.getSessionDetail(sessionId),
    refetchInterval: 10_000,
  });

  useWhyDidYouRender("SessionDetailPage", { sessionId, apiClient, sessionsQuery, detailQuery });

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="grid grid-cols-[minmax(260px,0.8fr)_minmax(0,1.6fr)] gap-6 items-start">
        {/* Session sidebar */}
        <aside>
          {sessionsQuery.data ? (
            <SessionList
              items={sessionsQuery.data.items}
              selectedSessionId={sessionId}
              title="All sessions"
              description="Select a session to inspect."
            />
          ) : (
            <p className="text-sm text-muted-foreground">Loading...</p>
          )}
        </aside>

        {/* Detail + transcript */}
        <section className="space-y-4">
          {detailQuery.isPending && (
            <p className="text-sm text-muted-foreground">Loading detail...</p>
          )}
          {detailQuery.isError && (
            <p className="text-sm text-destructive">Failed to load session detail.</p>
          )}
          {detailQuery.data && (
            <SessionDetail session={detailQuery.data.session} tmux={detailQuery.data.tmux} />
          )}
          <TranscriptViewer sessionId={sessionId} />
        </section>
      </div>
    </div>
  );
}
