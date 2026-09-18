import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateBlackboard } from "../blackboard/migrate.ts";
import { BLACKBOARD_SCHEMA_VERSION } from "../contracts/blackboard.ts";
import { type FileSnapshot, hashBytes, observe, replaceFile, unchanged } from "./file.ts";
import { type StoredDocument, storedDocument } from "./storage.ts";
import {
  assertOperationAllowed,
  canonicalJson,
  type DocumentDefinition,
  DocumentError,
  decodeValue,
  type FileJsonDocument,
  initialValue,
  invokeCallback,
  type JsonDocument,
  type JsonValue,
  snapshot,
} from "./store.ts";

type Row = { value_json: string; value_hash: string; revision: number };
type Projection = {
  file_path: string;
  synced_file_hash: string | null;
  pending_export_hash: string | null;
  pending_export_revision: number | null;
};
const active = new Set<string>();

export function openLocalJsonDocuments(databasePath: string) {
  assertOperationAllowed(databasePath);
  const database = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(database), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database);
  try {
    fs.chmodSync(database, 0o600);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    const migrations = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    const version = migrations
      ? Number(
          db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0,
        )
      : 0;
    if (version > BLACKBOARD_SCHEMA_VERSION)
      throw new Error("Database schema is newer than this runtime");
    if (version < BLACKBOARD_SCHEMA_VERSION) migrateBlackboard(db);
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false;
  const bindings = new Map<string, string | undefined>();
  function transaction<T>(callback: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function load(id: string): Row | undefined {
    const row = db
      .prepare("SELECT value_json, value_hash, revision FROM json_documents WHERE id = ?")
      .get(id) as Row | undefined;
    if (
      row &&
      (!Number.isSafeInteger(row.revision) ||
        row.revision < 1 ||
        hashBytes(row.value_json) !== row.value_hash ||
        canonicalJson(JSON.parse(row.value_json)) !== row.value_json)
    )
      throw new DocumentError("DocumentIntegrityError", id);
    return row;
  }
  function projection(id: string, filePath?: string): Projection | undefined {
    const found = db
      .prepare("SELECT * FROM json_document_projections WHERE document_id = ?")
      .get(id) as Projection | undefined;
    if (found && found.file_path !== filePath)
      throw new DocumentError("DocumentBindingConflict", id);
    if (found) {
      for (const hash of [found.synced_file_hash, found.pending_export_hash]) {
        if (hash !== null && !/^[a-f0-9]{64}$/.test(hash))
          throw new DocumentError("DocumentIntegrityError", id);
      }
      if (found.pending_export_hash && found.pending_export_revision !== load(id)?.revision)
        throw new DocumentError("DocumentIntegrityError", id);
    }
    if (filePath) {
      const owner = db
        .prepare("SELECT document_id FROM json_document_projections WHERE file_path = ?")
        .get(filePath) as { document_id: string } | undefined;
      if (owner && owner.document_id !== id) throw new DocumentError("DocumentBindingConflict", id);
    }
    return found;
  }
  function save(id: string, value: JsonValue, previous?: Row): Row {
    const value_json = canonicalJson(value);
    const row = {
      value_json,
      value_hash: hashBytes(value_json),
      revision: previous ? previous.revision + Number(previous.value_json !== value_json) : 1,
    };
    db.prepare(`INSERT INTO json_documents(id, value_json, value_hash, revision) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json, value_hash=excluded.value_hash, revision=excluded.revision`).run(
      id,
      row.value_json,
      row.value_hash,
      row.revision,
    );
    return row;
  }
  function metadata(
    id: string,
    filePath: string,
    synced: string | null,
    pending: string | null = null,
    revision: number | null = null,
  ): void {
    db.prepare(`INSERT INTO json_document_projections(document_id, file_path, synced_file_hash, pending_export_hash, pending_export_revision)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET synced_file_hash=excluded.synced_file_hash,
      pending_export_hash=excluded.pending_export_hash, pending_export_revision=excluded.pending_export_revision`).run(
      id,
      filePath,
      synced,
      pending,
      revision,
    );
  }
  function document<T extends JsonValue>(
    definition: DocumentDefinition<T> & { filePath: string },
  ): FileJsonDocument<T>;
  function document<T extends JsonValue>(definition: DocumentDefinition<T>): JsonDocument<T>;
  function document<T extends JsonValue>(
    definition: DocumentDefinition<T> & { filePath?: string },
  ): JsonDocument<T> | FileJsonDocument<T> {
    definition = { ...definition };
    const { id } = definition;
    if (!id || (definition.filePath !== undefined && !path.isAbsolute(definition.filePath)))
      throw new DocumentError("InvalidDocumentBinding", id);
    const filePath =
      definition.filePath === undefined ? undefined : path.resolve(definition.filePath);
    if (bindings.has(id) && bindings.get(id) !== filePath)
      throw new DocumentError("DocumentBindingConflict", id);
    if (filePath && [...bindings].some(([key, value]) => key !== id && value === filePath))
      throw new DocumentError("DocumentBindingConflict", id);
    bindings.set(id, filePath);
    function run<R>(callback: () => R): Promise<R> {
      assertOperationAllowed(id);
      if (active.has(database)) throw new DocumentError("ReentrantOperation", id);
      if (closed) return Promise.reject(new DocumentError("ClosedDocumentStore", id));
      active.add(database);
      try {
        return Promise.resolve(callback());
      } catch (error) {
        return Promise.reject(error);
      } finally {
        active.delete(database);
      }
    }
    function current(row?: Row): T {
      return row ? decodeValue(definition, JSON.parse(row.value_json)) : initialValue(definition);
    }
    function exportBytes(row: Row): string {
      return `${JSON.stringify(JSON.parse(row.value_json), null, 2)}\n`;
    }
    function finish(row: Row, expected?: FileSnapshot): void {
      if (!filePath) throw new DocumentError("MissingProjection", id);
      try {
        transaction(() => {
          const latest = load(id);
          const p = projection(id, filePath);
          const bytes = exportBytes(row);
          const target = hashBytes(bytes);
          if (latest?.revision !== row.revision)
            throw new DocumentError("OperationSuperseded", id, {
              committed: true,
              revision: row.revision,
            });
          if (!p?.pending_export_hash && p?.synced_file_hash === target) return;
          if (p?.pending_export_hash !== target || p.pending_export_revision !== row.revision)
            throw new DocumentError("OperationSuperseded", id, {
              committed: true,
              revision: row.revision,
            });
          const observed = observe(filePath);
          if (observed?.hash === target) {
            metadata(id, filePath, target);
            return;
          }
          if (expected !== undefined) {
            if (!observed) {
              metadata(id, filePath, null);
              return;
            }
            unchanged(filePath, expected);
          }
          replaceFile(filePath, bytes, expected);
          metadata(id, filePath, target);
        });
      } catch (error) {
        if (error instanceof DocumentError && error.name === "OperationSuperseded") throw error;
        throw new DocumentError("ProjectionWriteError", id, {
          committed: true,
          revision: row.revision,
        });
      }
    }
    const handle: JsonDocument<T> = {
      syncAndRead: () =>
        run(() =>
          transaction(() => {
            const row = load(id);
            const p = projection(id, filePath);
            const file = filePath ? observe(filePath) : null;
            let value: T;
            if (file && (file.hash !== p?.synced_file_hash || p?.pending_export_hash)) {
              let input: unknown;
              try {
                input = JSON.parse(file.bytes.toString("utf8"));
              } catch {
                throw new DocumentError("InvalidJsonProjection", filePath ?? id);
              }
              value = decodeValue(definition, input);
            } else {
              value = current(row);
            }
            if (filePath) unchanged(filePath, file);
            save(id, value, row);
            if (filePath) metadata(id, filePath, file?.hash ?? null);
            return snapshot(value);
          }),
        ),
      update: (mutator) =>
        run(() => {
          let expected: FileSnapshot = null;
          const result = transaction(() => {
            const row = load(id);
            const p = projection(id, filePath);
            expected = filePath ? observe(filePath) : null;
            let baseline = p?.synced_file_hash;
            let pending = p?.pending_export_hash;
            if (pending && expected?.hash === pending) {
              baseline = pending;
              pending = null;
            }
            if (expected && expected.hash !== baseline)
              throw new DocumentError("DirtyDocumentError", id);
            if (expected && pending) throw new DocumentError("PendingExport", id);
            const value = decodeValue(
              definition,
              invokeCallback(id, () => mutator(snapshot(current(row)))),
            );
            if (filePath) unchanged(filePath, expected);
            const next = save(id, value, row);
            if (filePath)
              metadata(
                id,
                filePath,
                expected?.hash ?? null,
                expected ? hashBytes(exportBytes(next)) : null,
                expected ? next.revision : null,
              );
            return { value, next };
          });
          if (filePath && expected) finish(result.next, expected);
          return snapshot(result.value);
        }),
    };
    if (!filePath) {
      const stored = (row: Row): StoredDocument => ({
        id,
        valueJson: row.value_json,
        valueHash: row.value_hash,
        revision: row.revision,
      });
      return storedDocument(
        {
          read: () =>
            run(() =>
              transaction(() => {
                projection(id);
                const row = load(id);
                return row ? stored(row) : null;
              }),
            ),
          compareAndSet: (_id, revision, value) =>
            run(() =>
              transaction(() => {
                projection(id);
                const row = load(id);
                if ((row?.revision ?? null) !== revision)
                  throw new DocumentError("RevisionConflict", id);
                if (hashBytes(value.valueJson) !== value.valueHash)
                  throw new DocumentError("DocumentIntegrityError", id);
                return stored(save(id, JSON.parse(value.valueJson), row));
              }),
            ),
        },
        definition,
      );
    }
    return {
      ...handle,
      exportToFile: () =>
        run(() => {
          const row = transaction(() => {
            const previous = load(id);
            const p = projection(id, filePath);
            const next = save(id, current(previous), previous);
            metadata(
              id,
              filePath,
              p?.synced_file_hash ?? null,
              hashBytes(exportBytes(next)),
              next.revision,
            );
            return next;
          });
          finish(row);
        }),
    };
  }
  return {
    document,
    close(): Promise<void> {
      assertOperationAllowed(database);
      if (active.has(database)) throw new DocumentError("ReentrantOperation", database);
      if (!closed) {
        db.close();
        closed = true;
      }
      return Promise.resolve();
    },
  };
}
