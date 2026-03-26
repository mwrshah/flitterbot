import { useQuery } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { connectionStateQueryOptions } from "~/lib/queries";
import type { ConnectionState } from "~/lib/types";
import { SettingsDrawer } from "./settings-drawer";
import { Sidebar } from "./sidebar";

const emptySubscribe = () => () => {};
const useIsClient = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

export function AppShell() {
  const isClient = useIsClient();
  const { data: connectionState = "disconnected" as ConnectionState } = useQuery(
    connectionStateQueryOptions(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  useWhyDidYouRender("AppShell", { settingsOpen });

  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleCloseSettings = useCallback(() => setSettingsOpen(false), []);

  return (
    <div className="grid grid-cols-[240px_1fr] h-screen overflow-hidden">
      <Sidebar connectionState={isClient ? connectionState : "disconnected"} onOpenSettings={handleOpenSettings} />

      <main className="flex flex-col min-h-0 overflow-hidden">
        <Outlet />
      </main>

      <SettingsDrawer open={settingsOpen} onClose={handleCloseSettings} />
    </div>
  );
}
