import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/pi/")({
  beforeLoad: () => {
    throw redirect({ to: "/pi/default" });
  },
});
