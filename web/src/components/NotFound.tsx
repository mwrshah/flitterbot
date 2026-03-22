import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function NotFound({ children }: { children?: ReactNode }) {
  return (
    <div className="card">
      <div className="card-content stack gap-sm">
        <div className="muted">{children || "The page you are looking for does not exist."}</div>
        <div className="row gap-sm wrap align-center">
          <button className="button button-secondary" onClick={() => window.history.back()}>
            Go back
          </button>
          <Link className="button button-secondary" to="/">
            Start over
          </Link>
        </div>
      </div>
    </div>
  );
}
