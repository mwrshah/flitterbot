import assert from "node:assert/strict";
import test from "node:test";
import { createLinearProvider } from "./linear-provider.mjs";

function makeDeps(now = "2026-05-10T10:30:00.000Z") {
  return {
    externalKey(system, externalId) {
      return `${this.normalizeName(system)}:${String(externalId ?? "")}`;
    },
    getExternalLink(item, system) {
      return item.externalLinks?.find((link) => this.normalizeName(link.system) === this.normalizeName(system));
    },
    localDateKey(date) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    },
    localTodayStartIso() {
      return "2026-05-10T00:00:00.000Z";
    },
    markInboundApplied() {},
    normalizeMaybeDate(value, fallback) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
    },
    normalizeName(name) {
      return String(name ?? "").trim().toLocaleLowerCase();
    },
    nowIso() {
      return now;
    },
    shouldApplyInbound() {
      return true;
    },
    uniqueId() {
      return "task-new";
    },
    upsertExternalLink(links, nextLink) {
      const index = links.findIndex((link) => this.normalizeName(link.system) === this.normalizeName(nextLink.system));
      if (index >= 0) links[index] = nextLink;
      else links.push(nextLink);
    },
  };
}

function makeIdx(store, deps) {
  const tasksByExternal = new Map();
  const tasksById = new Map();
  for (const task of store.tasks) {
    tasksById.set(task.id, task);
    for (const link of task.externalLinks) tasksByExternal.set(deps.externalKey(link.system, link.externalId), task);
  }
  return { tasksByExternal, tasksById };
}

function mappedProject() {
  return {
    id: "project-local",
    name: "Linear Project",
    archived: false,
    externalLinks: [],
    linearTeamId: "team-1",
    linearProjectId: null,
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

function issue({ id = "linear-issue", title = "Upstream issue", stateType = "unstarted" } = {}) {
  return {
    id,
    identifier: "LIN-1",
    title,
    description: `${title} details\n\n[proj_name-Linear Project]`,
    dueDate: "2026-05-09",
    url: "https://linear.app/issue/LIN-1",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-09T12:00:00.000Z",
    completedAt: stateType === "completed" ? "2026-05-09T12:00:00.000Z" : null,
    state: { id: `state-${stateType}`, name: stateType, type: stateType },
    team: { id: "team-1", key: "LIN", name: "Linear" },
    project: null,
    assignee: { id: "user-1", name: "User", email: "user@example.com" },
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify({ data: body }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function installLinearFetch(t, issues) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, init) => {
    const { query } = JSON.parse(init.body);
    if (query.includes("Viewer")) return jsonResponse({ viewer: { id: "user-1", name: "User", email: "user@example.com" } });
    if (query.includes("AssignedIssues")) return jsonResponse({ issues: { nodes: issues } });
    throw new Error(`Unexpected Linear query: ${query}`);
  };
}

test("Linear inbound sync marks existing local tasks done from completed issues", async (t) => {
  const deps = makeDeps();
  const project = mappedProject();
  const task = {
    id: "task-local",
    projectId: project.id,
    description: "Done upstream",
    details: null,
    dueAt: "2026-05-08T00:00:00.000Z",
    status: "active",
    externalLinks: [{ system: "linear", externalId: "linear-issue" }],
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
  const store = { projects: [project], tasks: [task] };
  installLinearFetch(t, [issue({ title: "Done upstream", stateType: "completed" })]);

  const result = await createLinearProvider({ apiKey: "token" }, deps).syncIn(store, makeIdx(store, deps), {});

  assert.equal(result.inbound.issues.seen, 1);
  assert.equal(result.inbound.completedTasks.markedDone, 1);
  assert.equal(store.tasks.length, 1);
  assert.equal(task.status, "done");
  assert.equal(task.updatedAt, "2026-05-10T10:30:00.000Z");
});

test("Linear inbound sync does not import completed issues absent locally", async (t) => {
  const deps = makeDeps();
  const store = { projects: [mappedProject()], tasks: [] };
  installLinearFetch(t, [issue({ title: "Done upstream", stateType: "completed" })]);

  const result = await createLinearProvider({ apiKey: "token" }, deps).syncIn(store, makeIdx(store, deps), {});

  assert.equal(result.inbound.issues.seen, 1);
  assert.equal(result.inbound.completedTasks.markedDone, 0);
  assert.equal(store.tasks.length, 0);
});

test("Linear inbound sync still imports active issues", async (t) => {
  const deps = makeDeps();
  const store = { projects: [mappedProject()], tasks: [] };
  installLinearFetch(t, [issue({ title: "Active upstream", stateType: "unstarted" })]);

  const result = await createLinearProvider({ apiKey: "token" }, deps).syncIn(store, makeIdx(store, deps), {});

  assert.equal(result.inbound.issues.seen, 1);
  assert.equal(result.inbound.activeTasks.created, 1);
  assert.equal(store.tasks.length, 1);
  assert.equal(store.tasks[0].description, "Active upstream");
  assert.equal(store.tasks[0].status, "active");
});

test("Linear outbound sync does not create remote issues for already-completed local tasks", async (t) => {
  const deps = makeDeps();
  const project = mappedProject();
  const task = {
    id: "task-local",
    projectId: project.id,
    description: "Local done task",
    details: null,
    dueAt: "2026-05-08T00:00:00.000Z",
    status: "done",
    externalLinks: [],
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new Error("Linear should not be called for unlinked completed tasks");
  };

  await createLinearProvider({ apiKey: "token" }, deps).updateTask({
    task,
    patch: { ...task, project, externalLinks: [] },
  });

  assert.deepEqual(task.externalLinks, []);
});
