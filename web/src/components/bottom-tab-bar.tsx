import { useRouterState } from "@tanstack/react-router";
import { Activity, Info, Menu, Terminal } from "lucide-react";
import { type MobileTab, useMobileTab } from "~/components/mobile-tab-provider";
import { cn } from "~/lib/utils";

const tabs: { id: MobileTab; label: string; icon: React.ReactNode }[] = [
  { id: "sidebar", label: "Nav", icon: <Menu className="w-5 h-5" /> },
  { id: "surface", label: "Surface", icon: <Activity className="w-5 h-5" /> },
  { id: "stream", label: "Stream", icon: <Terminal className="w-5 h-5" /> },
  { id: "info", label: "Info", icon: <Info className="w-5 h-5" /> },
];

export function BottomTabBar() {
  const { activeTab, setActiveTab } = useMobileTab();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOnStreamsRoute = pathname.startsWith("/streams");

  return (
    <nav
      className="flex items-center justify-around border-t border-border bg-background shrink-0"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      {tabs.map((tab) => {
        const disabled = tab.id === "stream" && !isOnStreamsRoute;
        const active = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            type="button"
            disabled={disabled}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex flex-col items-center gap-0.5 flex-1 py-2 text-[10px] transition-colors",
              active ? "text-foreground" : "text-muted-foreground/60",
              disabled && "opacity-30 pointer-events-none",
            )}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
