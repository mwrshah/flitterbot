import type { QueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  type ErrorComponentProps,
  HeadContent,
} from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { Toaster } from "sonner";
import { AppShell } from "@/components/app-shell";
import { DefaultCatchBoundary } from "@/components/default-catch-boundary";
import { NotFound } from "@/components/not-found";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";
import { useTheme } from "@/hooks/use-theme";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import type { FlitterbotApiClient } from "@/lib/api";
import { skillsQueryOptions, statusQueryOptions, userConfigQueryOptions } from "@/lib/queries";
import type { SettingsStore } from "@/lib/settings-store";
import type { StatusQueryData } from "@/lib/types";
import type { FlitterbotWsClient } from "@/lib/ws";
import type { WsConnectionStore } from "@/lib/ws-connection-store";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  apiClient: FlitterbotApiClient;
  wsClient: FlitterbotWsClient;
  wsConnectionStore: WsConnectionStore;
  settingsStore: SettingsStore;
  sendMessage: FlitterbotWsClient["sendMessage"];
  startRealtime: () => () => void;
}>()({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient)),
      context.queryClient
        .ensureQueryData(userConfigQueryOptions(context.apiClient))
        .catch(() => ({})),
      context.queryClient.ensureQueryData(skillsQueryOptions(context.apiClient)).catch(() => []),
    ]);
  },
  errorComponent: (props: ErrorComponentProps) => <DefaultCatchBoundary {...props} />,
  notFoundComponent: () => <NotFound />,
  component: RootComponent,
});

function useShortcutStatus(apiClient: FlitterbotApiClient) {
  const { data } = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
    select: (d) => ({
      piAgent: d.piAgent,
      streams: d.streams,
      shortcuts: d.shortcuts,
    }),
  });
  return data;
}

function useStreamPaths(
  status: Pick<StatusQueryData, "piAgent" | "streams"> | undefined,
): string[] {
  return useMemo(() => {
    const paths: string[] = [];
    if (status?.piAgent?.default?.piSessionId) {
      paths.push(`/streams/${status.piAgent.default.piSessionId}`);
    }
    for (const stream of status?.streams ?? []) {
      if (stream.status === "open" && stream.piSessionId) {
        paths.push(`/streams/${stream.piSessionId}`);
      }
    }
    return paths;
  }, [status?.piAgent, status?.streams]);
}

function RootComponent() {
  const { startRealtime, apiClient } = Route.useRouteContext();
  useWhyDidYouRender("RootComponent", {});
  const { resolvedTheme } = useTheme();
  const shortcutStatus = useShortcutStatus(apiClient);
  const streamPaths = useStreamPaths(shortcutStatus);
  useGlobalShortcuts({ streamPaths, shortcutBindings: shortcutStatus?.shortcuts });

  useEffect(() => startRealtime(), [startRealtime]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  return (
    <>
      <HeadContent />
      <AppShell />
      <Toaster
        theme={resolvedTheme}
        duration={4000}
        toastOptions={{
          style: {
            background: "var(--background)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          },
        }}
      />
    </>
  );
}
