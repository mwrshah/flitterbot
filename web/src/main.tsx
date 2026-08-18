if (import.meta.env.DEV) {
  void import("react-grab");
}

import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getRouter } from "./router";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const router = getRouter();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={router.options.context.queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
