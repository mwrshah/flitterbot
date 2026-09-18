// codedecorum: ignore CD005
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { BLACKBOARD_SCHEMA_SQL, BLACKBOARD_SCHEMA_VERSION } from "./contracts/blackboard.ts";
import { openLocalJsonDocuments } from "./json-documents/sqlite.ts";
import { canonicalJson, type JsonValue } from "./json-documents/store.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "json-documents-"));
  const database = path.join(root, "blackboard.db");
  const filePath = path.join(root, "config.json");
  const store = openLocalJsonDocuments(database);
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const definition = {
    id: "test",
    filePath,
    decode(input: unknown) {
      if (
        !input ||
        typeof input !== "object" ||
        typeof (input as { count?: unknown }).count !== "number"
      )
        throw new Error("Expected count");
      return input as { count: number };
    },
  };
  const document = store.document(definition);
  const write = (value: unknown) => fs.writeFileSync(filePath, JSON.stringify(value));
  const inspect = () => {
    const db = new DatabaseSync(database);
    try {
      return db.prepare("SELECT * FROM json_documents WHERE id = ?").get("test") as {
        value_json: string;
        revision: number;
      };
    } finally {
      db.close();
    }
  };
  return { root, database, filePath, store, definition, document, write, inspect };
}

test("file authority, dirty updates, optional projection, and explicit overwrite", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.document.syncAndRead(), { name: "UninitializedDocument" });
  f.write({ count: 1 });
  assert.deepEqual(await f.document.syncAndRead(), { count: 1 });
  const revision = f.inspect().revision;
  fs.writeFileSync(f.filePath, '{ "count": 1 }');
  await f.document.syncAndRead();
  assert.equal(f.inspect().revision, revision);
  f.write({ count: 2 });
  let called = false;
  await assert.rejects(
    f.document.update(() => {
      called = true;
      return { count: 3 };
    }),
    { name: "DirtyDocumentError" },
  );
  assert.equal(called, false);
  assert.equal((await f.document.syncAndRead()).count, 2);
  fs.writeFileSync(f.filePath, "{invalid secret");
  await assert.rejects(
    f.document.syncAndRead(),
    (error) =>
      error instanceof Error &&
      error.name === "InvalidJsonProjection" &&
      !error.message.includes("secret"),
  );
  assert.equal(JSON.parse(f.inspect().value_json).count, 2);
  await f.document.exportToFile();
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).count, 2);
  assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
  fs.unlinkSync(f.filePath);
  assert.equal((await f.document.syncAndRead()).count, 2);
  await f.document.update((value) => ({ count: value.count + 1 }));
  assert.equal(fs.existsSync(f.filePath), false);
  const second = openLocalJsonDocuments(f.database);
  try {
    assert.equal((await second.document(f.definition).syncAndRead()).count, 3);
  } finally {
    await second.close();
  }
  await f.document.exportToFile();
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).count, 3);
});

test("validation, migrations, immutable snapshots, and observed races roll back", async (t) => {
  const f = fixture(t);
  f.write({ count: 1 });
  const value = await f.document.syncAndRead();
  assert.throws(() => {
    (value as { count: number }).count = 2;
  });
  await assert.rejects(
    f.document.update(() => ({ count: Number.NaN })),
    /Invalid JSON/,
  );
  await assert.rejects(
    f.document.update((async () => ({ count: 4 })) as never),
    /AsyncDocumentCallback/,
  );
  await assert.rejects(
    f.document.update(() => {
      void f.document.syncAndRead();
      return { count: 2 };
    }),
    { name: "ReentrantOperation" },
  );
  await assert.rejects(
    f.document.update(() => {
      f.write({ count: 7 });
      return { count: 8 };
    }),
    { name: "FileChanged" },
  );
  assert.equal(JSON.parse(f.inspect().value_json).count, 1);
  assert.equal((await f.document.syncAndRead()).count, 7);
  const migrated = f.store.document({
    ...f.definition,
    decode: (input) => ({ count: (input as { count: number }).count, version: 1 }),
  });
  assert.deepEqual(await migrated.syncAndRead(), { count: 7, version: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath, "utf8")), { count: 7 });
});

test("all JSON roots round-trip without projection; invalid JSON values fail", async (t) => {
  const f = fixture(t);
  for (const [index, value] of [null, true, 12, "value", [1, null], { nested: ["x"] }].entries()) {
    const doc = f.store.document({
      id: `root-${index}`,
      decode: (input) => input as JsonValue,
      initial: () => value,
    });
    assert.deepEqual(await doc.syncAndRead(), value);
    assert.deepEqual(await doc.update(() => value), value);
    assert.equal("exportToFile" in doc, false);
  }
  for (const value of [
    undefined,
    { value: undefined },
    Infinity,
    1n,
    () => 1,
    new Date(),
    new Map(),
    Array(2),
  ])
    assert.throws(() => canonicalJson(value));
  const cycle: unknown[] = [];
  cycle.push(cycle);
  assert.throws(() => canonicalJson(cycle));
});

test("interrupted exports preserve intent and support both recovery authorities", async (t) => {
  const f = fixture(t);
  f.write({ count: 1 });
  await f.document.syncAndRead();
  const rename = t.mock.method(fs, "renameSync", () => {
    throw new Error("disk failure");
  });
  await assert.rejects(
    f.document.update(() => ({ count: 2 })),
    { name: "ProjectionWriteError", committed: true, revision: 2 },
  );
  assert.equal(JSON.parse(f.inspect().value_json).count, 2);
  await assert.rejects(
    f.document.update(() => ({ count: 3 })),
    { name: "PendingExport" },
  );
  assert.equal((await f.document.syncAndRead()).count, 1);
  await assert.rejects(
    f.document.update(() => ({ count: 4 })),
    { name: "ProjectionWriteError" },
  );
  rename.mock.restore();
  await f.document.exportToFile();
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).count, 4);
  const original = fs.renameSync;
  const afterRename = t.mock.method(fs, "renameSync", (from, to) => {
    original(from, to);
    throw new Error("ack failure");
  });
  await assert.rejects(
    f.document.update(() => ({ count: 5 })),
    { name: "ProjectionWriteError" },
  );
  afterRename.mock.restore();
  assert.equal((await f.document.update((value) => ({ count: value.count + 1 }))).count, 6);
  assert.equal(
    fs.readdirSync(f.root).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("binding conflicts, symlinks, and payload tampering are rejected", async (t) => {
  const f = fixture(t);
  f.write({ count: 1 });
  await f.document.syncAndRead();
  assert.throws(() => f.store.document({ ...f.definition, id: "other" }), {
    name: "DocumentBindingConflict",
  });
  const other = openLocalJsonDocuments(f.database);
  try {
    await assert.rejects(
      other.document({ id: "test", decode: f.definition.decode }).syncAndRead(),
      { name: "DocumentBindingConflict" },
    );
    fs.unlinkSync(f.filePath);
    const target = path.join(f.root, "target");
    fs.writeFileSync(target, '{"count":2}');
    fs.symlinkSync(target, f.filePath);
    await assert.rejects(f.document.syncAndRead(), { name: "ProjectionReadError" });
    await assert.rejects(f.document.exportToFile(), { name: "ProjectionWriteError" });
    assert.equal(fs.readFileSync(target, "utf8"), '{"count":2}');
    const db = new DatabaseSync(f.database);
    try {
      db.prepare("UPDATE json_documents SET value_json = ? WHERE id = 'test'").run('{"count":99}');
    } finally {
      db.close();
    }
    await assert.rejects(f.document.syncAndRead(), { name: "DocumentIntegrityError" });
  } finally {
    await other.close();
  }
});

test("storage-only concurrent writes reject stale revisions without callback replay", async (t) => {
  const f = fixture(t);
  const definition = { id: "counter", decode: f.definition.decode, initial: () => ({ count: 0 }) };
  const a = f.store.document(definition);
  await a.syncAndRead();
  const other = openLocalJsonDocuments(f.database);
  try {
    const b = other.document(definition);
    let callbacks = 0;
    const increment = (value: { readonly count: number }) => {
      callbacks++;
      return { count: value.count + 1 };
    };
    const outcomes = await Promise.allSettled([a.update(increment), b.update(increment)]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = outcomes.find((result) => result.status === "rejected");
    assert.ok(rejected);
    assert.equal(rejected.reason.name, "RevisionConflict");
    assert.equal(callbacks, 2);
    assert.equal((await a.syncAndRead()).count, 1);
  } finally {
    await other.close();
  }
});

test("process interruption before and after rename preserves recoverable export intent", async (t) => {
  const f = fixture(t);
  f.write({ count: 1 });
  await f.document.syncAndRead();
  const code = `import fs from 'node:fs';
    import { openLocalJsonDocuments } from ${JSON.stringify(new URL("./json-documents/sqlite.ts", import.meta.url).href)};
    const store = openLocalJsonDocuments(process.argv[1]);
    const document = store.document({ id: 'test', filePath: process.argv[2], decode: value => value });
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (process.argv[3] === 'after') rename(from, to); process.exit(77); };
    await document.update(value => ({ count: value.count + 1 }));`;
  for (const phase of ["before", "after"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        code,
        f.database,
        f.filePath,
        phase,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.status, 77, result.stderr);
    assert.equal(JSON.parse(f.inspect().value_json).count, phase === "before" ? 2 : 3);
    if (phase === "before") {
      await assert.rejects(
        f.document.update(() => ({ count: 99 })),
        { name: "PendingExport" },
      );
      await f.document.exportToFile();
    } else {
      assert.equal((await f.document.update((value) => ({ count: value.count + 1 }))).count, 4);
    }
  }
});

test("installer SQL and runtime schema agree", () => {
  const runtime = new DatabaseSync(":memory:");
  const installer = new DatabaseSync(":memory:");
  try {
    runtime.exec(BLACKBOARD_SCHEMA_SQL);
    const sql = fs.readFileSync(new URL("./blackboard/schema.sql", import.meta.url), "utf8");
    assert.ok(sql.includes(`schema (v${BLACKBOARD_SCHEMA_VERSION})`));
    installer.exec(sql);
    const query = "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name";
    const normalize = (db: DatabaseSync) =>
      db
        .prepare(query)
        .all()
        .map((row) => [row.name, String(row.sql).replace(/\s+/g, " ")]);
    assert.deepEqual(normalize(installer), normalize(runtime));
  } finally {
    runtime.close();
    installer.close();
  }
});
