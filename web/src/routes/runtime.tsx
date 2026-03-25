import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "~/components/ui/badge";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { WhatsAppControls } from "~/components/whatsapp-controls";
import { statusQueryOptions } from "~/lib/queries";
import { formatDuration } from "~/lib/utils";

export const Route = createFileRoute("/runtime")({
  head: () => ({
    meta: [{ title: "Autonoma — Runtime" }],
  }),
  component: RuntimePage,
});

function MetaItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  useWhyDidYouRender("MetaItem", { label, value, mono });

  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-0.5">
        {label}
      </p>
      <p className={`text-sm text-foreground ${mono ? "font-mono text-xs" : ""}`}>{value || "—"}</p>
    </div>
  );
}

function RuntimePage() {
  const { apiClient } = Route.useRouteContext();

  const statusQuery = useQuery({
    ...statusQueryOptions(apiClient),
    refetchInterval: (query) => (query.state.error ? 30_000 : 5_000),
    retry: 1,
  });

  const status = statusQuery.data;

  useWhyDidYouRender("RuntimePage", { apiClient, statusQuery, status });

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold text-foreground">Runtime</h1>
        <Button variant="ghost" size="sm" onClick={() => statusQuery.refetch()}>
          Refresh
        </Button>
      </div>

      {statusQuery.isPending && <p className="text-sm text-muted-foreground">Loading status...</p>}

      {status && (
        <>
          {/* Pi Agent */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Pi Agent</CardTitle>
                <Badge variant={status.pi?.default?.busy ? "success" : "default"}>
                  {status.pi?.default?.busy ? "active" : "idle"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <MetaItem label="Session ID" value={status.pi?.default?.sessionId ?? ""} mono />
                <MetaItem label="Messages" value={String(status.pi?.default?.messageCount ?? 0)} />
              </div>
            </CardContent>
          </Card>

          {/* Pi Orchestrators */}
          {(status.pi?.orchestrators?.length ?? 0) > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Pi Orchestrators</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {status.pi!.orchestrators!.map((o) => (
                    <div
                      key={o.sessionId}
                      className="flex items-center justify-between rounded-lg border border-border px-4 py-3"
                    >
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-foreground">
                          {o.workstreamName ?? o.workstreamId}
                        </p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {o.sessionId.slice(0, 12)}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <MetaItem label="Messages" value={String(o.messageCount)} />
                        <Badge variant={o.busy ? "success" : "default"}>
                          {o.busy ? "active" : "idle"}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Control Surface */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Control Surface</CardTitle>
                <Badge variant="muted">{status.source ?? "live"}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <MetaItem label="PID" value={status.pid != null ? String(status.pid) : ""} />
                <MetaItem label="Uptime" value={formatDuration(status.uptime)} />
                <MetaItem label="Blackboard" value={status.blackboard} />
              </div>
            </CardContent>
          </Card>

          {/* WhatsApp */}
          <WhatsAppControls status={status} />
        </>
      )}
    </div>
  );
}
