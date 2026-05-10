const TODOIST_API = "https://api.todoist.com/api/v1";
const TODOIST_SYSTEM = "todoist";

export function createTodoistProvider(config, deps) {
  const todoist = todoistClient(config.apiKey);

  return {
    system: TODOIST_SYSTEM,

    async syncIn(store, idx, input) {
      const remoteProjects = await todoist.listProjects();
      const remoteActiveProjects = remoteProjects.filter((project) => !project.is_deleted && !project.is_archived);
      assertFlattenableProjectNames(remoteActiveProjects, deps);

      for (const remoteProject of remoteActiveProjects) {
        const project = idx.projectsByExternal.get(deps.externalKey(TODOIST_SYSTEM, remoteProject.id))
          ?? idx.projectsByName.get(deps.normalizeName(remoteProject.name))
          ?? deps.createProject(store, idx, remoteProject.name);
        const link = deps.getExternalLink(project, TODOIST_SYSTEM);
        if (link?.externalId && !deps.shouldApplyInbound(project, remoteProject.updated_at, TODOIST_SYSTEM)) continue;
        project.name = remoteProject.name;
        project.archived = false;
        project.updatedAt = deps.nowIso();
        deps.markInboundApplied(project, TODOIST_SYSTEM);
        deps.upsertExternalLink(project.externalLinks, todoistProjectLink(remoteProject, deps));
        idx.projectsByName.set(deps.normalizeName(project.name), project);
        idx.projectsByExternal.set(deps.externalKey(TODOIST_SYSTEM, remoteProject.id), project);
      }

      const activeTasks = await todoist.listTasks();
      const seenTodoistTaskIds = new Set();
      for (const remoteTask of activeTasks.filter((task) => !task.is_deleted)) {
        seenTodoistTaskIds.add(remoteTask.id);
        const remoteProject = remoteProjects.find((project) => project.id === remoteTask.project_id);
        const projectName = remoteProject?.name ?? "Inbox";
        const project = idx.projectsByExternal.get(deps.externalKey(TODOIST_SYSTEM, remoteTask.project_id))
          ?? idx.projectsByName.get(deps.normalizeName(projectName))
          ?? deps.createProject(store, idx, projectName);
        if (remoteProject) {
          const projectLink = deps.getExternalLink(project, TODOIST_SYSTEM);
          if (!projectLink?.externalId || deps.shouldApplyInbound(project, remoteProject.updated_at, TODOIST_SYSTEM)) deps.upsertExternalLink(project.externalLinks, todoistProjectLink(remoteProject));
        }

        const task = idx.tasksByExternal.get(deps.externalKey(TODOIST_SYSTEM, remoteTask.id))
          ?? findUnlinkedTaskByNameAndProject(store, remoteTask.content, project.id, deps)
          ?? createLocalTaskFromTodoist(store, idx, remoteTask, project, deps);
        const link = deps.getExternalLink(task, TODOIST_SYSTEM);
        if (link?.externalId && !deps.shouldApplyInbound(task, remoteTask.updated_at, TODOIST_SYSTEM)) continue;

        task.projectId = project.id;
        task.description = remoteTask.content;
        task.details = deps.nullableTrim(remoteTask.description);
        task.dueAt = todoistDueToLocalDueAt(remoteTask.due, deps);
        task.status = "active";
        task.updatedAt = deps.nowIso();
        deps.markInboundApplied(task, TODOIST_SYSTEM);
        deps.upsertExternalLink(task.externalLinks, todoistTaskLink(remoteTask, remoteProject, deps));
        idx.tasksByExternal.set(deps.externalKey(TODOIST_SYSTEM, remoteTask.id), task);
      }

      const completedTasks = await syncExistingTodoistCompletions(todoist, store, idx, remoteProjects, input, deps);
      return { skipped: false, projects: remoteActiveProjects.length, activeTasks: activeTasks.length, completedTasks };
    },

    async createProject({ name }) {
      return todoistProjectLink(await todoist.createProject(name), deps);
    },

    async updateProject({ project, patch }) {
      const link = deps.getExternalLink({ externalLinks: patch.externalLinks }, TODOIST_SYSTEM) ?? deps.getExternalLink(project, TODOIST_SYSTEM);
      if (!link?.externalId) {
        const remote = await todoist.createProject(patch.name ?? project.name);
        deps.upsertExternalLink(patch.externalLinks, todoistProjectLink(remote, deps));
        if (patch.archived === true) await todoist.archiveProject(remote.id);
        return;
      }
      const remote = await todoist.getProject(link.externalId);
      assertTodoistNotAhead(project, remote.updated_at, `Todoist project "${project.name}" changed upstream; run sync_todoist before mutating it locally.`);
      if (patch.name && deps.normalizeName(patch.name) !== deps.normalizeName(project.name)) await todoist.updateProject(remote.id, { name: patch.name });
      if (patch.archived === true && project.archived !== true) await todoist.archiveProject(remote.id);
      if (patch.archived === false && project.archived === true) await todoist.unarchiveProject(remote.id);
      deps.upsertExternalLink(patch.externalLinks, todoistProjectLink(await todoist.getProject(remote.id), deps));
    },

    async createTask({ store, idx, project, description, details, dueAt, links }) {
      const remoteProject = await ensureTodoistProject(todoist, store, idx, project, deps);
      const remote = await todoist.createTask({
        content: description,
        description: details,
        project_id: remoteProject.id,
        ...todoistDuePayload(dueAt, deps),
      });
      deps.upsertExternalLink(links, todoistTaskLink(remote, remoteProject, deps));
    },

    async updateTask({ store, idx, task, patch }) {
      let link = deps.getExternalLink({ externalLinks: patch.externalLinks }, TODOIST_SYSTEM) ?? deps.getExternalLink(task, TODOIST_SYSTEM);
      if (!link?.externalId) {
        const remoteProject = await ensureTodoistProject(todoist, store, idx, patch.project, deps);
        const created = await todoist.createTask({
          content: patch.description,
          description: patch.details,
          project_id: remoteProject.id,
          ...todoistDuePayload(patch.dueAt, deps),
        });
        deps.upsertExternalLink(patch.externalLinks, todoistTaskLink(created, remoteProject, deps));
        if (patch.status === "done") await todoist.completeTask(created.id);
        return;
      }

      const remote = await todoist.getTask(link.externalId);
      assertTodoistNotAhead(task, remote.updated_at, `Todoist task "${task.description}" changed upstream; run sync_todoist before mutating it locally.`);

      const remoteRecurring = remote.due?.is_recurring === true;
      if (patch.status === "done" && task.status !== "done" && remoteRecurring) {
        throw new Error(`Todoist task "${task.description}" is recurring; sync-out completion is disabled. Complete it in Todoist or run sync_todoist after Todoist advances it.`);
      }

      if (patch.project.id !== task.projectId) {
        const remoteProject = await ensureTodoistProject(todoist, store, idx, patch.project, deps);
        await todoist.moveTask(remote.id, { project_id: remoteProject.id });
      }

      const update = {};
      if (patch.description !== task.description) update.content = patch.description;
      if ((patch.details ?? "") !== (task.details ?? "")) update.description = patch.details ?? "";
      if (patch.dueAt !== task.dueAt) Object.assign(update, todoistDuePayload(patch.dueAt, deps));
      if (Object.keys(update).length > 0) await todoist.updateTask(remote.id, update);

      if (patch.status === "done" && task.status !== "done") await todoist.completeTask(remote.id);
      if (patch.status === "active" && task.status === "done") throw new Error("Restoring completed Todoist tasks from local state is not supported yet; run sync_todoist and restore in Todoist if needed.");

      const nextRemote = patch.status === "done" ? { ...remote, checked: true, completed_at: deps.nowIso(), updated_at: deps.nowIso() } : await todoist.getTask(remote.id);
      link = todoistTaskLink(nextRemote, undefined, deps);
      deps.upsertExternalLink(patch.externalLinks, link);
    },
  };
}

async function syncExistingTodoistCompletions(todoist, store, idx, remoteProjects, input, deps) {
  const completedTasks = await todoist.listCompleted(completedSyncRange(input, deps));
  let count = 0;
  for (const remoteTask of completedTasks) {
    const project = resolveTodoistProjectForTask(idx, remoteProjects, remoteTask, deps);
    const task = idx.tasksByExternal.get(deps.externalKey(TODOIST_SYSTEM, remoteTask.id))
      ?? (project ? findUnlinkedTaskByNameAndProject(store, remoteTask.content, project.id, deps) : undefined);
    if (!task || task.status === "done") continue;
    if (!deps.shouldApplyInbound(task, remoteTask.completed_at ?? remoteTask.updated_at, TODOIST_SYSTEM)) continue;
    task.status = "done";
    task.updatedAt = deps.nowIso();
    deps.markInboundApplied(task, TODOIST_SYSTEM);
    deps.upsertExternalLink(task.externalLinks, todoistTaskLink(remoteTask));
    idx.tasksByExternal.set(deps.externalKey(TODOIST_SYSTEM, remoteTask.id), task);
    count++;
  }
  return count;
}

function resolveTodoistProjectForTask(idx, remoteProjects, remoteTask, deps) {
  const projectId = remoteTask.project_id;
  if (!projectId) return undefined;
  const remoteProject = remoteProjects.find((project) => project.id === projectId);
  return idx.projectsByExternal.get(deps.externalKey(TODOIST_SYSTEM, projectId))
    ?? (remoteProject ? idx.projectsByName.get(deps.normalizeName(remoteProject.name)) : undefined);
}

function assertFlattenableProjectNames(remoteActiveProjects, deps) {
  const projectNames = new Map();
  for (const project of remoteActiveProjects) {
    const key = deps.normalizeName(project.name);
    if (projectNames.has(key)) {
      throw new Error(`Todoist sync would flatten duplicate project name "${project.name}". Rename one Todoist project before syncing.`);
    }
    projectNames.set(key, project.id);
  }
}

function createLocalTaskFromTodoist(store, idx, remoteTask, project, deps) {
  const now = deps.nowIso();
  const task = {
    id: deps.uniqueId(idx, "tasks"),
    projectId: project.id,
    description: remoteTask.content,
    details: deps.nullableTrim(remoteTask.description),
    dueAt: todoistDueToLocalDueAt(remoteTask.due, deps),
    status: "active",
    externalLinks: [],
    createdAt: deps.normalizeMaybeDate(remoteTask.added_at, now),
    updatedAt: now,
  };
  store.tasks.push(task);
  idx.tasksById.set(task.id, task);
  return task;
}

function findUnlinkedTaskByNameAndProject(store, description, projectId, deps) {
  return store.tasks.find((task) => {
    if (task.projectId !== projectId) return false;
    if (task.externalLinks.some((link) => deps.normalizeName(link.system) === TODOIST_SYSTEM)) return false;
    return deps.normalizeName(task.description) === deps.normalizeName(description);
  });
}

async function ensureTodoistProject(todoist, store, idx, project, deps) {
  let link = deps.getExternalLink(project, TODOIST_SYSTEM);
  if (link?.externalId) return { id: link.externalId, name: project.name };

  const remoteProjects = await todoist.listProjects();
  const existing = remoteProjects.find((remote) => !remote.is_deleted && !remote.is_archived && deps.normalizeName(remote.name) === deps.normalizeName(project.name));
  const remote = existing ?? await todoist.createProject(project.name);
  link = todoistProjectLink(remote, deps);
  deps.upsertExternalLink(project.externalLinks, link);
  idx.projectsByExternal.set(deps.externalKey(TODOIST_SYSTEM, remote.id), project);
  return remote;
}

function assertTodoistNotAhead(localRecord, remoteUpdatedAt, message) {
  if (remoteNewerThanLocal(remoteUpdatedAt, localRecord.updatedAt)) throw new Error(message);
}

function remoteNewerThanLocal(remoteUpdatedAt, localUpdatedAt) {
  if (!remoteUpdatedAt || !localUpdatedAt) return true;
  const remote = Date.parse(remoteUpdatedAt);
  const local = Date.parse(localUpdatedAt);
  if (Number.isNaN(remote) || Number.isNaN(local)) return true;
  return remote > local + 1000;
}

function todoistClient(apiKey) {
  async function request(method, pathName, body) {
    const response = await fetch(`${TODOIST_API}${pathName}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return null;
    const text = await response.text();
    const data = text.trim() ? JSON.parse(text) : null;
    if (!response.ok) {
      const errorText = data?.error ?? data?.message ?? text;
      throw new Error(`Todoist API ${response.status}: ${errorText}`);
    }
    return data;
  }

  async function listPaginated(pathName, params = {}) {
    const out = [];
    let cursor;
    do {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) query.set(key, String(value));
      if (cursor) query.set("cursor", cursor);
      const suffix = query.toString() ? `?${query}` : "";
      const data = await request("GET", `${pathName}${suffix}`);
      if (Array.isArray(data)) {
        out.push(...data);
        cursor = null;
      } else {
        out.push(...(data?.results ?? data?.items ?? []));
        cursor = data?.next_cursor ?? null;
      }
    } while (cursor);
    return out;
  }

  return {
    listProjects: () => listPaginated("/projects"),
    getProject: (id) => request("GET", `/projects/${encodeURIComponent(id)}`),
    createProject: (name) => request("POST", "/projects", { name }),
    updateProject: (id, body) => request("POST", `/projects/${encodeURIComponent(id)}`, body),
    archiveProject: (id) => request("POST", `/projects/${encodeURIComponent(id)}/archive`, {}),
    unarchiveProject: (id) => request("POST", `/projects/${encodeURIComponent(id)}/unarchive`, {}),
    listTasks: () => listPaginated("/tasks"),
    getTask: (id) => request("GET", `/tasks/${encodeURIComponent(id)}`),
    createTask: (body) => request("POST", "/tasks", body),
    updateTask: (id, body) => request("POST", `/tasks/${encodeURIComponent(id)}`, body),
    moveTask: (id, body) => request("POST", `/tasks/${encodeURIComponent(id)}/move`, body),
    completeTask: (id) => request("POST", `/tasks/${encodeURIComponent(id)}/close`, {}),
    listCompleted: ({ since, until }) => listPaginated("/tasks/completed/by_completion_date", { since, until, limit: 200 }),
  };
}

function completedSyncRange(input, deps) {
  const explicitUntil = deps.optionalString(input.completed_until);
  const until = toTodoistDateTime(explicitUntil ?? deps.nowIso(), "completed_until");
  const explicitSince = deps.optionalString(input.completed_since);
  const days = Number(input.completed_days ?? 90);
  const retentionDays = Number.isFinite(days) && days >= 0 ? days : 90;
  const since = explicitSince
    ? toTodoistDateTime(explicitSince, "completed_since")
    : deps.addDays(new Date(until), -retentionDays).toISOString();
  return { since, until };
}

function toTodoistDateTime(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid date or datetime`);
  return date.toISOString();
}

function todoistProjectLink(project) {
  return {
    system: TODOIST_SYSTEM,
    externalId: project.id,
  };
}

function todoistTaskLink(task) {
  return {
    system: TODOIST_SYSTEM,
    externalId: task.id,
    url: task.url,
  };
}

function todoistDueToLocalDueAt(due, deps) {
  if (!due?.date) return deps.localTodayStartIso();
  return deps.normalizeMaybeDate(due.date, deps.localTodayStartIso());
}

function todoistDuePayload(dueAt, deps) {
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return {};
  const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0 || date.getSeconds() !== 0 || date.getMilliseconds() !== 0;
  return hasTime ? { due_datetime: date.toISOString() } : { due_date: deps.localDateKey(date) };
}
