import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-in-error")({
  component: () => (
    <main className="grid min-h-dvh place-items-center bg-background px-6 text-text">
      <div className="space-y-3 text-center">
        <h1 className="text-xl font-semibold">Sign-in did not finish</h1>
        <p className="text-sm text-text-muted">Your session may have expired.</p>
        <a className="text-sm text-text-pop underline underline-offset-4" href="/api/auth/sign-in">
          Try signing in again
        </a>
      </div>
    </main>
  ),
});
