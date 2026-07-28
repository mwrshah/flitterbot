import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { BlackboardDatabase } from "../src/blackboard/db.ts";
import {
  insertStream,
  nextStreamName,
  setStreamName,
} from "../src/blackboard/query-streams.ts";

function withBlackboard(run: (db: BlackboardDatabase, dbPath: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-stream-names-"));
  const dbPath = path.join(directory, "blackboard.db");
  const db = new BlackboardDatabase(dbPath);
  try {
    run(db, dbPath);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("stream creation keeps the first name and numbers every collision", () => {
  withBlackboard((db) => {
    assert.equal(insertStream(db, "name").name, "name");
    assert.equal(insertStream(db, "name").name, "2name");
    assert.equal(insertStream(db, "name").name, "3name");
    assert.equal(insertStream(db, "name").name, "4name");
  });
});

test("numbered names continue their numeric prefix", () => {
  assert.equal(nextStreamName("name"), "2name");
  assert.equal(nextStreamName("2name"), "3name");
  assert.equal(nextStreamName("9name"), "10name");
  assert.equal(nextStreamName("10name"), "11name");

  withBlackboard((db) => {
    assert.equal(insertStream(db, "2name").name, "2name");
    assert.equal(insertStream(db, "2name").name, "3name");
  });
});

test("allocation skips occupied names without requiring contiguous history", () => {
  withBlackboard((db) => {
    insertStream(db, "name");
    insertStream(db, "3name");
    assert.equal(insertStream(db, "name").name, "2name");
    assert.equal(insertStream(db, "name").name, "4name");
  });
});

test("concurrent creators allocate one contiguous sequence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-stream-names-"));
  const dbPath = path.join(directory, "blackboard.db");
  new BlackboardDatabase(dbPath).close();
  const dbModuleUrl = new URL("../src/blackboard/db.ts", import.meta.url).href;
  const streamsModuleUrl = new URL("../src/blackboard/query-streams.ts", import.meta.url).href;
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    Promise.all([import(workerData.dbModuleUrl), import(workerData.streamsModuleUrl)])
      .then(([{ BlackboardDatabase }, { insertStream }]) => {
        const db = new BlackboardDatabase(workerData.dbPath);
        try { parentPort.postMessage({ name: insertStream(db, "name").name }); }
        finally { db.close(); }
      })
      .catch((error) => parentPort.postMessage({ error: String(error?.stack ?? error) }));
  `;

  try {
    const names = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<string>((resolve, reject) => {
            const worker = new Worker(workerSource, {
              eval: true,
              workerData: { dbPath, dbModuleUrl, streamsModuleUrl },
            });
            worker.once("message", (result: { name?: string; error?: string }) => {
              if (result.error) reject(new Error(result.error));
              else resolve(result.name!);
            });
            worker.once("error", reject);
          }),
      ),
    );
    assert.deepEqual(names.sort(), ["2name", "3name", "4name", "5name", "6name", "name"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("collisions are case-insensitive across database connections", () => {
  withBlackboard((db, dbPath) => {
    const other = new BlackboardDatabase(dbPath);
    try {
      assert.equal(insertStream(db, "Name").name, "Name");
      assert.equal(insertStream(other, "name").name, "2name");
      assert.equal(insertStream(db, "NAME").name, "3NAME");
    } finally {
      other.close();
    }
  });
});

test("renaming uses the same collision allocator", () => {
  withBlackboard((db) => {
    insertStream(db, "name");
    insertStream(db, "2name");
    const renamed = setStreamName(db, insertStream(db, "other").id, "name");
    assert.equal(renamed?.name, "3name");
  });
});
