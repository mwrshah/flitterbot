import assert from "node:assert/strict";
import test from "node:test";
import { createTodoistProvider } from "./todoist-provider.mjs";

const TODOIST_BASE = "https://api.todoist.com/api/v1";

function makeDeps(now = "2026-05-10T10:30:00.000Z") {
  return {
    addDays(date, days) {
      const next = new Date(date);
      next.setDate(next.getDate() + days);
      return next;
    },
    createProject(store, idx, name) {
      const project = {
        id: `project-${store.projects.length + 1}`,
        name,
        archived: false,
        externalLinks: [],
        updatedAt: now,
      };
      store.projects.push(project);
      idx.projectsByName.set(this.normalizeName(name), project);
      return project;
    },
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
    nullableTrim(value) {
      if (value == null) return null;
      const trimmed = String(value).trim();
      return trimmed || null;
    },
    nowIso() {
      return now;
    },
    optionalString(value) {
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  const projectsByExternal = new Map();
  const projectsByName = new Map();
  const tasksByExternal = new Map();
  const tasksById = new Map();
  for (const project of store.projects) {
    projectsByName.set(deps.normalizeName(project.name), project);
    for (const link of project.externalLinks) projectsByExternal.set(deps.externalKey(link.system, link.externalId), project);
  }
  for (const task of store.tasks) {
    tasksById.set(task.id, task);
    for (const link of task.externalLinks) tasksByExternal.set(deps.externalKey(link.system, link.externalId), task);
  }
  return { projectsByExternal, projectsByName, tasksByExternal, tasksById };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("Todoist inbound sync marks existing local tasks done from completed history", async (t) => {
  const deps = makeDeps();
  const project = { id: "project-local", name: "Inbox", archived: false, externalLinks: [{ system: "todoist", externalId: "project-remote" }], updatedAt: "2026-05-01T00:00:00.000Z" };
  const task = {
    id: "task-local",
    projectId: project.id,
    description: "Completed upstream",
    details: null,
    dueAt: "2026-05-10T00:00:00.000Z",
    status: "active",
    externalLinks: [{ system: "todoist", externalId: "todoist-task" }],
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
  const store = { projects: [project], tasks: [task] };
  const idx = makeIdx(store, deps);
  const completedRequests = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.href === `${TODOIST_BASE}/projects`) return jsonResponse({ results: [{ id: "project-remote", name: "Inbox", is_deleted: false, is_archived: false, updated_at: "2026-05-09T00:00:00.000Z" }], next_cursor: null });
    if (parsed.href === `${TODOIST_BASE}/tasks`) return jsonResponse({ results: [], next_cursor: null });
    if (parsed.pathname === "/api/v1/tasks/completed/by_completion_date") {
      completedRequests.push(parsed);
      return jsonResponse({
        items: [{ id: "todoist-task", content: "Completed upstream", description: "", project_id: "project-remote", completed_at: "2026-05-09T12:00:00.000Z", updated_at: "2026-05-09T12:00:00.000Z" }],
        next_cursor: null,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await createTodoistProvider({ apiKey: "token" }, deps).syncIn(store, idx, { completed_since: "2026-02-10" });

  assert.equal(result.inbound.completedTasks.seen, 1);
  assert.equal(result.inbound.completedTasks.markedDone, 1);
  assert.equal(task.status, "done");
  assert.equal(task.updatedAt, "2026-05-10T10:30:00.000Z");
  assert.equal(completedRequests.length, 1);
  assert.equal(completedRequests[0].searchParams.get("since"), "2026-02-10T00:00:00.000Z");
  assert.equal(completedRequests[0].searchParams.get("until"), "2026-05-10T10:30:00.000Z");
});

test("Todoist inbound sync does not import completed tasks absent locally", async (t) => {
  const deps = makeDeps();
  const project = { id: "project-local", name: "Inbox", archived: false, externalLinks: [{ system: "todoist", externalId: "project-remote" }], updatedAt: "2026-05-01T00:00:00.000Z" };
  const store = { projects: [project], tasks: [] };
  const idx = makeIdx(store, deps);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.href === `${TODOIST_BASE}/projects`) return jsonResponse({ results: [{ id: "project-remote", name: "Inbox", is_deleted: false, is_archived: false, updated_at: "2026-05-09T00:00:00.000Z" }], next_cursor: null });
    if (parsed.href === `${TODOIST_BASE}/tasks`) return jsonResponse({ results: [], next_cursor: null });
    if (parsed.pathname === "/api/v1/tasks/completed/by_completion_date") {
      return jsonResponse({
        items: [{ id: "todoist-task", content: "Completed upstream", description: "", project_id: "project-remote", completed_at: "2026-05-09T12:00:00.000Z", updated_at: "2026-05-09T12:00:00.000Z" }],
        next_cursor: null,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await createTodoistProvider({ apiKey: "token" }, deps).syncIn(store, idx, {});

  assert.equal(result.inbound.completedTasks.seen, 1);
  assert.equal(result.inbound.completedTasks.markedDone, 0);
  assert.equal(store.tasks.length, 0);
});

test("Todoist active inbound sync still imports active tasks", async (t) => {
  const deps = makeDeps();
  const store = { projects: [], tasks: [] };
  const idx = makeIdx(store, deps);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.href === `${TODOIST_BASE}/projects`) {
      return jsonResponse({ results: [{ id: "project-remote", name: "Inbox", is_deleted: false, is_archived: false, updated_at: "2026-05-09T00:00:00.000Z" }], next_cursor: null });
    }
    if (parsed.href === `${TODOIST_BASE}/tasks`) {
      return jsonResponse({
        results: [{ id: "todoist-task", content: "Active upstream", description: "", project_id: "project-remote", due: { date: "2026-05-10" }, is_deleted: false, updated_at: "2026-05-09T00:00:00.000Z", added_at: "2026-05-09T00:00:00.000Z" }],
        next_cursor: null,
      });
    }
    if (parsed.pathname === "/api/v1/tasks/completed/by_completion_date") return jsonResponse({ items: [], next_cursor: null });
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await createTodoistProvider({ apiKey: "token" }, deps).syncIn(store, idx, {});

  assert.equal(result.inbound.activeTasks.seen, 1);
  assert.equal(result.inbound.activeTasks.created, 1);
  assert.equal(store.tasks.length, 1);
  assert.equal(store.tasks[0].description, "Active upstream");
  assert.equal(store.tasks[0].status, "active");
});
