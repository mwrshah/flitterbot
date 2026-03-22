import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SessionList } from "~/components/sessions/SessionList";

export const Route = createFileRoute("/sessions/")({
  component: SessionsIndexPage,
});

function SessionsIndexPage() {
  const { apiClient } = Route.useRouteContext();

  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiClient.listSessions(),
    refetchInterval: 10_000,
  });

  return (
    <div className="flex-1 overflow-auto p-6">
      {sessionsQuery.isPending && (
        <p className="text-sm text-muted-foreground">Loading sessions...</p>
      )}
      {sessionsQuery.isError && (
        <p className="text-sm text-destructive">Failed to load sessions.</p>
      )}
      {sessionsQuery.data && (
        <SessionList
          items={sessionsQuery.data.items}
          title="Claude Code sessions"
          description="Status, task, worktree context, and transcript for each session."
        />
      )}
    </div>
  );
}
