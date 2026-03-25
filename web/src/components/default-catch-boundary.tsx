import {
  ErrorComponent,
  type ErrorComponentProps,
  Link,
  rootRouteId,
  useMatch,
  useRouter,
} from "@tanstack/react-router";
import type { MouseEvent } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";

export function DefaultCatchBoundary({ error }: ErrorComponentProps) {
  useWhyDidYouRender("DefaultCatchBoundary", { error });
  const router = useRouter();
  const isRoot = useMatch({
    strict: false,
    select: (state) => state.id === rootRouteId,
  });

  console.error(error);

  return (
    <div className="app-shell">
      <div className="card">
        <div className="card-content stack gap-md">
          <ErrorComponent error={error} />
          <div className="row gap-sm wrap align-center">
            <button className="button button-secondary" onClick={() => router.invalidate()}>
              Try again
            </button>
            <Link
              className="button button-secondary"
              onClick={
                !isRoot
                  ? (event: MouseEvent<HTMLAnchorElement>) => {
                      event.preventDefault();
                      window.history.back();
                    }
                  : undefined
              }
              to="/"
            >
              {isRoot ? "Home" : "Go back"}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
