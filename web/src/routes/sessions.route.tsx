import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";

export const Route = createFileRoute("/sessions")({
  head: () => ({
    meta: [{ title: "Autonoma — Sessions" }],
  }),
  component: SessionsLayout,
});

function SessionsLayout() {
  useWhyDidYouRender("SessionsLayout", {});

  return <Outlet />;
}
