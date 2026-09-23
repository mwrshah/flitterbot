import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { authkitMiddleware } from "@workos/authkit-tanstack-react-start";
import { validateAuthConfig } from "./auth/env";

const authConfig = createMiddleware().server(({ next }) => {
  validateAuthConfig();
  return next();
});

export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({ filter: (context) => context.handlerType === "serverFn" }),
    authConfig,
    authkitMiddleware(),
  ],
}));
