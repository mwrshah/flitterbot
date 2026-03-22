import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { StatusResponse } from "~/lib/types";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/Card";

function statusVariant(
  status: string,
): "success" | "warning" | "muted" {
  switch (status) {
    case "connected":
      return "success";
    case "starting":
    case "reconnecting":
      return "warning";
    default:
      return "muted";
  }
}

export function WhatsAppControls({
  status,
}: {
  status?: StatusResponse;
}) {
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const queryClient = useQueryClient();

  const startMutation = useMutation({
    mutationFn: () => apiClient.startWhatsApp(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });

  const stopMutation = useMutation({
    mutationFn: () => apiClient.stopWhatsApp(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });

  const waStatus = status?.whatsapp.status ?? "unknown";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>WhatsApp</CardTitle>
          <Badge variant={statusVariant(waStatus)}>{waStatus}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-0.5">
                Daemon PID
              </p>
              <p className="text-sm font-mono">
                {status?.whatsapp.pid ?? "—"}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-0.5">
                Managed by
              </p>
              <p className="text-sm">
                {status?.whatsapp.managedByControlSurface
                  ? "control surface"
                  : "unknown"}
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={
                startMutation.isPending ||
                waStatus === "connected" ||
                waStatus === "starting"
              }
              onClick={() => startMutation.mutate()}
            >
              {startMutation.isPending ? "Starting..." : "Start"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={stopMutation.isPending || waStatus === "stopped"}
              onClick={() => stopMutation.mutate()}
            >
              {stopMutation.isPending ? "Stopping..." : "Stop"}
            </Button>
          </div>

          {startMutation.error && (
            <p className="text-xs text-destructive">
              Failed to start daemon.
            </p>
          )}
          {stopMutation.error && (
            <p className="text-xs text-destructive">
              Failed to stop daemon.
            </p>
          )}

          <p className="text-[10px] text-muted-foreground/50">
            Auth stays terminal-driven in v1. Browser only controls start/stop.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
