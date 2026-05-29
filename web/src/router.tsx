import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { DefaultCatchBoundary } from "./components/default-catch-boundary";
import { NotFound } from "./components/not-found";
import { createFlitterbotApiClient } from "./lib/api";
import { createSettingsStore } from "./lib/settings-store";
import { FlitterbotWsClient } from "./lib/ws";
import { createWsConnectionStore } from "./lib/ws-connection-store";
import { createSendMessage, setupWsQueryBridge } from "./lib/ws-query-bridge";
import { setupWsRouteSubscriptions } from "./lib/ws-route-subscriptions";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const queryClient = new QueryClient();
  let startRealtime = () => () => {};

  const settingsStore = createSettingsStore((_settings) => {
    wsClient.reconnect();
    queryClient.invalidateQueries({ queryKey: ["user-config"] });
  });

  const apiClient = createFlitterbotApiClient(() => settingsStore.get());
  const wsClient = new FlitterbotWsClient(() => settingsStore.get());
  const wsConnectionStore = createWsConnectionStore(wsClient);
  const sendMessage = createSendMessage({ wsClient });

  const router = createRouter({
    routeTree,
    context: {
      queryClient,
      apiClient,
      wsClient,
      wsConnectionStore,
      settingsStore,
      sendMessage,
      startRealtime: () => startRealtime(),
    },
    defaultPreload: "intent",
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: () => <NotFound />,
    scrollRestoration: true,
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
  });

  let stopRealtime = () => {};

  startRealtime = () => {
    if (typeof window === "undefined") return () => {};

    stopRealtime();

    const stopWsQueryBridge = setupWsQueryBridge({
      queryClient,
      wsClient,
      router,
    });

    const stopWsRouteSubscriptions = setupWsRouteSubscriptions(router, wsClient);
    const stopWsConnectionStore = wsConnectionStore.start();

    stopRealtime = () => {
      stopWsRouteSubscriptions();
      stopWsQueryBridge();
      stopWsConnectionStore();
    };

    return stopRealtime;
  };

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
