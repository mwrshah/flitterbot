import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { DefaultCatchBoundary } from "./components/default-catch-boundary";
import { NotFound } from "./components/not-found";
import { createAutonomaApiClient } from "./lib/api";
import { createSettingsStore } from "./lib/settings-store";
import type { StatusResponse } from "./lib/types";
import { AutonomaWsClient } from "./lib/ws";
import { createSendMessage, setupWsQueryBridge } from "./lib/ws-query-bridge";
import { setupWsRouteSubscriptions } from "./lib/ws-route-subscriptions";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const queryClient = new QueryClient();

  const settingsStore = createSettingsStore((_settings) => {
    // Reconnect WS when settings change
    wsClient.reconnect();
  });

  const apiClient = createAutonomaApiClient(() => settingsStore.get());
  const wsClient = new AutonomaWsClient(() => settingsStore.get());
  const sendMessage = createSendMessage({ wsClient, apiClient, queryClient });

  const router = createRouter({
    routeTree,
    context: { queryClient, apiClient, wsClient, settingsStore, sendMessage },
    defaultPreload: "intent",
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: () => <NotFound />,
    scrollRestoration: true,
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
  });

  // ── Client-side WS bootstrap (runs once at router creation) ──
  if (typeof window !== "undefined") {
    wsClient.connect();

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

    setupWsRouteSubscriptions(router, wsClient, queryClient);
  }

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
