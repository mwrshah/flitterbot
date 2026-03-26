import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { DefaultCatchBoundary } from "./components/default-catch-boundary";
import { NotFound } from "./components/not-found";
import { createAutonomaApiClient } from "./lib/api";
import { createSettingsStore } from "./lib/settings-store";
import type { StatusResponse } from "./lib/types";
import { AutonomaWsClient } from "./lib/ws";
import { setupWsQueryBridge } from "./lib/ws-query-bridge";
import { routeTree } from "./routeTree.gen";

declare global {
  interface Window {
    __autonoma_wsClient?: AutonomaWsClient;
  }
}

export function getRouter() {
  const queryClient = new QueryClient();

  const settingsStore = createSettingsStore((_settings) => {
    // Reconnect WS when settings change
    wsClient.reconnect();
  });

  const apiClient = createAutonomaApiClient(() => settingsStore.get());
  const wsClient = new AutonomaWsClient(() => settingsStore.get());

  const router = createRouter({
    routeTree,
    context: { queryClient, apiClient, wsClient, settingsStore },
    defaultPreload: "intent",
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: () => <NotFound />,
    scrollRestoration: true,
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
  });

  // Connect WS and wire up the bridge — ready before any component renders
  if (typeof window !== "undefined") {
    // Disconnect any previous wsClient orphaned by HMR
    const prev = window.__autonoma_wsClient;
    if (prev) prev.disconnect();
    window.__autonoma_wsClient = wsClient;

    wsClient.connect();
    window.addEventListener("beforeunload", () => {
      wsClient.disconnect();
    });

    // Wire WS events → Query cache (replaces usePiWsHandler)
    setupWsQueryBridge({
      queryClient,
      wsClient,
      apiClient,
      router,
      getDefaultSessionId: () => {
        const status = queryClient.getQueryData<StatusResponse>(["status"]);
        return status?.pi?.default?.sessionId;
      },
    });
  }

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
