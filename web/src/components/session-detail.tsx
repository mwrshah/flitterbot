import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { SessionDetail as SessionDetailType, TmuxSessionInspection } from "~/lib/types";
import { cn, formatDateTime, safeJsonParse } from "~/lib/utils";

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

function MetaItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  useWhyDidYouRender("SessionDetail.MetaItem", { label, value, mono });
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-0.5">
        {label}
      </p>
      <p className={cn("text-sm text-foreground truncate", mono && "font-mono text-xs")}>
        {value || "—"}
      </p>
    </div>
  );
}

export function SessionDetail({
  session,
  tmux,
}: {
  session: SessionDetailType;
  tmux?: TmuxSessionInspection | null;
}) {
  useWhyDidYouRender("SessionDetail", { session, tmux });
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (text: string) => apiClient.sendDirectSessionMessage(session.sessionId, text),
    onSuccess: (result) => {
      if (result.ok) {
        void queryClient.invalidateQueries({
          queryKey: ["session", session.sessionId],
        });
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        void queryClient.invalidateQueries({
          queryKey: ["transcript", session.sessionId],
        });
        setResultMessage(`Delivered via ${result.delivery}.`);
        setDraft("");
        return;
      }
      const suffix = result.reason ? ` (${result.reason})` : "";
      setResultMessage(`Not delivered${suffix}.`);
    },
  });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setResultMessage(null);
    await mutation.mutateAsync(text);
  }

  return (
    <div className="space-y-4">
      {/* Session header */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="text-base">
                {session.taskDescription || session.sessionId}
              </CardTitle>
              {session.project && (
                <p className="text-xs text-muted-foreground mt-1">{session.project}</p>
              )}
            </div>
            <Badge variant={statusVariant(session.status)}>{session.status}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <MetaItem label="Tmux" value={session.tmuxSession ?? ""} mono />
            <MetaItem label="Last event" value={formatDateTime(session.lastEventAt)} />
            <MetaItem label="Started" value={formatDateTime(session.startedAt)} />
            <MetaItem label="Transcript" value={session.transcriptPath ?? ""} mono />
            <MetaItem label="CWD" value={session.cwd ?? ""} mono />
            <MetaItem label="Model" value={session.model ?? ""} />
          </div>
        </CardContent>
      </Card>

      {/* Tmux inspection */}
      {tmux && (
        <Card>
          <CardHeader>
            <CardTitle>Tmux inspection</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <MetaItem label="Exists" value={tmux.exists ? "yes" : "no"} />
              <MetaItem label="Attached" value={tmux.attached ? "yes" : "no"} />
              <MetaItem label="Pane state" value={tmux.pane?.uiState ?? ""} />
              <MetaItem label="Command" value={tmux.pane?.currentCommand ?? ""} mono />
              <MetaItem label="Target" value={tmux.pane?.target ?? ""} mono />
              <MetaItem
                label="Pane PID"
                value={tmux.pane?.panePid != null ? String(tmux.pane.panePid) : ""}
              />
            </div>
            {tmux.pane?.capture && (
              <pre className="mt-3 rounded-lg bg-background border border-border p-3 text-xs font-mono overflow-auto max-h-48">
                {tmux.pane.capture}
              </pre>
            )}
          </CardContent>
        </Card>
      )}

      {/* Direct message */}
      <Card>
        <CardHeader>
          <CardTitle>Direct message</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              placeholder="Send a message to this session..."
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] text-muted-foreground/50">
                Idle sessions can inject. Busy or stale sessions fail closed.
              </p>
              <Button type="submit" size="sm" disabled={mutation.isPending || !draft.trim()}>
                {mutation.isPending ? "Sending..." : "Send"}
              </Button>
            </div>
            {resultMessage && (
              <p className="text-xs text-muted-foreground rounded-md bg-accent/10 px-3 py-2">
                {resultMessage}
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      {/* Recent events */}
      <Card>
        <CardHeader>
          <CardTitle>Recent events</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {session.recentEvents.length === 0 && (
              <p className="text-sm text-muted-foreground">No recent events.</p>
            )}
            {session.recentEvents.map((event) => {
              const parsed = safeJsonParse<Record<string, unknown>>(event.payload);
              return (
                <div key={event.id} className="rounded-lg border border-border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{event.event_name}</span>
                      {event.tool_name && <Badge variant="muted">{event.tool_name}</Badge>}
                    </div>
                    <span className="text-[10px] text-muted-foreground/60">
                      {formatDateTime(event.timestamp)}
                    </span>
                  </div>
                  {parsed ? (
                    <pre className="rounded-md bg-background border border-border p-2 text-xs font-mono overflow-auto max-h-32">
                      {JSON.stringify(parsed, null, 2)}
                    </pre>
                  ) : event.payload ? (
                    <pre className="rounded-md bg-background border border-border p-2 text-xs font-mono overflow-auto max-h-32">
                      {event.payload}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
