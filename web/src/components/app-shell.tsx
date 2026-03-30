import { Outlet } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { SettingsDrawer } from "./settings-drawer";
import { Sidebar } from "./sidebar";

export function AppShell() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  useWhyDidYouRender("AppShell", { settingsOpen });

  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleCloseSettings = useCallback(() => setSettingsOpen(false), []);

  return (
    <div className="grid grid-cols-[240px_1fr] grid-rows-1 h-screen overflow-hidden">
      <Sidebar onOpenSettings={handleOpenSettings} />

      <main className="flex flex-col min-h-0 overflow-hidden">
        <Outlet />
      </main>

      <SettingsDrawer open={settingsOpen} onClose={handleCloseSettings} />
    </div>
  );
}
