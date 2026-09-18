export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
type ReadonlyJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };
export type DeepReadonly<T> = JsonValue extends T
  ? ReadonlyJsonValue
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
export type DocumentDefinition<T extends JsonValue> = {
  id: string;
  decode: (input: unknown) => T;
  initial?: () => T;
};
export interface JsonDocument<T extends JsonValue> {
  syncAndRead(): Promise<DeepReadonly<T>>;
  update(mutator: (current: DeepReadonly<T>) => T): Promise<DeepReadonly<T>>;
}
export interface FileJsonDocument<T extends JsonValue> extends JsonDocument<T> {
  exportToFile(): Promise<void>;
}
export class DocumentError extends Error {
  readonly committed: boolean;
  readonly revision?: number;
  readonly documentId: string;
  constructor(
    code: string,
    documentId: string,
    details: { committed?: boolean; revision?: number } = {},
  ) {
    super(`${code}: ${documentId}`);
    this.documentId = documentId;
    this.name = code;
    this.committed = details.committed ?? false;
    this.revision = details.revision;
  }
}

let inCallback = false;
export function assertOperationAllowed(id: string): void {
  if (inCallback) throw new DocumentError("ReentrantOperation", id);
}
export function invokeCallback<T>(id: string, callback: () => T): T {
  if (callback.constructor.name === "AsyncFunction")
    throw new DocumentError("AsyncDocumentCallback", id);
  const previous = inCallback;
  inCallback = true;
  try {
    const value = callback();
    if (value instanceof Promise) {
      void value.catch(() => {});
      throw new DocumentError("AsyncDocumentCallback", id);
    }
    return value;
  } finally {
    inCallback = previous;
  }
}

export function canonicalJson(input: unknown): string {
  const seen = new Set<object>();
  function visit(value: unknown): JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || !value || seen.has(value))
      throw new Error("Invalid JSON value");
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (Reflect.ownKeys(value).length !== value.length + 1)
          throw new Error("Invalid JSON array");
        return Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !("value" in descriptor)) throw new Error("Invalid JSON array");
          return visit(descriptor.value);
        });
      }
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        throw new Error("Invalid JSON object");
      if (Reflect.ownKeys(value).some((key) => typeof key !== "string"))
        throw new Error("Invalid JSON key");
      const result: Record<string, JsonValue> = Object.create(null);
      for (const key of Object.getOwnPropertyNames(value).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          throw new Error("Invalid JSON property");
        result[key] = visit(descriptor.value);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }
  return JSON.stringify(visit(input));
}

export function snapshot<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) snapshot(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export function decodeValue<T extends JsonValue>(
  definition: DocumentDefinition<T>,
  input: unknown,
): T {
  canonicalJson(input);
  const value = invokeCallback(definition.id, () => definition.decode(input));
  return JSON.parse(canonicalJson(value)) as T;
}

export function initialValue<T extends JsonValue>(definition: DocumentDefinition<T>): T {
  if (!definition.initial) throw new DocumentError("UninitializedDocument", definition.id);
  return decodeValue(definition, invokeCallback(definition.id, definition.initial));
}
