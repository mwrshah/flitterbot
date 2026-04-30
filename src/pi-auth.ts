import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

const HOME = os.homedir();

/**
 * Pi's canonical user auth location. Flitterbot intentionally shares this so
 * sessions use the same API keys and OAuth subscription tokens as `pi` after
 * `pi auth login` / `/login`.
 */
export function resolvePiAuthPath(controlSurfaceAgentDir: string): string {
  const piAuthPath = path.join(HOME, ".pi", "agent", "auth.json");
  return fs.existsSync(piAuthPath) ? piAuthPath : path.join(controlSurfaceAgentDir, "auth.json");
}

/**
 * Pi's canonical user model registry. Falls back to Flitterbot's private agent
 * dir only when the canonical file is absent.
 */
export function resolvePiModelsPath(controlSurfaceAgentDir: string): string {
  const piModelsPath = path.join(HOME, ".pi", "agent", "models.json");
  return fs.existsSync(piModelsPath)
    ? piModelsPath
    : path.join(controlSurfaceAgentDir, "models.json");
}

export function createPiAuthStorage(controlSurfaceAgentDir: string): AuthStorage {
  return AuthStorage.create(resolvePiAuthPath(controlSurfaceAgentDir));
}

export function createPiModelRegistry(
  authStorage: AuthStorage,
  controlSurfaceAgentDir: string,
): ModelRegistry {
  return ModelRegistry.create(authStorage, resolvePiModelsPath(controlSurfaceAgentDir));
}
