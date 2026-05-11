import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const TASKS_SCRIPT = fileURLToPath(new URL("./tasks.mjs", import.meta.url));

test("maintain_tasks reports provider sync and cleanup stats", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-tasks-test-"));
  const storePath = path.join(tmp, "tasks.json");
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, "{}\n", "utf8");
  fs.writeFileSync(storePath, `${JSON.stringify({
    version: 2,
    updatedAt: "2026-05-10T00:00:00.000Z",
    projects: [{
      id: "project-1",
      name: "Inbox",
      archived: false,
      externalLinks: [],
      linearTeamId: null,
      linearProjectId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    tasks: [{
      id: "task-old-done",
      projectId: "project-1",
      description: "Old done task",
      details: null,
      dueAt: "2026-01-01T00:00:00.000Z",
      status: "done",
      externalLinks: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    }],
  }, null, 2)}\n`, "utf8");

  const { stdout } = await execFileAsync(process.execPath, [TASKS_SCRIPT, JSON.stringify({ action: "maintain_tasks" })], {
    env: { ...process.env, FLITTERBOT_TASKS_FILE: storePath, FLITTERBOT_CONFIG: configPath },
  });

  assert.match(stdout, /Maintained tasks\./);
  assert.match(stdout, /- Todoist: inward skipped \(no API key configured\); outward not run\./);
  assert.match(stdout, /- Linear: inward skipped \(no API key configured\); outward not run\./);
  assert.match(stdout, /- Cleanup: removed 1 completed task older than 90 days\./);

  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.deepEqual(store.tasks, []);
});

test("maintain_tasks migrates provider-specific external link fields and backs up old shape", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-tasks-migration-test-"));
  const storePath = path.join(tmp, "tasks.json");
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, "{}\n", "utf8");
  fs.writeFileSync(storePath, `${JSON.stringify({
    version: 2,
    updatedAt: "2026-05-10T00:00:00.000Z",
    projects: [{
      id: "project-1",
      name: "Inbox",
      archived: false,
      externalLinks: [{ system: "todoist", externalId: "todoist-project" }],
      linearTeamId: "linear-team",
      linearProjectId: "linear-project",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    tasks: [{
      id: "task-1",
      projectId: "project-1",
      description: "Linked task",
      details: null,
      dueAt: "2026-05-10T00:00:00.000Z",
      status: "active",
      externalLinks: [
        { system: "todoist", externalId: "todoist-task" },
        { system: "linear", externalId: "linear-issue", url: "https://linear.app/issue/LIN-1" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }, null, 2)}\n`, "utf8");

  await execFileAsync(process.execPath, [TASKS_SCRIPT, JSON.stringify({ action: "maintain_tasks" })], {
    env: { ...process.env, FLITTERBOT_TASKS_FILE: storePath, FLITTERBOT_CONFIG: configPath },
  });

  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal("linearTeamId" in store.projects[0], false);
  assert.equal("linearProjectId" in store.projects[0], false);
  assert.deepEqual(store.projects[0].externalLinks, [
    { system: "todoist", projectId: "todoist-project" },
    { system: "linear", teamId: "linear-team", projectId: "linear-project" },
  ]);
  assert.deepEqual(store.tasks[0].externalLinks, [
    { system: "todoist", taskId: "todoist-task" },
    { system: "linear", issueId: "linear-issue", url: "https://linear.app/issue/LIN-1" },
  ]);
  assert.equal(fs.readdirSync(tmp).filter((name) => name.includes("pre-external-links-migration")).length, 1);
});
