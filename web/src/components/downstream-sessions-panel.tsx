import { useQuery } from "@tanstack/react-query";
import { useCopyToClipboard } from "~/hooks/use-copy-to-clipboard";
import { streamsDownstreamSessionsQueryOptions, streamsWorktreeQueryOptions } from "~/lib/queries";
import type { DownstreamSessionItem } from "~/lib/types";
import { cn } from "~/lib/utils";

function CopyableCode({ text, displayText }: { text: string; displayText?: string }) {
  const { copied, copy } = useCopyToClipboard(600);
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      className="inline-block font-mono text-xs bg-muted/60 hover:bg-muted rounded px-1.5 py-0.5 cursor-pointer truncate max-w-full text-left transition-colors"
      title={`copy \`${text}\``}
    >
      {copied ? (
        <span className="text-muted-foreground">Copied!</span>
      ) : (
        <span>{displayText ?? text}</span>
      )}
    </button>
  );
}

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

function sessionDescription(session: DownstreamSessionItem): string {
  return session.taskDescription ?? session.project ?? session.streamName ?? "no stream";
}

export function DownstreamSessionsPanel({
  streamSessionId,
}: {
  streamSessionId: string | undefined;
}) {
  const { data, isPending, isError } = useQuery(
    streamsDownstreamSessionsQueryOptions(streamSessionId ?? ""),
  );

  const worktreeQuery = useQuery(streamsWorktreeQueryOptions(streamSessionId ?? ""));
  const worktree = worktreeQuery.data;

  if (!streamSessionId) {
    return (
      <div className="flex flex-col h-full border-l border-border bg-background">
        <p className="px-4 pt-3 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          Active Sessions
        </p>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-muted-foreground">Waiting for session…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full border-l border-border bg-background">
      <div className="flex-1 overflow-y-auto">
        <p className="px-4 pt-3 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          Active Sessions
        </p>
        {isPending && <p className="px-4 py-3 text-xs text-muted-foreground">Loading sessions…</p>}
        {isError && <p className="px-4 py-3 text-xs text-destructive">Failed to load sessions.</p>}
        {data && data.length === 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">No active sessions</p>
        )}
        {data && data.length > 0 && (
          <ul className="divide-y divide-border">
            {data.map((session) => (
              <li key={session.sessionId} className="flex flex-col gap-1 px-4 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={cn("shrink-0 h-2 w-2 rounded-full", statusDotColor(session.status))}
                    title={statusLabel(session.status)}
                  />
                  <span className="truncate font-mono text-xs text-foreground">
                    {session.sessionId.slice(0, 8)}
                  </span>
                </div>

                {session.tmuxSession && (
                  <span className="pl-2 text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                    tmux: <CopyableCode text={`tmux attach -t ${session.tmuxSession}`} />
                  </span>
                )}

                <span className="pl-2 text-xs text-muted-foreground truncate">
                  cwd: {sessionDescription(session)}
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
              <span className="pl-2 truncate text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                Branch: <CopyableCode text={worktree.name ?? ""} />
              </span>
              <span className="pl-2 text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                Worktree:{" "}
                <CopyableCode
                  text={worktree.worktreePath ?? ""}
                  displayText={(() => {
                    const parts = (worktree.worktreePath ?? "").split("/");
                    const leaf = parts[parts.length - 1] ?? "";
                    return `../${leaf}`;
                  })()}
                />
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
