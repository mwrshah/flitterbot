import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { DefaultCatchBoundary } from "./components/DefaultCatchBoundary";
import { NotFound } from "./components/NotFound";
import { createAutonomaApiClient } from "./lib/api";
import { createSettingsStore } from "./lib/settings-store";
import { AutonomaWsClient } from "./lib/ws";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const queryClient = new QueryClient();

  const settingsStore = createSettingsStore((_settings) => {
    // Reconnect WS when settings change
    wsClient.reconnect();
  });

  const apiClient = createAutonomaApiClient(() => settingsStore.get());
  const wsClient = new AutonomaWsClient(() => settingsStore.get());

  // Connect WS eagerly — ready before any component renders
  if (typeof window !== "undefined") {
    wsClient.connect();
    window.addEventListener("beforeunload", () => {
      wsClient.disconnect();
    });
  }

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

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
