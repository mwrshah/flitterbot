import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/streams/")({
  beforeLoad: () => {
    throw redirect({ to: "/streams/default" });
  },
});
