import { useRouterState } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";

export type MobileTab = "sidebar" | "surface" | "stream" | "info";

// Inline mobile detection for route components that need different component
// trees on mobile (e.g. PanelGroup vs individual panels). AppShell itself
// uses pure Tailwind responsive classes and doesn't need this.
const MD_QUERY = "(max-width: 767px)";

function subscribeMobile(callback: () => void) {
  const mql = window.matchMedia(MD_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getMobileSnapshot() {
  return window.matchMedia(MD_QUERY).matches;
}

function getMobileServerSnapshot() {
  return false;
}

type MobileTabContextValue = {
  activeTab: MobileTab;
  setActiveTab: (tab: MobileTab) => void;
  /** True below md: breakpoint. Used by route components that need different
   *  component trees (PanelGroup vs individual panels). Prefer Tailwind
   *  responsive classes for pure visibility toggling. */
  isMobile: boolean;
};

const MobileTabContext = createContext<MobileTabContextValue>({
  activeTab: "surface",
  setActiveTab: () => {},
  isMobile: false,
});

export function MobileTabProvider({ children }: { children: React.ReactNode }) {
  const isMobile = useSyncExternalStore(subscribeMobile, getMobileSnapshot, getMobileServerSnapshot);
  const [activeTab, setActiveTab] = useState<MobileTab>("surface");
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Auto-switch to surface tab when route changes on mobile
  // (e.g. tapping a stream in sidebar → show chat)
  useEffect(() => {
    if (isMobile) {
      setActiveTab("surface");
    }
  }, [pathname, isMobile]);

  return (
    <MobileTabContext.Provider value={{ activeTab, setActiveTab, isMobile }}>
      {children}
    </MobileTabContext.Provider>
  );
}

export function useMobileTab() {
  return useContext(MobileTabContext);
}
