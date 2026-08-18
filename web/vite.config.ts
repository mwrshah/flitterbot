import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 3188,
    strictPort: true,
  },
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@tanstack/react-router": fileURLToPath(import.meta.resolve("speedy-router")),
      "@tanstack/router-core": fileURLToPath(import.meta.resolve("speedy-router-core")),
      "@tanstack/history": fileURLToPath(import.meta.resolve("speedy-router-history")),
    },
  },
  plugins: [
    tailwindcss(),
    tanstackRouter({
      routesDirectory: "./src/routes",
      routeTreeFileHeader: [
        "// codedecorum: ignore all",
        "/* eslint-disable */",
        "// @ts-nocheck",
        "// noinspection JSUnusedGlobalSymbols",
      ],
    }),
    viteReact(),
  ],
});
