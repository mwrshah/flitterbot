import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FlitterbotConfig } from "../config/load-config.ts";

export function fireAndForgetPeriodicTaskSync(
  config: FlitterbotConfig,
  log: (message: string) => void,
): void {
  const scriptPath = path.join(config.flitterbotSkillsDir, "tasks", "scripts", "tasks.mjs");
  if (!fs.existsSync(scriptPath)) {
    log(`tasks periodic sync skipped: script not found: ${scriptPath}`);
    return;
  }

  const child = spawn(
    process.execPath,
    [scriptPath, "--json", JSON.stringify({ action: "periodic_sync_and_cleanup" })],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );

  child.on("error", (error) => {
    log(`tasks periodic sync launch failed: ${error.message}`);
  });
  child.unref();
  log("tasks periodic sync launched");
}
