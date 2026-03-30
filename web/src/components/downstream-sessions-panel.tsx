import { useQuery } from "@tanstack/react-query";
import { piDownstreamSessionsQueryOptions, piWorktreeQueryOptions } from "~/lib/queries";
import type { DownstreamSessionItem } from "~/lib/types";
import { cn } from "~/lib/utils";

function statusDotColor(status: DownstreamSessionItem["status"]): string {
  switch (status) {
    case "working":
      return "bg-emerald-500";
    case "idle":
      return "bg-blue-400";
    case "stale":
      return "bg-amber-500";
    case "ended":
      return "bg-zinc-500";
  }
}

function statusLabel(status: DownstreamSessionItem["status"]): string {
  switch (status) {
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "stale":
      return "stale";
    case "ended":
      return "ended";
  }
}

export function DownstreamSessionsPanel({
  piSessionId,
}: { piSessionId: string | undefined }) {
  const { data, isPending, isError } = useQuery(
    piDownstreamSessionsQueryOptions(piSessionId ?? ""),
  );

  const worktreeQuery = useQuery(
    piWorktreeQueryOptions(piSessionId ?? ""),
  );
  const worktree = worktreeQuery.data;

  if (!piSessionId) {
    return (
      <div className="flex flex-col h-full border-l border-border bg-background">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Active Sessions</h2>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-muted-foreground">Waiting for session…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full border-l border-border bg-background">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">Active Sessions</h2>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isPending && (
          <p className="px-4 py-3 text-xs text-muted-foreground">Loading sessions…</p>
        )}
        {isError && (
          <p className="px-4 py-3 text-xs text-destructive">Failed to load sessions.</p>
        )}
        {data && data.length === 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">No active sessions</p>
        )}
        {data && data.length > 0 && (
          <ul className="divide-y divide-border">
            {data.map((session) => (
              <li key={session.sessionId} className="flex flex-col gap-0.5 px-4 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={cn("shrink-0 h-2 w-2 rounded-full", statusDotColor(session.status))}
                    title={statusLabel(session.status)}
                  />
                  <span className="truncate font-mono text-xs text-foreground">
                    {session.sessionId.slice(0, 8)}
                  </span>
                </div>

                <span className="pl-4 text-xs text-muted-foreground truncate">
                  {(() => {
                    const name = session.workstreamName ?? "no workstream";
                    if (session.cwd) {
                      const parts = session.cwd.split("/");
                      const parentDir = parts[parts.length - 2] ?? "";
                      return parentDir ? `${parentDir}/${name}` : name;
                    }
                    return name;
                  })()}
                </span>
              </li>
            ))}
          </ul>
        )}

        {worktree?.worktreePath && (
          <div className="px-4 py-3 border-t border-border">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
              Active Worktree
            </p>
            <div className="flex flex-col gap-0.5 py-1.5">
              <span className="truncate text-xs font-medium text-foreground">{worktree.name}</span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="truncate">{worktree.worktreePath.split("/").pop()}</span>
                {worktree.repoPath && (
                  <>
                    <span>·</span>
                    <span className="shrink-0">{worktree.repoPath.split("/").pop()}</span>
                  </>
                )}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
