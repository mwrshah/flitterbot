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
