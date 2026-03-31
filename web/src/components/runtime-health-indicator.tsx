import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { memo } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { statusQueryOptions } from "~/lib/queries";
import { useWsConnectionState } from "~/lib/ws-connection-store";

function statusDotColor(status: string): string {
  switch (status) {
    case "connected":
      return "bg-emerald-500";
    case "connecting":
    case "reconnecting":
      return "bg-amber-500";
    case "stopped":
    case "disabled":
    case "disconnected":
      return "bg-zinc-400";
    default:
      return "bg-amber-500";
  }
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

const rootApi = getRouteApi("__root__");

export const RuntimeHealthIndicator = memo(function RuntimeHealthIndicator() {
  const { apiClient, wsConnectionStore } = rootApi.useRouteContext();
  const navigate = useNavigate();

  const { data: status } = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
  });

  const connectionState = useWsConnectionState(wsConnectionStore);

  const waStatus = status?.whatsapp.status ?? "unknown";

  useWhyDidYouRender("RuntimeHealthIndicator", { waStatus, connectionState });

  return (
    <button
      type="button"
      onClick={() => navigate({ to: "/runtime" })}
      className="flex items-center gap-3 px-2 py-1 rounded-md hover:bg-muted/50 transition-colors cursor-pointer"
    >
      <div className="flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${statusDotColor(waStatus)}`}
          title={statusLabel(waStatus)}
        />
        <span className="text-[10px] text-muted-foreground/50">WhatsApp</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${statusDotColor(connectionState)}`}
          title={statusLabel(connectionState)}
        />
        <span className="text-[10px] text-muted-foreground/50">WebSocket</span>
      </div>
    </button>
  );
});
