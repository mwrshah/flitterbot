#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE_VERSION = 1;
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 10;
const DEFAULT_STORE_PATH = path.join(os.homedir(), ".flitterbot", "tasks", "tasks.json");
const STORE_PATH = process.env.FLITTERBOT_TASKS_FILE || DEFAULT_STORE_PATH;

function nowIso() {
  return new Date().toISOString();
}

function compactId() {
  let out = "";
  const bytes = crypto.randomBytes(ID_LENGTH);
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

function emptyStore() {
  return { version: STORE_VERSION, updatedAt: nowIso(), projects: [], tasks: [] };
}

function readStore() {
  if (!fs.existsSync(STORE_PATH)) return emptyStore();
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(STORE_PATH, "utf8")));
  } catch (error) {
    throw new Error(`Task data could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeStore(store) {
  const normalized = normalizeStore({ ...store, updatedAt: nowIso() });
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = path.join(path.dirname(STORE_PATH), `.tmp-${path.basename(STORE_PATH)}-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, STORE_PATH);
  return normalized;
}

function normalizeStore(input) {
  if (!input || typeof input !== "object") return emptyStore();
  const projects = Array.isArray(input.projects) ? input.projects.map(normalizeProject) : [];
  const projectIds = new Set();
  const projectNames = new Set();
  const cleanProjects = [];
  for (const project of projects) {
    if (!project.id || !project.name) continue;
    const nameKey = normalizeName(project.name);
    if (projectIds.has(project.id) || projectNames.has(nameKey)) continue;
    projectIds.add(project.id);
    projectNames.add(nameKey);
    cleanProjects.push(project);
  }

  const taskIds = new Set();
  const cleanTasks = [];
  const tasks = Array.isArray(input.tasks) ? input.tasks.map(normalizeTask) : [];
  for (const task of tasks) {
    if (!task.id || !task.description || !projectIds.has(task.projectId)) continue;
    if (taskIds.has(task.id)) continue;
    taskIds.add(task.id);
    cleanTasks.push(task);
  }

  cleanProjects.sort(compareProjects);
  cleanTasks.sort(compareStoredTasks);
  return {
    version: STORE_VERSION,
    updatedAt: normalizeMaybeDate(input.updatedAt, nowIso()),
    projects: cleanProjects,
    tasks: cleanTasks,
  };
}

function normalizeProject(input) {
  const value = input && typeof input === "object" ? input : {};
  const now = nowIso();
  return {
    id: stringOr(value.id, compactId()),
    name: stringOr(value.name, "Inbox").trim() || "Inbox",
    archived: value.archived === true,
    createdAt: normalizeMaybeDate(value.createdAt, now),
    updatedAt: normalizeMaybeDate(value.updatedAt, now),
  };
}

function normalizeTask(input) {
  const value = input && typeof input === "object" ? input : {};
  const now = nowIso();
  const status = value.status === "done" ? "done" : "active";
  return {
    id: stringOr(value.id, compactId()),
    projectId: stringOr(value.projectId, ""),
    description: stringOr(value.description, "").trim(),
    details: nullableTrim(value.details),
    dueAt: normalizeMaybeDate(value.dueAt, localTodayStartIso()),
    status,
    externalLinks: normalizeExternalLinks(value.externalLinks ?? value.external_links ?? []),
    createdAt: normalizeMaybeDate(value.createdAt, now),
    updatedAt: normalizeMaybeDate(value.updatedAt, now),
    completedAt: status === "done" ? normalizeMaybeDate(value.completedAt, now) : null,
  };
}

function normalizeExternalLinks(links) {
  if (!Array.isArray(links)) return [];
  return links.map(normalizeExternalLink).filter((link) => link.system);
}

function normalizeExternalLink(input) {
  if (!input || typeof input !== "object") return { system: "" };
  const link = { system: typeof input.system === "string" ? input.system.trim() : "" };
  if (typeof input.externalId === "string" && input.externalId.trim()) link.externalId = input.externalId.trim();
  if (typeof input.url === "string" && input.url.trim()) link.url = input.url.trim();
  if (typeof input.syncedAt === "string" && input.syncedAt.trim()) link.syncedAt = normalizeDateTime(input.syncedAt);
  if (input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)) link.metadata = input.metadata;
  return link;
}

function indexes(store) {
  const projectsById = new Map(store.projects.map((project) => [project.id, project]));
  const projectsByName = new Map(store.projects.map((project) => [normalizeName(project.name), project]));
  const tasksById = new Map(store.tasks.map((task) => [task.id, task]));
  const tasksByProjectId = new Map();
  for (const task of store.tasks) {
    const list = tasksByProjectId.get(task.projectId) ?? [];
    list.push(task);
    tasksByProjectId.set(task.projectId, list);
  }
  return { projectsById, projectsByName, tasksById, tasksByProjectId };
}

function execute(input) {
  const action = input.action;
  const store = readStore();
  const idx = indexes(store);

  switch (action) {
    case "list_projects": {
      const projects = listProjects(store, input.include_archived_projects === true);
      return ok(`Found ${projects.length} project${projects.length === 1 ? "" : "s"}.`, { projects });
    }
    case "create_project": {
      const project = createProject(store, idx, requiredString(input.project_name, "project_name"));
      writeStore(store);
      return ok(`Created project "${project.name}".`, { project });
    }
    case "update_project": {
      const project = resolveProject(idx, input.project_id, input.project_name);
      if (typeof input.project_name === "string" && input.project_name.trim() && normalizeName(input.project_name) !== normalizeName(project.name)) {
        assertProjectNameAvailable(idx, input.project_name, project.id);
        project.name = input.project_name.trim();
      }
      if (typeof input.project_archived === "boolean") project.archived = input.project_archived;
      project.updatedAt = nowIso();
      writeStore(store);
      return ok(`Updated project "${project.name}".`, { project });
    }
    case "list_tasks": {
      const tasks = listTasks(store, idx, toListOptions(input));
      return ok(`Found ${tasks.length} task${tasks.length === 1 ? "" : "s"}.`, { tasks });
    }
    case "get_task": {
      const task = idx.tasksById.get(requiredString(input.task_id, "task_id"));
      if (!task) throw new Error("Task not found");
      return ok(`Found task "${task.description}".`, { task: toTaskItem(task, idx) });
    }
    case "create_task": {
      const project = typeof input.project_id === "string" && input.project_id.trim()
        ? resolveProject(idx, input.project_id, undefined)
        : upsertProject(store, idx, optionalString(input.project_name) ?? "Inbox");
      const now = nowIso();
      const task = {
        id: uniqueId(idx, "tasks"),
        projectId: project.id,
        description: requiredString(input.description, "description").trim(),
        details: nullableTrim(input.details),
        dueAt: resolveDueAt(input.due_at, input.due_in_days),
        status: "active",
        externalLinks: normalizeExternalLinks(input.external_links ?? []),
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      store.tasks.push(task);
      writeStore(store);
      return ok(`Created task "${task.description}".`, { task: toTaskItem(task, indexes(store)) });
    }
    case "update_task": {
      const task = idx.tasksById.get(requiredString(input.task_id, "task_id"));
      if (!task) throw new Error("Task not found");
      const project = input.project_id || input.project_name
        ? (input.project_id ? resolveProject(idx, input.project_id, undefined) : upsertProject(store, idx, input.project_name))
        : idx.projectsById.get(task.projectId);
      if (!project) throw new Error("Project not found");
      if (input.description !== undefined) task.description = requiredString(input.description, "description").trim();
      if (input.details !== undefined) task.details = nullableTrim(input.details);
      if (input.due_at !== undefined || input.due_in_days !== undefined) task.dueAt = resolveDueAt(input.due_at, input.due_in_days);
      if (input.status !== undefined && input.status !== "any") task.status = normalizeStatus(input.status);
      if (input.external_links !== undefined) task.externalLinks = normalizeExternalLinks(input.external_links);
      task.projectId = project.id;
      task.completedAt = task.status === "done" ? (task.completedAt ?? nowIso()) : null;
      task.updatedAt = nowIso();
      writeStore(store);
      return ok(`Updated task "${task.description}".`, { task: toTaskItem(task, indexes(store)) });
    }
    default:
      throw new Error(`Unknown action: ${String(action)}`);
  }
}

function listProjects(store, includeArchived) {
  return store.projects
    .filter((project) => includeArchived || !project.archived)
    .sort(compareProjects)
    .map((project) => ({ ...project }));
}

function createProject(store, idx, name) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("project_name is required");
  assertProjectNameAvailable(idx, trimmed);
  const now = nowIso();
  const project = { id: uniqueId(idx, "projects"), name: trimmed, archived: false, createdAt: now, updatedAt: now };
  store.projects.push(project);
  idx.projectsById.set(project.id, project);
  idx.projectsByName.set(normalizeName(project.name), project);
  return project;
}

function upsertProject(store, idx, name) {
  const existing = idx.projectsByName.get(normalizeName(name));
  return existing ?? createProject(store, idx, name);
}

function assertProjectNameAvailable(idx, name, exceptProjectId) {
  const existing = idx.projectsByName.get(normalizeName(name));
  if (existing && existing.id !== exceptProjectId) throw new Error("Project already exists");
}

function resolveProject(idx, id, name) {
  if (typeof id === "string" && id.trim()) {
    const project = idx.projectsById.get(id);
    if (!project) throw new Error("Project not found");
    return project;
  }
  if (typeof name === "string" && name.trim()) {
    const project = idx.projectsByName.get(normalizeName(name));
    if (!project) throw new Error("Project not found");
    return project;
  }
  throw new Error("project_id or project_name is required");
}

function listTasks(store, idx, options) {
  const projectNameKey = options.projectName ? normalizeName(options.projectName) : undefined;
  const project = projectNameKey ? idx.projectsByName.get(projectNameKey) : undefined;
  const candidates = options.projectId
    ? (idx.tasksByProjectId.get(options.projectId) ?? [])
    : projectNameKey
      ? project ? (idx.tasksByProjectId.get(project.id) ?? []) : []
      : store.tasks;
  const range = buildRange(options);
  const status = options.status ?? "active";
  return candidates
    .filter((task) => {
      const taskProject = idx.projectsById.get(task.projectId);
      if (!taskProject) return false;
      if (!options.includeArchivedProjects && taskProject.archived) return false;
      if (status !== "any" && task.status !== status) return false;
      return taskMatchesRange(task, range);
    })
    .map((task) => toTaskItem(task, idx))
    .sort(compareTaskItems);
}

function toTaskItem(task, idx) {
  const project = idx.projectsById.get(task.projectId);
  if (!project) throw new Error("Project not found");
  return { ...task, externalLinks: task.externalLinks.map((link) => ({ ...link })), projectName: project.name };
}

function toListOptions(input) {
  return {
    projectId: optionalString(input.project_id),
    projectName: optionalString(input.project_name),
    status: input.status ?? "active",
    includeArchivedProjects: input.include_archived_projects === true,
    preset: input.preset,
    days: input.days,
    startDate: optionalString(input.start_date),
    endDate: optionalString(input.end_date),
    startAt: optionalString(input.start_at),
    endAt: optionalString(input.end_at),
  };
}

function buildRange(options) {
  const preset = options.preset ?? (options.startDate || options.endDate || options.startAt || options.endAt ? "between" : "all");
  if (preset === "all") return { kind: "none" };
  const today = localTodayStart();
  if (preset === "overdue") return { kind: "lt", before: today.toISOString() };
  if (preset === "today") return dateWindow(today, 1);
  if (preset === "tomorrow") return dateWindow(addDays(today, 1), 1);
  if (preset === "next_days") return dateWindow(today, Math.max(1, Math.trunc(Number(options.days ?? 7))));
  if (preset !== "between") throw new Error("Unknown range preset");

  if (options.startDate || options.endDate) {
    const start = localDateStart(options.startDate ?? options.endDate);
    const end = localDateStart(options.endDate ?? options.startDate);
    return { kind: "date-window", startInclusive: start.toISOString(), endExclusive: addDays(end, 1).toISOString() };
  }

  const start = normalizeDateTime(options.startAt ?? options.endAt ?? nowIso());
  const end = normalizeDateTime(options.endAt ?? options.startAt ?? nowIso());
  return { kind: "between", start, end };
}

function taskMatchesRange(task, range) {
  if (range.kind === "none") return true;
  if (range.kind === "lt") return task.dueAt < range.before;
  if (range.kind === "between") return task.dueAt >= range.start && task.dueAt <= range.end;
  return task.dueAt >= range.startInclusive && task.dueAt < range.endExclusive;
}

function dateWindow(start, days) {
  return { kind: "date-window", startInclusive: start.toISOString(), endExclusive: addDays(start, days).toISOString() };
}

function resolveDueAt(dueAt, dueInDays) {
  if (typeof dueAt === "string" && dueAt.trim()) return normalizeDateTime(dueAt);
  if (dueInDays !== undefined && dueInDays !== null) {
    const offset = Number(dueInDays);
    if (!Number.isFinite(offset)) throw new Error("due_in_days must be finite");
    const date = new Date();
    date.setDate(date.getDate() + Math.trunc(offset));
    return date.toISOString();
  }
  return localTodayStartIso();
}

function normalizeDateTime(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error("Date/time value is required");
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return localDateStart(trimmed).toISOString();
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date/time");
  return date.toISOString();
}

function normalizeMaybeDate(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return normalizeDateTime(value);
  } catch {
    return fallback;
  }
}

function localTodayStartIso() {
  return localTodayStart().toISOString();
}

function localTodayStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function localDateStart(dateText) {
  const [year, month, day] = String(dateText ?? "").split("-").map((part) => Number(part));
  if (!year || !month || !day) throw new Error("Invalid date");
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function nullableTrim(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizeName(name) {
  return String(name ?? "").trim().toLocaleLowerCase();
}

function normalizeStatus(status) {
  if (status === "active" || status === "done") return status;
  throw new Error("status must be active or done");
}

function uniqueId(idx, kind) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = compactId();
    if (kind === "projects" && !idx.projectsById.has(id)) return id;
    if (kind === "tasks" && !idx.tasksById.has(id)) return id;
  }
  throw new Error("Could not generate id");
}

function compareProjects(a, b) {
  return Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name);
}

function compareStoredTasks(a, b) {
  return a.dueAt.localeCompare(b.dueAt) || a.createdAt.localeCompare(b.createdAt);
}

function compareTaskItems(a, b) {
  return a.dueAt.localeCompare(b.dueAt) || a.projectName.localeCompare(b.projectName) || a.createdAt.localeCompare(b.createdAt);
}

function ok(message, data) {
  return { ok: true, message, ...data };
}

async function readInput() {
  const arg = process.argv[2];
  if (arg && arg !== "-") return arg;
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (process.argv.includes("--help")) {
  console.log(`Usage:
  node scripts/tasks.mjs '{"action":"list_tasks","preset":"today"}'
  echo '{"action":"create_task","project_name":"Inbox","description":"Follow up"}' | node scripts/tasks.mjs -

Actions: list_projects, create_project, update_project, list_tasks, get_task, create_task, update_task`);
  process.exit(0);
}

try {
  const raw = await readInput();
  const input = raw.trim() ? JSON.parse(raw) : { action: "list_tasks" };
  console.log(JSON.stringify(execute(input), null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
