import type { QueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  type ErrorComponentProps,
  HeadContent,
  Outlet,
  redirect,
  Scripts,
} from "@tanstack/react-router";
import { getAuth } from "@workos/authkit-tanstack-react-start";
import type * as React from "react";
import { useEffect, useMemo } from "react";
import { Toaster, toast } from "sonner";
import type { AuthUser } from "@/auth/types";
import { AppShell } from "@/components/app-shell";
import { DefaultCatchBoundary } from "@/components/default-catch-boundary";
import { NotFound } from "@/components/not-found";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";
import { useTheme } from "@/hooks/use-theme";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import type { FlitterbotApiClient } from "@/lib/api";
import { skillsQueryOptions, statusQueryOptions, userConfigQueryOptions } from "@/lib/queries";
import type { SettingsStore } from "@/lib/settings-store";
import { ShortcutsProvider } from "@/lib/shortcuts";
import { getStreamShortcutTargets } from "@/lib/stream-route-targets";
import type { StatusResponse } from "@/lib/types";
import type { FlitterbotWsClient } from "@/lib/ws";
import type { WsConnectionStore } from "@/lib/ws-connection-store";
import appCss from "@/styles.css?url";
import { seo } from "@/utils/seo";

const publicPaths = new Set(["/api/auth/callback", "/api/auth/sign-in", "/sign-in-error"]);

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  apiClient: FlitterbotApiClient;
  wsClient: FlitterbotWsClient;
  wsConnectionStore: WsConnectionStore;
  settingsStore: SettingsStore;
  sendMessage: FlitterbotWsClient["sendMessage"];
  startRealtime: () => () => void;
}>()({
  beforeLoad: async ({ location }) => {
    if (publicPaths.has(location.pathname)) return { user: null as AuthUser | null };
    const { user } = await getAuth();
    if (!user) {
      throw redirect({
        href: `/api/auth/sign-in?returnPathname=${encodeURIComponent(location.href)}`,
      });
    }
    return {
      user: {
        email: user.email,
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
      } satisfies AuthUser,
    };
  },
  loader: async ({ context }) => {
    if (!context.user) return;
    await Promise.all([
      context.queryClient
        .ensureQueryData(statusQueryOptions(context.apiClient))
        .catch(() => undefined),
      context.queryClient.ensureQueryData(userConfigQueryOptions()).catch(() => ({})),
      context.queryClient.ensureQueryData(skillsQueryOptions(context.apiClient)).catch(() => []),
    ]);
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      ...seo({
        title: "Flitterbot",
        description: "Orchestration layer for Claude Code.",
      }),
    ],
    links: [
      { rel: "stylesheet", href: appCss },
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
  errorComponent: (props: ErrorComponentProps) => (
    <RootDocument>
      <DefaultCatchBoundary {...props} />
    </RootDocument>
  ),
  notFoundComponent: () => <NotFound />,
  component: RootComponent,
});

function useShortcutStatus(apiClient: FlitterbotApiClient, enabled: boolean) {
  const { data, error } = useQuery({
    ...statusQueryOptions(apiClient),
    enabled,
    retry: 1,
    select: (d) => ({
      piAgent: d.piAgent,
      streams: d.streams,
      shortcuts: d.shortcuts,
    }),
  });

  useEffect(() => {
    if (error) toast.error(`Status unavailable: ${error.message}`, { id: "status-error" });
    else toast.dismiss("status-error");
  }, [error]);

  return data;
}

function RootShortcuts({ streamPaths }: { streamPaths: string[] }) {
  useGlobalShortcuts({ streamPaths });
  return null;
}

function useStreamPaths(status: Pick<StatusResponse, "piAgent" | "streams"> | undefined): string[] {
  return useMemo(
    () =>
      getStreamShortcutTargets(status?.piAgent?.default?.piSessionId, status?.streams).map(
        ({ path }) => path,
      ),
    [status?.piAgent?.default?.piSessionId, status?.streams],
  );
}

function RootComponent() {
  const { user } = Route.useRouteContext();
  useWhyDidYouRender("RootComponent", { user });
  return user ? (
    <AuthenticatedRoot user={user} />
  ) : (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function AuthenticatedRoot({ user }: { user: AuthUser }) {
  const { startRealtime, apiClient } = Route.useRouteContext();
  const { resolvedTheme } = useTheme();
  const shortcutStatus = useShortcutStatus(apiClient, true);
  const streamPaths = useStreamPaths(shortcutStatus);
  const shell = useMemo(() => <AppShell user={user} />, [user]);

  useEffect(() => startRealtime(), [startRealtime]);

  useEffect(() => {
    if (import.meta.env.DEV) void import("react-grab");
  }, []);

  return (
    <RootDocument resolvedTheme={resolvedTheme}>
      <ShortcutsProvider overrides={shortcutStatus?.shortcuts}>
        <RootShortcuts streamPaths={streamPaths} />
        {shell}
      </ShortcutsProvider>
    </RootDocument>
  );
}

function RootDocument({
  children,
  resolvedTheme = "light",
}: {
  children: React.ReactNode;
  resolvedTheme?: "light" | "dark";
}) {
  useWhyDidYouRender("RootDocument", { children });
  return (
    <html
      lang="en"
      className={resolvedTheme === "dark" ? "dark" : ""}
      style={{ colorScheme: resolvedTheme }}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
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
        <Scripts />
      </body>
    </html>
  );
}
