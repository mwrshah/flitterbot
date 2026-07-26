import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "~/components/common/badge";
import { Button } from "~/components/common/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/common/card";
import { WhatsAppControls } from "~/components/whatsapp-controls";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { statusQueryOptions } from "~/lib/queries";
import { formatDuration } from "~/lib/utils";

export const Route = createFileRoute("/runtime")({
  head: () => ({
    meta: [{ title: "Flitterbot" }],
  }),
  component: RuntimePage,
});

function MetaItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  useWhyDidYouRender("MetaItem", { label, value, mono });

  return (
    <div>
      <p className="mb-0.5 text-[10px] text-text-muted uppercase tracking-wider">{label}</p>
      <p className={`text-sm text-text ${mono ? "font-mono text-xs" : ""}`}>{value || "—"}</p>
    </div>
  );
}

function RuntimePage() {
  const { apiClient } = Route.useRouteContext();

  const statusQuery = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
  });

  const status = statusQuery.data;

  useWhyDidYouRender("RuntimePage", { apiClient, statusQuery, status });

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold text-text">Runtime</h1>
        <Button variant="subtle" size="sm" onClick={() => statusQuery.refetch()}>
          Refresh
        </Button>
      </div>

      {statusQuery.isPending && <p className="text-sm text-text-muted">Loading status…</p>}

      {status && (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Streams Agent</CardTitle>
                <Badge variant={status.piAgent?.default?.busy ? "active" : "info"}>
                  {status.piAgent?.default?.busy ? "active" : "idle"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <MetaItem
                  label="Session ID"
                  value={status.piAgent?.default?.piSessionId ?? ""}
                  mono
                />
                <MetaItem
                  label="Messages"
                  value={String(status.piAgent?.default?.messageCount ?? 0)}
                />
              </div>
            </CardContent>
          </Card>

          {(status.piAgent?.orchestrators?.length ?? 0) > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Streams Orchestrators</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {status.piAgent!.orchestrators!.map((o) => (
                    <div
                      key={o.piSessionId}
                      className="flex items-center justify-between rounded-lg border border-border px-4 py-3"
                    >
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-text">
                          {o.streamName ?? o.streamId}
                        </p>
                        <p className="font-mono text-xs text-text-muted">
                          {o.piSessionId.slice(0, 12)}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <MetaItem label="Messages" value={String(o.messageCount)} />
                        <Badge variant={o.busy ? "active" : "info"}>
                          {o.busy ? "active" : "idle"}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Control Surface</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <MetaItem label="PID" value={status.pid != null ? String(status.pid) : ""} />
                <MetaItem label="Uptime" value={formatDuration(status.uptime)} />
                <MetaItem label="Blackboard" value={status.blackboard} />
              </div>
            </CardContent>
          </Card>

          <WhatsAppControls status={status} />
        </>
      )}
    </div>
  );
}
