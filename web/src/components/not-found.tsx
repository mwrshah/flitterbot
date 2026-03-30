import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";

export function NotFound({ children }: { children?: ReactNode }) {
  useWhyDidYouRender("NotFound", { children });
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex flex-col gap-4 max-w-sm">
        <p className="text-sm text-muted-foreground">
          {children || "The page you are looking for does not exist."}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent transition-colors"
            onClick={() => window.history.back()}
          >
            Go back
          </button>
          <Link
            className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent transition-colors"
            to="/"
          >
            Start over
          </Link>
        </div>
      </div>
    </div>
  );
}
