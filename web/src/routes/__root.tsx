/// <reference types="vite/client" />

import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import type * as React from "react";
import { useEffect } from "react";
import { DefaultCatchBoundary } from "~/components/DefaultCatchBoundary";
import { AppShell } from "~/components/layout/AppShell";
import { NotFound } from "~/components/NotFound";
import type { AutonomaApiClient } from "~/lib/api";
import { statusQueryOptions } from "~/lib/queries";
import type { SettingsStore } from "~/lib/settings-store";
import type { WsMessage } from "~/lib/types";
import type { AutonomaWsClient } from "~/lib/ws";
import piWebUiCss from "~/pi-web-ui.css?url";
import appCss from "~/styles.css?url";
import { seo } from "~/utils/seo";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  apiClient: AutonomaApiClient;
  wsClient: AutonomaWsClient;
  settingsStore: SettingsStore;
}>()({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient));
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      ...seo({
        title: "Autonoma",
        description: "Orchestration layer for Claude Code.",
      }),
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "stylesheet", href: piWebUiCss },
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: "/apple-touch-icon.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: "/favicon-32x32.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "16x16",
        href: "/favicon-16x16.png",
      },
      { rel: "manifest", href: "/site.webmanifest" },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  errorComponent: (props) => (
    <RootDocument>
      <DefaultCatchBoundary {...props} />
    </RootDocument>
  ),
  notFoundComponent: () => <NotFound />,
  component: RootComponent,
});

function RootComponent() {
  const { wsClient } = Route.useRouteContext();
  const queryClient = useQueryClient();

  // Invalidate status query when workstreams change via WebSocket — single listener for all consumers
  useEffect(() => {
    return wsClient.subscribe((message: WsMessage) => {
      if (message.type === "workstreams_changed") {
        queryClient.invalidateQueries({ queryKey: ["status"] });
      }
    });
  }, [wsClient, queryClient]);

  return (
    <RootDocument>
      <AppShell />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script for theme flash prevention
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=localStorage.getItem("autonoma-theme")||"system";var d=t==="system"?window.matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light":t;if(d==="dark")document.documentElement.classList.add("dark");document.documentElement.style.colorScheme=d})()`,
          }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
