import { getRouteApi, Outlet } from "@tanstack/react-router";
import { useCallback, useState, useSyncExternalStore } from "react";
import type { ConnectionState } from "~/lib/types";
import { SettingsDrawer } from "./SettingsDrawer";
import { Sidebar } from "./Sidebar";

const SERVER_SNAPSHOT: ConnectionState = "disconnected";

const rootApi = getRouteApi("__root__");

export function AppShell() {
  const { wsClient } = rootApi.useRouteContext();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const subscribe = useCallback(
    (onStoreChange: () => void) => wsClient.subscribeConnection(onStoreChange),
    [wsClient],
  );
  const getSnapshot = useCallback(() => wsClient.connectionState, [wsClient]);
  const connectionState = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);

  return (
    <div className="grid grid-cols-[240px_1fr] h-screen overflow-hidden">
      <Sidebar connectionState={connectionState} onOpenSettings={() => setSettingsOpen(true)} />

      <main className="flex flex-col min-h-0 overflow-hidden">
        <Outlet />
      </main>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
