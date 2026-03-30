import { Outlet } from "@tanstack/react-router";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { Sidebar } from "./sidebar";

export function AppShell() {
  useWhyDidYouRender("AppShell", {});

  return (
    <div className="grid grid-cols-[240px_1fr] grid-rows-1 h-screen overflow-hidden">
      <Sidebar />

      <main className="flex flex-col min-h-0 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
