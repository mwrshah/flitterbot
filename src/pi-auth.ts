import os from "node:os";
import path from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

const PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

export function createPiAuthStorage(): AuthStorage {
  return AuthStorage.create(path.join(PI_AGENT_DIR, "auth.json"));
}

export function createPiModelRegistry(authStorage: AuthStorage): ModelRegistry {
  return ModelRegistry.create(authStorage, path.join(PI_AGENT_DIR, "models.json"));
}
