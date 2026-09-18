import os from "node:os";
import path from "node:path";
import { observe } from "../json-documents/file.ts";
import { openLocalJsonDocuments } from "../json-documents/sqlite.ts";
import type { DeepReadonly, FileJsonDocument, JsonValue } from "../json-documents/store.ts";
import { BLACKBOARD_PATH, FLITTERBOT_CONFIG_PATH, WHATSAPP_CONFIG_PATH } from "../paths.ts";
import { decodeWhatsAppConfig } from "../whatsapp/config.ts";
import { decodeStoredConfig } from "./schema.ts";

export type ConfigurationName = "runtime-config" | "whatsapp-config";
export type Configuration = Record<string, JsonValue>;
export const configurationDefinitions = {
  "runtime-config": {
    id: "runtime-config",
    filePath: FLITTERBOT_CONFIG_PATH,
    decode: decodeStoredConfig,
  },
  "whatsapp-config": {
    id: "whatsapp-config",
    filePath: WHATSAPP_CONFIG_PATH,
    decode: decodeWhatsAppConfig,
  },
};
export function preflightConfiguration(): void {
  const file = observe(FLITTERBOT_CONFIG_PATH);
  if (!file) return;
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    return;
  }
  const legacy = input?.blackboardPath;
  if (legacy !== undefined) {
    if (
      typeof legacy !== "string" ||
      path.resolve(legacy.replace(/^~(?=\/|$)/, os.homedir())) !== BLACKBOARD_PATH
    ) {
      throw new Error(
        "Noncanonical blackboardPath: stop writers and relocate the database to ~/.flitterbot/blackboard.db before continuing",
      );
    }
  }
}
export async function withConfiguration<R>(
  name: ConfigurationName,
  operation: (document: FileJsonDocument<Configuration>) => Promise<R>,
  initial?: () => Configuration,
): Promise<R> {
  preflightConfiguration();
  const store = openLocalJsonDocuments(BLACKBOARD_PATH);
  try {
    const document = store.document({ ...configurationDefinitions[name], initial });
    return await operation(document);
  } finally {
    await store.close();
  }
}
export function readConfiguration(name: ConfigurationName): Promise<DeepReadonly<Configuration>> {
  return withConfiguration(name, (document) => document.syncAndRead());
}
export function updateConfiguration(
  name: ConfigurationName,
  mutator: (current: DeepReadonly<Configuration>) => Configuration,
): Promise<DeepReadonly<Configuration>> {
  return withConfiguration(name, (document) => document.update(mutator));
}
