import { getRouteApi, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ConnectionState } from "~/lib/types";
import { SettingsDrawer } from "./SettingsDrawer";
import { Sidebar } from "./Sidebar";

const rootApi = getRouteApi("__root__");

export function AppShell() {
  const { wsClient } = rootApi.useRouteContext();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");

  useEffect(() => {
    setConnectionState(wsClient.connectionState);
    return wsClient.subscribeConnection(setConnectionState);
  }, [wsClient]);

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
