import { Outlet } from "@tanstack/react-router";
import { Group, Panel, VerticalSeparator } from "@/components/common/resizable";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import { Sidebar } from "./sidebar";

export function AppShell() {
  useWhyDidYouRender("AppShell", {});

  return (
    <Group orientation="horizontal" className="h-screen overflow-hidden">
      <Panel
        id="sidebar"
        className="h-full min-h-0"
        defaultSize="240px"
        minSize="239px"
        maxSize="240px"
        collapsible
        collapsedSize="3px"
        groupResizeBehavior="preserve-pixel-size"
        style={{ overflow: "hidden" }}
      >
        <Sidebar />
      </Panel>
      <VerticalSeparator />
      <Panel id="main" className="h-full min-h-0" minSize="0px" style={{ overflow: "visible" }}>
        <main className="flex h-full flex-col min-h-0 overflow-visible">
          <Outlet />
        </main>
      </Panel>
    </Group>
  );
}
