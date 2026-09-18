import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { FLITTERBOT_HOME as FLITTERBOT_DIR } from "../paths.ts";
import { readConfiguration } from "./documents.ts";
import { deriveConfig, type FlitterbotConfig } from "./schema.ts";

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export async function loadConfig(): Promise<FlitterbotConfig> {
  const config = deriveConfig(await readConfiguration("runtime-config"));
  const {
    controlSurfaceDir,
    controlSurfaceSessionsDir: sessionsDir,
    controlSurfaceArchivedSessionsDir: archivedSessionsDir,
    controlSurfaceAgentDir,
    piAgentDir,
    controlSurfaceLogPath: logPath,
  } = config;
  ensureDir(FLITTERBOT_DIR);
  ensureDir(config.projectsDir);
  ensureDir(controlSurfaceDir);
  ensureDir(sessionsDir);
  ensureDir(archivedSessionsDir);
  ensureDir(controlSurfaceAgentDir);
  fs.chmodSync(controlSurfaceAgentDir, 0o700);
  ensureDir(piAgentDir);
  ensureDir(config.flitterbotSkillsDir);
  ensureDir(path.dirname(config.memoryPath));
  ensureDir(path.join(FLITTERBOT_DIR, "data", "tasks"));
  ensureDir(path.join(FLITTERBOT_DIR, "data", "notes"));
  ensureDir(path.dirname(config.learningsNotePath));
  ensureDir(path.dirname(logPath));
  ensureDir(path.dirname(config.whatsappSocketPath));
  ensureDir(path.dirname(config.whatsappPidPath));
  ensureDir(config.whatsappAuthDir);

  return config;
}
