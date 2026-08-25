import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FlitterbotConfig } from "../config/load-config.ts";
import { resolveModelEntry } from "../config/models.ts";
import type { ClassifierPrompts } from "../prompts/classifier.ts";

export async function inferClassifierJson(
  modelRuntime: ModelRuntime,
  config: FlitterbotConfig,
  prompts: ClassifierPrompts,
): Promise<unknown> {
  const modelEntry = resolveModelEntry(config);
  const model = modelRuntime.getModel(modelEntry.provider, modelEntry.modelId);
  if (!model) {
    throw new Error(
      `Unable to resolve Pi model: provider=${modelEntry.provider} modelId=${modelEntry.modelId}`,
    );
  }

  const response = await modelRuntime.completeSimple(model, {
    systemPrompt: prompts.systemPrompt,
    messages: [{ role: "user", content: prompts.userPrompt, timestamp: Date.now() }],
  });

  if (response.errorMessage) {
    throw new Error(`Classifier inference failed: ${response.errorMessage}`);
  }
  if (response.stopReason !== "stop") {
    throw new Error(`Classifier inference stopped with reason: ${response.stopReason}`);
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) {
    throw new Error("Classifier inference returned no text");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Classifier inference returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
