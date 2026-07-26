import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { memo } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { statusQueryOptions } from "~/lib/queries";
import { useWsConnectionState } from "~/lib/ws-connection-store";

function statusDotColor(status: string): string {
  switch (status) {
    case "connected":
      return "bg-status-active";
    case "connecting":
    case "reconnecting":
      return "bg-status-waiting";
    case "stopped":
    case "disabled":
    case "disconnected":
      return "bg-status-ended";
    default:
      return "bg-status-info";
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
  const waStatusLabel = statusLabel(waStatus);
  const connectionStatusLabel = statusLabel(connectionState);

  useWhyDidYouRender("RuntimeHealthIndicator", { waStatus, connectionState });

  return (
    <button
      type="button"
      onClick={() => navigate({ to: "/runtime" })}
      className="flex items-center gap-3 px-2 py-1 rounded-md hover:bg-background-hover transition-colors cursor-pointer"
    >
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${statusDotColor(waStatus)}`} aria-hidden />
        <span className="text-[10px] text-text-muted">WhatsApp: {waStatusLabel}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${statusDotColor(connectionState)}`}
          aria-hidden
        />
        <span className="text-[10px] text-text-muted">WebSocket: {connectionStatusLabel}</span>
      </div>
    </button>
  );
});
