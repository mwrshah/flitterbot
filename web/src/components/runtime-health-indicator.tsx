import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { memo } from "react";
import { useConnectionState } from "~/hooks/use-connection-state";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { statusQueryOptions } from "~/lib/queries";

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
  const { apiClient, wsClient } = rootApi.useRouteContext();
  const navigate = useNavigate();

  // useSuspenseQuery executes during SSR and streams resolved data to the client,
  // unlike useQuery which skips server execution entirely. Status is seeded by the
  // root route loader via ensureQueryData.
  // See: features/tanstack-patterns/references/query.md (lines 75-78)
  const { data: status } = useSuspenseQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
  });

  // useSyncExternalStore subscribes directly to the WS client's state machine.
  // getServerSnapshot returns "disconnected" to match SSR, eliminating the
  // hydration mismatch that the old mounted/useEffect workaround papered over.
  // See: features/tanstack-patterns/references/query.md (lines 69-71)
  // See: features/tanstack-patterns/references/ssr.md (lines 63-65)
  const connectionState = useConnectionState(wsClient);

  const waStatus = status.whatsapp.status;

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
