/// <reference types="vite/client" />

import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import type * as React from "react";
import { AppShell } from "~/components/app-shell";
import { DefaultCatchBoundary } from "~/components/default-catch-boundary";
import { NotFound } from "~/components/not-found";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { AutonomaApiClient } from "~/lib/api";
import { statusQueryOptions } from "~/lib/queries";
import type { SettingsStore } from "~/lib/settings-store";
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
  useWhyDidYouRender("RootComponent", {});

  return (
    <RootDocument>
      <AppShell />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  useWhyDidYouRender("RootDocument", { children });
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
