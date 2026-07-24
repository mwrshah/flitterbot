import os from "node:os";
import path from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

const PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

export function createPiModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(PI_AGENT_DIR, "auth.json"),
    modelsPath: path.join(PI_AGENT_DIR, "models.json"),
  });
}

export function createPiModelRegistry(modelRuntime: ModelRuntime): ModelRegistry {
  return new ModelRegistry(modelRuntime);
}
