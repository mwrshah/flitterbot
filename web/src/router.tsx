import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { DefaultCatchBoundary } from "./components/default-catch-boundary";
import { NotFound } from "./components/not-found";
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
    // Disconnect any previous wsClient orphaned by HMR
    const prev = (window as any).__autonoma_wsClient as AutonomaWsClient | undefined;
    if (prev) prev.disconnect();
    (window as any).__autonoma_wsClient = wsClient;

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
