import {
  assertOperationAllowed,
  canonicalJson,
  type DocumentDefinition,
  DocumentError,
  decodeValue,
  initialValue,
  invokeCallback,
  type JsonDocument,
  type JsonValue,
  snapshot,
} from "./store.ts";

export type StoredDocument = { id: string; valueJson: string; revision: number; valueHash: string };
export interface DocumentStorage {
  read(id: string): Promise<StoredDocument | null>;
  compareAndSet(
    id: string,
    expectedRevision: number | null,
    value: { valueJson: string; valueHash: string },
  ): Promise<StoredDocument>;
}
async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function storedDocument<T extends JsonValue>(
  storage: DocumentStorage,
  definition: DocumentDefinition<T>,
): JsonDocument<T> {
  let busy = false;
  function operation(
    mutator?: Parameters<JsonDocument<T>["update"]>[0],
  ): Promise<ReturnType<typeof snapshot<T>>> {
    assertOperationAllowed(definition.id);
    if (busy) throw new DocumentError("ReentrantOperation", definition.id);
    busy = true;
    return (async () => {
      try {
        const row = await storage.read(definition.id);
        if (row && (await hash(row.valueJson)) !== row.valueHash)
          throw new DocumentError("DocumentIntegrityError", definition.id);
        const current = row
          ? decodeValue(definition, JSON.parse(row.valueJson))
          : initialValue(definition);
        const value = mutator
          ? decodeValue(
              definition,
              invokeCallback(definition.id, () => mutator(snapshot(current))),
            )
          : current;
        const valueJson = canonicalJson(value);
        if (mutator || !row || valueJson !== row.valueJson) {
          await storage.compareAndSet(definition.id, row?.revision ?? null, {
            valueJson,
            valueHash: await hash(valueJson),
          });
        }
        return snapshot(value);
      } finally {
        busy = false;
      }
    })();
  }
  return { syncAndRead: () => operation(), update: (mutator) => operation(mutator) };
}
