import { useRouterState } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useState } from "react";
import { useIsMobile } from "~/hooks/use-mobile";

export type MobileTab = "sidebar" | "surface" | "stream" | "info";

type MobileTabContextValue = {
  activeTab: MobileTab;
  setActiveTab: (tab: MobileTab) => void;
  isMobile: boolean;
};

const MobileTabContext = createContext<MobileTabContextValue>({
  activeTab: "surface",
  setActiveTab: () => {},
  isMobile: false,
});

export function MobileTabProvider({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
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
