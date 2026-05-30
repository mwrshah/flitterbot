import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configuredProviders, syncLinearIntegration, syncTodoistIntegration } from "./integrations.mjs";

const STORE_VERSION = 2;
const DEFAULT_COMPLETED_RETENTION_DAYS = 90;
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 10;
let STORE_PATH;
let CONFIG_PATH;
const MIGRATION_NEEDED = Symbol("migrationNeeded");

function nowIso() {
  return new Date().toISOString();
}

function compactId() {
  return Array.from(crypto.randomBytes(ID_LENGTH), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

function emptyStore() {
  return { version: STORE_VERSION, updatedAt: nowIso(), projects: [], tasks: [] };
}

function readStore() {
  if (!fs.existsSync(STORE_PATH)) return emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    const normalized = normalizeStore(raw);
    Object.defineProperty(normalized, MIGRATION_NEEDED, {
      value: storeDataSignature(raw) !== storeDataSignature(normalized),
      enumerable: false,
    });
    return normalized;
  } catch (error) {
    throw new Error(`Task data could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeStore(store) {
  if (store[MIGRATION_NEEDED]) backupStoreBeforeMigration();
  const normalized = normalizeStore({ ...store, updatedAt: nowIso() });
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = path.join(path.dirname(STORE_PATH), `.tmp-${path.basename(STORE_PATH)}-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, STORE_PATH);
  return normalized;
}

function writeStoreIfChanged(store, beforeSignature) {
  if (!store[MIGRATION_NEEDED] && storeDataSignature(store) === beforeSignature) return store;
  return writeStore(store);
}

function backupStoreBeforeMigration() {
  if (!fs.existsSync(STORE_PATH)) return;
  const directory = path.dirname(STORE_PATH);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const backupPath = path.join(directory, `${path.basename(STORE_PATH)}.pre-external-links-migration-${stamp}.bak`);
  fs.copyFileSync(STORE_PATH, backupPath, fs.constants.COPYFILE_EXCL);
}

function storeDataSignature(store) {
  return JSON.stringify({ version: store?.version, projects: store?.projects, tasks: store?.tasks });
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
    externalLinks: normalizeProjectExternalLinks(value.externalLinks ?? value.external_links ?? [], value),
    createdAt: normalizeMaybeDate(value.createdAt, now),
    updatedAt: normalizeMaybeDate(value.updatedAt, now),
  };
}

function normalizeTask(input) {
  const value = input && typeof input === "object" ? input : {};
  const now = nowIso();
  return {
    id: stringOr(value.id, compactId()),
    projectId: stringOr(value.projectId, ""),
    description: stringOr(value.description, "").trim(),
    details: nullableTrim(value.details),
    dueAt: normalizeMaybeDate(value.dueAt, localTodayStartIso()),
    status: value.status === "done" ? "done" : "active",
    externalLinks: normalizeExternalLinks(value.externalLinks ?? value.external_links ?? [], "task"),
    createdAt: normalizeMaybeDate(value.createdAt, now),
    updatedAt: normalizeMaybeDate(value.updatedAt, now),
  };
}

function normalizeProjectExternalLinks(links, projectInput = {}) {
  const out = normalizeExternalLinks(links, "project");
  const teamId = optionalString(projectInput.linearTeamId ?? projectInput.linear_team_id);
  if (teamId) {
    setExternalLink(out, {
      system: "linear",
      teamId,
      projectId: optionalString(projectInput.linearProjectId ?? projectInput.linear_project_id) ?? null,
    });
  }
  return out;
}

function normalizeExternalLinks(links, recordKind) {
  if (!Array.isArray(links)) return [];
  const out = [];
  for (const input of links) {
    const link = normalizeExternalLink(input, recordKind);
    if (!link.system) continue;
    setExternalLink(out, link);
  }
  return out;
}

function normalizeExternalLink(input, recordKind) {
  if (!input || typeof input !== "object") return { system: "" };
  const system = typeof input.system === "string" ? normalizeName(input.system) : "";
  if (!system) return { system: "" };

  if (system === "todoist") {
    const idKey = recordKind === "project" ? "projectId" : "taskId";
    const id = optionalString(input[idKey] ?? input.externalId);
    const link = { system, ...(id ? { [idKey]: id } : {}) };
    addLinkUrl(link, input);
    return link;
  }

  if (system === "linear") {
    if (recordKind === "project") {
      const teamId = optionalString(input.teamId ?? input.team_id);
      const link = { system, ...(teamId ? { teamId, projectId: optionalString(input.projectId ?? input.project_id) ?? null } : {}) };
      return link;
    }
    const issueId = optionalString(input.issueId ?? input.issue_id ?? input.externalId);
    const link = { system, ...(issueId ? { issueId } : {}) };
    addLinkUrl(link, input);
    return link;
  }

  const link = { system };
  for (const [key, value] of Object.entries(input)) {
    if (key === "system") continue;
    if (typeof value === "string" && value.trim()) link[key] = value.trim();
    else if (typeof value === "number" || typeof value === "boolean" || value === null) link[key] = value;
  }
  return link;
}

function addLinkUrl(link, input) {
  if (typeof input.url === "string" && input.url.trim()) link.url = input.url.trim();
}

function indexes(store) {
  const projectsById = new Map(store.projects.map((project) => [project.id, project]));
  const projectsByName = new Map(store.projects.map((project) => [normalizeName(project.name), project]));
  const tasksById = new Map(store.tasks.map((task) => [task.id, task]));
  const tasksByProjectId = new Map();
  const tasksByExternal = new Map();
  const projectsByExternal = new Map();
  for (const project of store.projects) {
    for (const link of project.externalLinks) {
      const externalId = projectLinkExternalId(link);
      if (externalId) projectsByExternal.set(externalKey(link.system, externalId), project);
    }
  }
  for (const task of store.tasks) {
    const list = tasksByProjectId.get(task.projectId) ?? [];
    list.push(task);
    tasksByProjectId.set(task.projectId, list);
    for (const link of task.externalLinks) {
      const externalId = taskLinkExternalId(link);
      if (externalId) tasksByExternal.set(externalKey(link.system, externalId), task);
    }
  }
  return { projectsById, projectsByName, projectsByExternal, tasksById, tasksByProjectId, tasksByExternal };
}

export const TASK_ACTION_NAMES = [
  "list_projects",
  "create_project",
  "update_project",
  "list_tasks",
  "search_tasks",
  "get_task",
  "create_task",
  "update_task",
  "periodic_sync_and_cleanup",
];

export function createTaskActions({ storePath, configPath }) {
  STORE_PATH = storePath;
  CONFIG_PATH = configPath;
  return {
    async list_projects(input) {
      const { store } = taskContext();
      const projects = listProjects(store, input.include_archived_projects === true);
      return ok(`Found ${projects.length} project${projects.length === 1 ? "" : "s"}.`, { projects });
    },

    async create_project(input) {
      const { store, idx } = taskContext();
      const project = await createProjectWithProviders(store, idx, input);
      writeStore(store);
      return ok(`Created project "${project.name}".`, { project });
    },

    async update_project(input) {
      const { store, idx } = taskContext();
      const project = await updateProjectWithProviders(store, idx, input);
      writeStore(store);
      return ok(`Updated project "${project.name}".`, { project });
    },

    async list_tasks(input) {
      const { store, idx } = taskContext();
      const tasks = listTasks(store, idx, toListOptions(input));
      return ok(`Found ${tasks.length} task${tasks.length === 1 ? "" : "s"}.`, { tasks });
    },

    async search_tasks(input) {
      const { store, idx } = taskContext();
      const options = toSearchOptions(input);
      const tasks = searchTasks(store, idx, options);
      return ok(`Found ${tasks.length} task${tasks.length === 1 ? "" : "s"} matching "${options.query}".`, { tasks });
    },

    async get_task(input) {
      const { idx } = taskContext();
      const task = idx.tasksById.get(requiredString(input.task_id, "task_id"));
      if (!task) throw new Error("Task not found");
      return ok(`Found task "${task.description}".`, { task: toTaskItem(task, idx) });
    },

    async create_task(input) {
      const { store, idx } = taskContext();
      const task = await createTaskWithProviders(store, idx, input);
      writeStore(store);
      return ok(`Created task "${task.description}".`, { task: toTaskItem(task, indexes(store)) });
    },

    async update_task(input) {
      const { store, idx } = taskContext();
      const task = await updateTaskWithProviders(store, idx, input);
      writeStore(store);
      return ok(`Updated task "${task.description}".`, { task: toTaskItem(task, indexes(store)) });
    },

    async periodic_sync_and_cleanup(input) {
      const { store, idx } = taskContext();
      const beforeSignature = storeDataSignature(store);
      const syncContext = createSyncContext(store);
      const todoist = await syncTodoistIntegration(CONFIG_PATH, store, idx, input, providerDeps(syncContext));
      const linear = await syncLinearIntegration(CONFIG_PATH, store, idx, input, providerDeps(syncContext));
      const outbound = await propagateInboundTaskChanges(store, idx, syncContext);
      const cleanup = cleanupCompletedTasks(store, input);
      writeStoreIfChanged(store, beforeSignature);
      return ok(formatPeriodicSyncAndCleanupMessage({ todoist, linear, outbound, cleanup }), { todoist, linear, outbound, cleanup });
    },
  };
}

async function propagateInboundTaskChanges(store, idx, syncContext) {
  const providers = configuredProviders(CONFIG_PATH, providerDeps());
  const outbound = Object.fromEntries(providers.map((provider) => [provider.system, { created: 0, updated: 0 }]));
  for (const [recordId, sourceProvider] of syncContext.changedByProvider) {
    const task = idx.tasksById.get(recordId);
    if (!task) continue;
    const project = idx.projectsById.get(task.projectId);
    if (!project) continue;
    const baseline = syncContext.baselineTasks.get(recordId) ?? cloneTaskRecord(task);
    for (const provider of providers) {
      if (provider.system === sourceProvider) continue;
      const beforeLink = getExternalLink(task, provider.system);
      const patch = { ...cloneTaskRecord(task), project, externalLinks: task.externalLinks.map(cloneExternalLink) };
      try {
        await provider.updateTask({ store, idx, task: baseline, patch, force: true });
      } catch (error) {
        throw new Error(formatOutboundPropagationError(error, { task, baseline, project, sourceProvider, targetProvider: provider.system }));
      }
      const afterLink = getExternalLink({ externalLinks: patch.externalLinks }, provider.system);
      task.externalLinks = patch.externalLinks;
      indexTaskExternalLinks(idx, task);
      // No mapping before or after means this task was never a sync candidate for the
      // target provider (e.g. a Todoist-only Inbox task and Linear), so it is not a skip.
      if (!beforeLink && !afterLink) continue;
      if (afterLink && !beforeLink) outbound[provider.system].created++;
      else outbound[provider.system].updated++;
    }
  }
  return outbound;
}

function taskContext() {
  const store = readStore();
  return { store, idx: indexes(store) };
}

function createSyncContext(store) {
  return {
    baselineUpdatedAt: new Map([
      ...store.projects.map((project) => [project.id, project.updatedAt]),
      ...store.tasks.map((task) => [task.id, task.updatedAt]),
    ]),
    baselineTasks: new Map(store.tasks.map((task) => [task.id, cloneTaskRecord(task)])),
    changedByProvider: new Map(),
  };
}

function shouldApplyInbound(syncContext, record, remoteUpdatedAt, provider) {
  const link = getExternalLink(record, provider);
  const remoteBaseline = link?.remoteUpdatedAt;
  const baselineUpdatedAt = remoteBaseline ?? syncContext?.baselineUpdatedAt.get(record.id) ?? record.updatedAt;
  if (!remoteNewerThanLocal(remoteUpdatedAt, baselineUpdatedAt)) return false;
  const priorProvider = syncContext?.changedByProvider.get(record.id);
  if (priorProvider && priorProvider !== provider) return false;
  return true;
}

function markInboundApplied(syncContext, record, provider) {
  syncContext?.changedByProvider.set(record.id, provider);
}

function remoteNewerThanLocal(remoteUpdatedAt, localUpdatedAt) {
  if (!remoteUpdatedAt || !localUpdatedAt) return true;
  const remote = Date.parse(remoteUpdatedAt);
  const local = Date.parse(localUpdatedAt);
  if (Number.isNaN(remote) || Number.isNaN(local)) return true;
  return remote > local + 1000;
}

function cleanupCompletedTasks(store, input) {
  const days = Number(input.cleanup_days ?? input.completed_days ?? DEFAULT_COMPLETED_RETENTION_DAYS);
  const retentionDays = Number.isFinite(days) && days >= 0 ? days : DEFAULT_COMPLETED_RETENTION_DAYS;
  const cutoff = addDays(new Date(), -retentionDays).getTime();
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((task) => {
    if (task.status !== "done") return true;
    const updatedAt = Date.parse(task.updatedAt ?? "");
    if (Number.isNaN(updatedAt)) return true;
    return updatedAt >= cutoff;
  });
  return { removedTasks: before - store.tasks.length, retentionDays };
}

function formatOutboundPropagationError(error, { task, baseline, project, sourceProvider, targetProvider }) {
  const taskLabel = task.description ? `"${task.description}"` : task.id;
  const changes = describeTaskChanges(baseline, task);
  const detail = changes.length ? ` Changes: ${changes.join(", ")}.` : "";
  return `Failed to propagate ${sourceProvider} inbound change for task ${taskLabel} (${task.id}) in project "${project.name}" to ${targetProvider}.${detail} Cause: ${error?.message ?? String(error)}`;
}

function describeTaskChanges(before, after) {
  const changes = [];
  if (before.status !== after.status) changes.push(`status ${before.status} -> ${after.status}`);
  if (before.description !== after.description) changes.push(`description ${JSON.stringify(before.description)} -> ${JSON.stringify(after.description)}`);
  if ((before.details ?? null) !== (after.details ?? null)) changes.push("details changed");
  if (before.dueAt !== after.dueAt) changes.push(`dueAt ${before.dueAt} -> ${after.dueAt}`);
  if (before.projectId !== after.projectId) changes.push(`projectId ${before.projectId} -> ${after.projectId}`);
  return changes;
}

function formatPeriodicSyncAndCleanupMessage({ todoist, linear, outbound, cleanup }) {
  return [
    "Periodic sync and cleanup finished.",
    formatProviderSyncLine("Todoist", todoist, outbound?.todoist),
    formatProviderSyncLine("Linear", linear, outbound?.linear),
    formatCleanupLine(cleanup),
  ].join("\n");
}

function formatProviderSyncLine(providerName, result, outwardStats) {
  const outward = formatOutwardStats(outwardStats);
  if (result.skipped) return `- ${providerName}: inward skipped${result.reason ? ` (${formatSkipReason(result.reason)})` : ""}; ${outward}.`;
  const stats = providerName === "Todoist" ? todoistInwardTotals(result.inbound) : linearInwardTotals(result.inbound);
  return `- ${providerName}: ${stats.created} created inward, ${stats.updated} updated inward, ${stats.linked} linked inward; ${outward}.`;
}

function formatOutwardStats(stats) {
  if (!stats) return "outward not run";
  return `${stats.created} created outward, ${stats.updated} updated outward`;
}

function todoistInwardTotals(inbound) {
  return {
    created: inbound.projects.created + inbound.activeTasks.created,
    updated: inbound.projects.updated + inbound.activeTasks.updated + inbound.completedTasks.markedDone,
    linked: inbound.projects.linked + inbound.activeTasks.linked + inbound.completedTasks.linked,
  };
}

function linearInwardTotals(inbound) {
  return {
    created: inbound.activeTasks.created,
    updated: inbound.activeTasks.updated + inbound.completedTasks.markedDone,
    linked: inbound.activeTasks.linked + inbound.completedTasks.linked,
  };
}

function formatCleanupLine(cleanup) {
  return `- Cleanup: removed ${cleanup.removedTasks} completed ${plural("task", cleanup.removedTasks)} older than ${cleanup.retentionDays} days.`;
}

function formatSkipReason(reason) {
  if (reason === "no_api_key") return "no API key configured";
  if (reason === "no_project_mapping") return "no active project has a Linear team mapping";
  return String(reason).replaceAll("_", " ");
}

function plural(word, count) {
  return count === 1 ? word : `${word}s`;
}

function listProjects(store, includeArchived) {
  return store.projects
    .filter((project) => includeArchived || !project.archived)
    .sort(compareProjects)
    .map((project) => cloneProject(project));
}

async function createProjectWithProviders(store, idx, input) {
  const trimmed = requiredString(input.project_name, "project_name").trim();
  if (!trimmed) throw new Error("project_name is required");
  assertProjectNameAvailable(idx, trimmed);

  const links = normalizeProjectExternalLinks(input.external_links ?? []);
  for (const provider of configuredProviders(CONFIG_PATH, providerDeps())) {
    const link = await provider.createProject({ name: trimmed, links });
    if (link) setExternalLink(links, link);
  }

  const now = nowIso();
  const project = {
    id: uniqueId(idx, "projects"),
    name: trimmed,
    archived: false,
    externalLinks: links,
    createdAt: now,
    updatedAt: now,
  };
  store.projects.push(project);
  idx.projectsById.set(project.id, project);
  idx.projectsByName.set(normalizeName(project.name), project);
  for (const link of links) {
    const externalId = projectLinkExternalId(link);
    if (externalId) idx.projectsByExternal.set(externalKey(link.system, externalId), project);
  }
  return project;
}

async function updateProjectWithProviders(store, idx, input) {
  const project = resolveProject(idx, input.project_id, input.project_name_current ?? input.current_project_name ?? input.project_name);
  const nextName = typeof input.project_name === "string" && input.project_name.trim() ? input.project_name.trim() : undefined;
  const nextArchived = typeof input.project_archived === "boolean" ? input.project_archived : undefined;

  const patch = {
    name: nextName,
    archived: nextArchived,
    externalLinks: projectPatchExternalLinks(project, input),
  };
  for (const provider of configuredProviders(CONFIG_PATH, providerDeps())) {
    await provider.updateProject({ project, patch });
  }

  if (nextName && normalizeName(nextName) !== normalizeName(project.name)) {
    assertProjectNameAvailable(idx, nextName, project.id);
    project.name = nextName;
  }
  if (nextArchived !== undefined) project.archived = nextArchived;
  project.externalLinks = patch.externalLinks;
  project.updatedAt = nowIso();
  return project;
}

function createProject(store, idx, name) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("project_name is required");
  assertProjectNameAvailable(idx, trimmed);
  const now = nowIso();
  const project = { id: uniqueId(idx, "projects"), name: trimmed, archived: false, externalLinks: [], createdAt: now, updatedAt: now };
  store.projects.push(project);
  idx.projectsById.set(project.id, project);
  idx.projectsByName.set(normalizeName(project.name), project);
  return project;
}

function upsertProject(store, idx, name) {
  const existing = idx.projectsByName.get(normalizeName(name));
  return existing ?? createProject(store, idx, name);
}

function projectPatchExternalLinks(project, input) {
  return input.external_links !== undefined
    ? normalizeProjectExternalLinks(input.external_links)
    : project.externalLinks.map(cloneExternalLink);
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

async function createTaskWithProviders(store, idx, input) {
  const project = typeof input.project_id === "string" && input.project_id.trim()
    ? resolveProject(idx, input.project_id, undefined)
    : upsertProject(store, idx, optionalString(input.project_name) ?? "Inbox");
  const description = requiredString(input.description, "description").trim();
  const details = nullableTrim(input.details);
  const dueAt = resolveDueAt(input.due_at, input.due_in_days);
  const links = normalizeExternalLinks(input.external_links ?? [], "task");
  for (const provider of configuredProviders(CONFIG_PATH, providerDeps())) {
    await provider.createTask({ store, idx, project, description, details, dueAt, links });
  }

  const now = nowIso();
  const task = {
    id: uniqueId(idx, "tasks"),
    projectId: project.id,
    description,
    details,
    dueAt,
    status: "active",
    externalLinks: links,
    createdAt: now,
    updatedAt: now,
  };
  store.tasks.push(task);
  return task;
}

async function updateTaskWithProviders(store, idx, input) {
  const task = idx.tasksById.get(requiredString(input.task_id, "task_id"));
  if (!task) throw new Error("Task not found");
  const project = input.project_id || input.project_name
    ? (input.project_id ? resolveProject(idx, input.project_id, undefined) : upsertProject(store, idx, input.project_name))
    : idx.projectsById.get(task.projectId);
  if (!project) throw new Error("Project not found");

  const patch = {
    project,
    description: input.description !== undefined ? requiredString(input.description, "description").trim() : task.description,
    details: input.details !== undefined ? nullableTrim(input.details) : task.details,
    dueAt: input.due_at !== undefined || input.due_in_days !== undefined ? resolveDueAt(input.due_at, input.due_in_days) : task.dueAt,
    status: input.status !== undefined && input.status !== "any" ? normalizeStatus(input.status) : task.status,
    externalLinks: input.external_links !== undefined ? normalizeExternalLinks(input.external_links, "task") : task.externalLinks.map(cloneExternalLink),
  };

  for (const provider of configuredProviders(CONFIG_PATH, providerDeps())) {
    await provider.updateTask({ store, idx, task, patch });
  }

  Object.assign(task, {
    description: patch.description,
    details: patch.details,
    dueAt: patch.dueAt,
    status: patch.status,
    externalLinks: patch.externalLinks,
    projectId: patch.project.id,
    updatedAt: nowIso(),
  });
  return task;
}

function listTasks(store, idx, options) {
  return filterTasks(store, idx, options)
    .map((task) => toTaskItem(task, idx))
    .sort(compareTaskItems);
}

function searchTasks(store, idx, options) {
  const limit = normalizeLimit(options.limit);
  const matches = filterTasks(store, idx, options)
    .map((task) => {
      const item = toTaskItem(task, idx);
      return { item, score: searchTaskScore(item, options.query) };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || compareTaskItems(a.item, b.item));
  return matches.slice(0, limit ?? matches.length).map((match) => match.item);
}

function filterTasks(store, idx, options) {
  const projectNameKey = options.projectName ? normalizeName(options.projectName) : undefined;
  const project = projectNameKey ? idx.projectsByName.get(projectNameKey) : undefined;
  const candidates = options.projectId
    ? (idx.tasksByProjectId.get(options.projectId) ?? [])
    : projectNameKey
      ? project ? (idx.tasksByProjectId.get(project.id) ?? []) : []
      : store.tasks;
  const range = buildRange(options);
  const status = options.status ?? "active";
  return candidates.filter((task) => {
    const taskProject = idx.projectsById.get(task.projectId);
    if (!taskProject) return false;
    if (!options.includeArchivedProjects && taskProject.archived) return false;
    if (status !== "any" && task.status !== status) return false;
    return taskMatchesRange(task, range);
  });
}

function searchTaskScore(task, rawQuery) {
  const query = normalizeSearchText(rawQuery);
  if (!query) return 0;
  const tokens = query.split(" ").filter(Boolean);
  const fields = [
    { text: normalizeSearchText(task.description), phraseWeight: 100, tokenWeight: 10 },
    { text: normalizeSearchText(task.details), phraseWeight: 60, tokenWeight: 6 },
    { text: normalizeSearchText(task.projectName), phraseWeight: 40, tokenWeight: 4 },
  ];
  if (!tokens.every((token) => fields.some((field) => field.text.includes(token)))) return 0;

  let score = 0;
  for (const field of fields) {
    if (field.text === query) score += field.phraseWeight * 2;
    else if (field.text.includes(query)) score += field.phraseWeight;
    for (const token of tokens) {
      if (field.text.includes(token)) score += field.tokenWeight;
    }
  }
  return score;
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit < 1) throw new Error("limit must be a positive number");
  return Math.trunc(limit);
}

function toTaskItem(task, idx) {
  const project = idx.projectsById.get(task.projectId);
  if (!project) throw new Error("Project not found");
  return { ...task, externalLinks: task.externalLinks.map(cloneExternalLink), projectName: project.name };
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

function toSearchOptions(input) {
  return {
    ...toListOptions(input),
    query: requiredString(input.query ?? input.q ?? input.search, "query").trim(),
    limit: input.limit,
  };
}

function providerDeps(syncContext) {
  return {
    addDays,
    cloneExternalLink,
    createProject,
    externalKey,
    getExternalLink,
    localDateKey,
    localTodayStartIso,
    normalizeMaybeDate,
    normalizeName,
    nullableTrim,
    optionalString,
    nowIso,
    remoteNewerThanLocal,
    shouldApplyInbound: (record, remoteUpdatedAt, provider) => shouldApplyInbound(syncContext, record, remoteUpdatedAt, provider),
    markInboundApplied: (record, provider) => markInboundApplied(syncContext, record, provider),
    uniqueId,
    setExternalLink,
  };
}

function getExternalLink(item, system) {
  return item.externalLinks?.find((link) => normalizeName(link.system) === normalizeName(system));
}

function setExternalLink(recordOrLinks, nextLink) {
  const links = Array.isArray(recordOrLinks) ? recordOrLinks : recordOrLinks.externalLinks;
  const index = links.findIndex((link) => normalizeName(link.system) === normalizeName(nextLink.system));
  links[index >= 0 ? index : links.length] = nextLink;
}

function projectLinkExternalId(link) {
  return normalizeName(link.system) === "todoist" ? link.projectId : link.externalId ?? link.id;
}

function taskLinkExternalId(link) {
  return { todoist: link.taskId, linear: link.issueId }[normalizeName(link.system)] ?? link.externalId ?? link.id;
}

function externalKey(system, externalId) {
  return `${normalizeName(system)}:${String(externalId ?? "")}`;
}

function cloneProject(project) {
  return { ...project, externalLinks: project.externalLinks.map(cloneExternalLink) };
}

function cloneTaskRecord(task) {
  return { ...task, externalLinks: task.externalLinks.map(cloneExternalLink) };
}

function indexTaskExternalLinks(idx, task) {
  for (const link of task.externalLinks) {
    const externalId = taskLinkExternalId(link);
    if (externalId) idx.tasksByExternal.set(externalKey(link.system, externalId), task);
  }
}

function cloneExternalLink(link) {
  return { ...link };
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

function localDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
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

