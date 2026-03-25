import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/sessions")({
  head: () => ({
    meta: [{ title: "Autonoma — Sessions" }],
  }),
  component: SessionsLayout,
});

function SessionsLayout() {
  return <Outlet />;
}
