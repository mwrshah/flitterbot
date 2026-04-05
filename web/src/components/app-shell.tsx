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
  const { activeTab, setActiveTab } = useMobileTab();
  useWhyDidYouRender("AppShell", {});

  // Single DOM — Tailwind responsive classes handle mobile vs desktop layout.
  // Mobile: flex column with tab-switched panels + bottom bar.
  // Desktop (md:): 2-column grid, sidebar always visible, no bottom bar.
  return (
    <div className="flex flex-col h-screen overflow-hidden md:grid md:grid-cols-[240px_1fr] md:grid-rows-1">
      {/* Sidebar: always visible on desktop (md:block), tab-controlled on mobile */}
      <div
        className={cn(
          "min-h-0",
          activeTab === "sidebar" ? "flex-1" : "hidden md:block",
        )}
        onClick={(e) => {
          // Auto-switch to surface tab when a nav link is clicked on mobile
          if ((e.target as HTMLElement).closest("a")) {
            setActiveTab("surface");
          }
        }}
      >
        <Sidebar />
      </div>

      {/* Info panel: mobile only (md:hidden), shown when info tab active */}
      <div
        className={cn(
          "min-h-0 md:hidden",
          activeTab === "info" ? "flex-1" : "hidden",
        )}
      >
        <MobileInfoPanel />
      </div>

      {/* Main content: always visible on desktop (md:flex), tab-controlled on mobile */}
      <main
        className={cn(
          "flex flex-col min-h-0 overflow-hidden",
          activeTab === "surface" || activeTab === "stream" ? "flex-1" : "hidden md:flex",
        )}
      >
        <Outlet />
      </main>

      {/* Bottom tab bar: mobile only */}
      <div className="shrink-0 md:hidden">
        <BottomTabBar />
      </div>
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
