import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

const HOME = os.homedir();

export function resolvePiAuthPath(controlSurfaceAgentDir: string): string {
  const piAuthPath = path.join(HOME, ".pi", "agent", "auth.json");
  return fs.existsSync(piAuthPath) ? piAuthPath : path.join(controlSurfaceAgentDir, "auth.json");
}

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
