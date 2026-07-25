import path from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export function createPiModelRuntime(
  agentDir: string,
  options?: { allowModelNetwork?: boolean },
): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    allowModelNetwork: options?.allowModelNetwork,
  });
}

export function createPiModelRegistry(modelRuntime: ModelRuntime): ModelRegistry {
  return new ModelRegistry(modelRuntime);
}
