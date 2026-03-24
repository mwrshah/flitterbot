import { Link } from "@tanstack/react-router";
import type { SessionSummary } from "~/lib/types";
import { cn, formatRelativeTime } from "~/lib/utils";

function statusDotColor(status: SessionSummary["status"]): string {
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

export function SessionList({
  items,
  selectedSessionId,
  title = "Claude sessions",
  description,
}: {
  items: SessionSummary[];
  selectedSessionId?: string;
  title?: string;
  description?: string;
}) {
  // Group by workstream
  const grouped = new Map<string, { sessions: SessionSummary[] }>();
  const unlinked: SessionSummary[] = [];

  for (const session of items) {
    if (session.workstreamName && session.workstreamId) {
      const key = session.workstreamName;
      if (!grouped.has(key)) grouped.set(key, { sessions: [] });
      grouped.get(key)!.sessions.push(session);
    } else {
      unlinked.push(session);
    }
  }

  return (
    <div className="space-y-4">
      {title && (
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
      )}

      {items.length === 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">No sessions found.</p>
      )}

      {/* Workstream groups */}
      {[...grouped.entries()].map(([wsName, { sessions }]) => (
        <SessionGroup
          key={wsName}
          label={wsName}
          sessions={sessions}
          selectedSessionId={selectedSessionId}
        />
      ))}

      {/* Unlinked sessions */}
      {unlinked.length > 0 && grouped.size > 0 && (
        <SessionGroup label="Unlinked" sessions={unlinked} selectedSessionId={selectedSessionId} />
      )}

      {/* If no workstream grouping exists, show flat list */}
      {grouped.size === 0 && unlinked.length > 0 && (
        <div className="space-y-1">
          {unlinked.map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              selected={session.sessionId === selectedSessionId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionGroup({
  label,
  sessions,
  selectedSessionId,
}: {
  label: string;
  sessions: SessionSummary[];
  selectedSessionId?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          {label}
        </p>
        <span className="text-[10px] text-muted-foreground/60 tabular-nums">{sessions.length}</span>
      </div>
      <div className="space-y-1">
        {sessions.map((session) => (
          <SessionRow
            key={session.sessionId}
            session={session}
            selected={session.sessionId === selectedSessionId}
          />
        ))}
      </div>
    </div>
  );
}

function SessionRow({ session, selected }: { session: SessionSummary; selected: boolean }) {
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: session.sessionId }}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 border transition-colors",
        selected
          ? "border-accent/40 bg-accent/5"
          : "border-transparent hover:bg-card hover:border-border",
      )}
    >
      {/* Status dot */}
      <span className={cn("w-2 h-2 rounded-full shrink-0", statusDotColor(session.status))} />

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">
            {session.taskDescription || session.sessionId}
          </span>
          <span className="text-[10px] text-muted-foreground/60 shrink-0">{session.status}</span>
        </div>
        {session.project && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{session.project}</p>
        )}
      </div>

      {/* Meta */}
      <div className="text-right shrink-0">
        {session.tmuxSession && (
          <p className="text-[10px] font-mono text-muted-foreground/60">{session.tmuxSession}</p>
        )}
        <p className="text-[10px] text-muted-foreground/50">
          {formatRelativeTime(session.lastEventAt)}
        </p>
      </div>
    </Link>
  );
}
