import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { TranscriptViewer } from "~/components/sessions/TranscriptViewer";
import { Badge } from "~/components/ui/Badge";
import type { SessionSummary } from "~/lib/types";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/sessions/workstream/$workstreamId")({
  component: WorkstreamSessionsPage,
});

type LayoutMode = "grid" | "stacked";

function statusVariant(status: string): "success" | "default" | "warning" | "muted" {
  switch (status) {
    case "working":
      return "success";
    case "idle":
      return "default";
    case "stale":
      return "warning";
    default:
      return "muted";
  }
}

function WorkstreamSessionsPage() {
  const { workstreamId } = Route.useParams();
  const { apiClient } = Route.useRouteContext();
  const [layout, setLayout] = useState<LayoutMode>("grid");

  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiClient.listSessions(),
    refetchInterval: 10_000,
  });

  const allSessions = sessionsQuery.data?.items ?? [];
  const sessions = allSessions.filter((s) => s.workstreamId === workstreamId);
  const workstreamName = sessions[0]?.workstreamName ?? workstreamId;

  return (
    <div className="flex-1 overflow-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link
            to="/sessions"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; Sessions
          </Link>
          <h1 className="text-lg font-semibold text-foreground">{workstreamName}</h1>
          <span className="text-sm text-muted-foreground">
            {sessions.length} session{sessions.length !== 1 && "s"}
          </span>
        </div>

        {/* Layout toggle */}
        <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
          <button
            onClick={() => setLayout("grid")}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
              layout === "grid"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Grid
          </button>
          <button
            onClick={() => setLayout("stacked")}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
              layout === "stacked"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Stacked
          </button>
        </div>
      </div>

      {/* Loading / error */}
      {sessionsQuery.isPending && (
        <p className="text-sm text-muted-foreground">Loading sessions...</p>
      )}
      {sessionsQuery.isError && (
        <p className="text-sm text-destructive">Failed to load sessions.</p>
      )}

      {/* Sessions */}
      {sessions.length === 0 && sessionsQuery.isSuccess && (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No sessions found for this workstream.
        </p>
      )}

      {sessions.length > 0 && (
        <div
          className={cn(
            layout === "grid"
              ? "grid grid-cols-[repeat(auto-fit,minmax(480px,1fr))] gap-4"
              : "space-y-4",
          )}
        >
          {sessions.map((session) => (
            <SessionTranscriptPanel key={session.sessionId} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionTranscriptPanel({ session }: { session: SessionSummary }) {
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Panel header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant={statusVariant(session.status)}>{session.status}</Badge>
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: session.sessionId }}
            className="text-sm font-medium text-foreground truncate hover:underline"
          >
            {session.taskDescription || session.sessionId}
          </Link>
        </div>
        {session.project && (
          <span className="text-xs text-muted-foreground shrink-0">{session.project}</span>
        )}
      </div>

      {/* Transcript */}
      <div className="max-h-[600px] overflow-auto">
        <TranscriptViewer sessionId={session.sessionId} />
      </div>
    </div>
  );
}
