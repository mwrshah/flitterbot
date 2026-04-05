import { Outlet } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { useState } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { cn } from "~/lib/utils";
import { BottomTabBar } from "./bottom-tab-bar";
import { MobileTabProvider, useMobileTab } from "./mobile-tab-provider";
import { RuntimeHealthIndicator } from "./runtime-health-indicator";
import { SettingsDrawer } from "./settings-drawer";
import { Sidebar } from "./sidebar";

function MobileInfoPanel() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="px-6 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">Info</h2>
      </div>
      <div className="flex-1 px-6 py-4 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Runtime</span>
          <RuntimeHealthIndicator />
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <SettingsIcon className="w-4 h-4" />
          Settings
        </button>
      </div>
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function AppShellInner() {
  const { isMobile, activeTab, setActiveTab } = useMobileTab();
  useWhyDidYouRender("AppShell", {});

  if (isMobile) {
    return (
      <div className="flex flex-col h-screen overflow-hidden">
        <div className="flex-1 min-h-0 overflow-hidden">
          {/* Sidebar — kept mounted via hidden to preserve scroll state */}
          <div
            className={cn("h-full", activeTab !== "sidebar" && "hidden")}
            onClick={(e) => {
              // Auto-switch to surface tab when a nav link is clicked
              if ((e.target as HTMLElement).closest("a")) {
                setActiveTab("surface");
              }
            }}
          >
            <Sidebar />
          </div>

          {/* Info panel */}
          <div className={cn("h-full", activeTab !== "info" && "hidden")}>
            <MobileInfoPanel />
          </div>

          {/* Main content — surface & stream tabs both render the Outlet;
              the route component decides which panel to show based on activeTab */}
          <main
            className={cn(
              "flex flex-col h-full overflow-hidden",
              activeTab !== "surface" && activeTab !== "stream" && "hidden",
            )}
          >
            <Outlet />
          </main>
        </div>
        <BottomTabBar />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[240px_1fr] grid-rows-1 h-screen overflow-hidden">
      <Sidebar />
      <main className="flex flex-col min-h-0 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

export function AppShell() {
  return (
    <MobileTabProvider>
      <AppShellInner />
    </MobileTabProvider>
  );
}
