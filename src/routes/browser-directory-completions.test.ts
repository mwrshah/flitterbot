import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { handleBrowserDirectoryCompletionsRoute } from "./browser-directory-completions.ts";

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-directory-completions-"));
  fs.mkdirSync(path.join(root, ".config"));
  fs.mkdirSync(path.join(root, ".cursor"));
  fs.mkdirSync(path.join(root, ".env.d"));
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, ".config", "settings.json"), "{}\n");
  fs.writeFileSync(path.join(root, ".cursor", "rules.md"), "rules\n");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(root, ".env.example"), "SECRET=example\n");
  fs.writeFileSync(path.join(root, ".envrc"), "dotenv\n");
  fs.writeFileSync(path.join(root, ".env.d", "secret"), "SECRET=1\n");
  fs.writeFileSync(path.join(root, ".github", "workflows", "audit.yml"), "name: audit\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n");
  fs.writeFileSync(path.join(root, "README.md"), "readme\n");
  fs.writeFileSync(path.join(root, "node_modules", "package.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
  return root;
}

async function fetchCompletions(cwd: string, query: string): Promise<string[]> {
  const runtime = {
    log: () => {},
    blackboard: undefined,
    config: { projectsDir: cwd },
    sessionManager: { getDefault: () => ({}) },
  } as unknown as ControlSurfaceRuntime;
  const req = {
    url: `/api/directory-completions?query=${encodeURIComponent(query)}`,
  } as http.IncomingMessage;
  let body = "";
  const res = {
    setHeader: () => {},
    end: (chunk: string) => {
      body += chunk;
    },
  } as unknown as http.ServerResponse;

  await handleBrowserDirectoryCompletionsRoute(runtime, req, res);
  return (JSON.parse(body) as { items: Array<{ path: string }> }).items.map((item) => item.path);
}

describe("browser directory completions", () => {
  test("returns hidden non-env entries in directory listings", async () => {
    const root = createFixture();
    try {
      const paths = await fetchCompletions(root, "");

      expect(paths).toContain(".config/");
      expect(paths).toContain(".cursor/");
      expect(paths).toContain(".github/");
      expect(paths).toContain(".gitignore");
      expect(paths).toContain("node_modules/");
      expect(paths).toContain("src/");
      expect(paths).not.toContain(".env");
      expect(paths).not.toContain(".env.example");
      expect(paths).not.toContain(".envrc");
      expect(paths).not.toContain(".env.d/");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps dotfile filtering limited to env-like names", async () => {
    const root = createFixture();
    try {
      const dotPaths = await fetchCompletions(root, ".");
      expect(dotPaths).toContain(".config/");
      expect(dotPaths).toContain(".cursor/");
      expect(dotPaths).toContain(".github/");
      expect(dotPaths).toContain(".gitignore");
      expect(dotPaths).not.toContain(".env");
      expect(dotPaths).not.toContain(".env.example");
      expect(dotPaths).not.toContain(".envrc");

      const envPaths = await fetchCompletions(root, ".env");
      expect(envPaths).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not list inside env-like directories", async () => {
    const root = createFixture();
    try {
      await expect(fetchCompletions(root, ".env.d/")).resolves.toEqual([]);
      await expect(fetchCompletions(root, ".github/")).resolves.toContain(".github/workflows/");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
