const LINEAR_API = "https://api.linear.app/graphql";
const LINEAR_SYSTEM = "linear";

export function createLinearProvider(config, deps) {
  const client = linearClient(config.apiKey);
  const teamStateCache = new Map();

  return {
    system: LINEAR_SYSTEM,

    async syncIn(store, idx, input = {}) {
      const inbound = emptyLinearInboundStats();
      const activeMappings = mappedActiveProjects(store, deps);
      if (activeMappings.length === 0) return { skipped: true, reason: "no_project_mapping", direction: "inbound", inbound };

      const viewer = await client.viewer();
      for (const teamId of [...new Set(activeMappings.map((mapping) => mapping.teamId))]) {
        const issues = await client.listAssignedIssues({ teamId, assigneeId: viewer.id });
        inbound.issues.seen += issues.length;
        for (const issue of issues) {
          const nextStatus = issueStateToLocalStatus(issue.state);
          const project = localProjectForIssue(activeMappings, issue);
          const linkedTask = idx.tasksByExternal.get(deps.externalKey(LINEAR_SYSTEM, issue.id));
          if (nextStatus === "done") {
            const task = linkedTask ?? (project ? findUnlinkedTaskByNameAndProject(store, issue.title, project.id, deps) : undefined);
            if (!task || task.status === "done") continue;
            const link = deps.getExternalLink(task, LINEAR_SYSTEM);
            if (linearIssueId(link) && !deps.shouldApplyInbound(task, issue.updatedAt, LINEAR_SYSTEM)) continue;
            task.status = "done";
            task.updatedAt = deps.nowIso();
            deps.markInboundApplied(task, LINEAR_SYSTEM);
            deps.setExternalLink(task.externalLinks, linearIssueLink(issue));
            idx.tasksByExternal.set(deps.externalKey(LINEAR_SYSTEM, issue.id), task);
            inbound.completedTasks.markedDone++;
            if (!linearIssueId(link)) inbound.completedTasks.linked++;
            continue;
          }
          if (!project) continue;
          let task = linkedTask ?? findUnlinkedTaskByNameAndProject(store, issue.title, project.id, deps);
          const created = !task;
          if (!task) task = createLocalTaskFromLinear(store, idx, issue, project, deps);
          const link = deps.getExternalLink(task, LINEAR_SYSTEM);
          const linked = !linearIssueId(link);
          if (linearIssueId(link) && !deps.shouldApplyInbound(task, issue.updatedAt, LINEAR_SYSTEM)) continue;

          const nextDetails = stripLocalMetadata(issue.description ?? null);
          const nextDueAt = linearDueToLocalDueAt(issue.dueDate, deps);
          const changed = task.projectId !== project.id
            || task.description !== issue.title
            || (task.details ?? null) !== nextDetails
            || task.dueAt !== nextDueAt
            || task.status !== nextStatus;
          task.projectId = project.id;
          task.description = issue.title;
          task.details = nextDetails;
          task.dueAt = nextDueAt;
          task.status = nextStatus;
          if (changed) task.updatedAt = deps.nowIso();
          deps.markInboundApplied(task, LINEAR_SYSTEM);
          deps.setExternalLink(task.externalLinks, linearIssueLink(issue, project, deps));
          idx.tasksByExternal.set(deps.externalKey(LINEAR_SYSTEM, issue.id), task);
          if (created) inbound.activeTasks.created++;
          else {
            if (changed) inbound.activeTasks.updated++;
            if (linked) inbound.activeTasks.linked++;
          }
        }
      }

      return { skipped: false, direction: "inbound", inbound };
    },

    async createProject() {
      return null;
    },

    async updateProject() {
      return;
    },

    async createTask({ project, description, details, dueAt, links }) {
      const mapping = mappingForProject(project);
      if (!mapping?.teamId) return;

      const states = await statesForTeam(client, teamStateCache, mapping.teamId);
      const issue = await client.createIssue({
        teamId: mapping.teamId,
        projectId: mapping.projectId,
        title: description,
        description: linearDescription(details, project.name),
        dueDate: localDueDate(dueAt, deps),
        stateId: stateIdForLocalTask(states, { status: "active", dueAt }),
      });
      deps.setExternalLink(links, linearIssueLink(issue, project, deps));
    },

    async updateTask({ task, patch }) {
      const existingLink = deps.getExternalLink({ externalLinks: patch.externalLinks }, LINEAR_SYSTEM) ?? deps.getExternalLink(task, LINEAR_SYSTEM);
      const mapping = mappingForProject(patch.project);
      if (!linearIssueId(existingLink) && !mapping?.teamId) return;

      if (!linearIssueId(existingLink)) {
        if (patch.status === "done") return;
        await this.createTask({
          project: patch.project,
          description: patch.description,
          details: patch.details,
          dueAt: patch.dueAt,
          links: patch.externalLinks,
        });
        if (patch.status === "done") {
          const createdLink = deps.getExternalLink({ externalLinks: patch.externalLinks }, LINEAR_SYSTEM);
          if (linearIssueId(createdLink)) {
            const created = await client.getIssue(linearIssueId(createdLink));
            const states = await statesForTeam(client, teamStateCache, created.team.id);
            const updated = await client.updateIssue(created.id, { stateId: stateIdForLocalTask(states, patch) });
            deps.setExternalLink(patch.externalLinks, linearIssueLink(updated, patch.project, deps));
          }
        }
        return;
      }

      const remote = await client.getIssue(linearIssueId(existingLink));
      assertLinearNotAhead(task, remote.updatedAt, `Linear issue "${remote.identifier}" changed upstream; run periodic_sync_and_cleanup before mutating it locally.`);
      const states = await statesForTeam(client, teamStateCache, remote.team.id);
      const update = {
        title: patch.description,
        description: linearDescription(patch.details, patch.project.name),
        dueDate: localDueDate(patch.dueAt, deps),
        stateId: stateIdForLocalTask(states, patch),
      };
      if (mapping?.projectId) update.projectId = mapping.projectId;
      const updated = await client.updateIssue(remote.id, update);
      deps.setExternalLink(patch.externalLinks, linearIssueLink(updated, patch.project, deps));
    },
  };
}

export function emptyLinearInboundStats() {
  return {
    issues: { seen: 0 },
    activeTasks: { created: 0, updated: 0, linked: 0 },
    completedTasks: { markedDone: 0, linked: 0 },
  };
}

function mappedActiveProjects(store, deps) {
  const out = [];
  const seen = new Set();
  for (const project of store.projects) {
    if (project.archived) continue;
    const mapping = mappingForProject(project);
    if (!mapping?.teamId) continue;
    const key = `${project.id}:${mapping.teamId}:${mapping.projectId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ project, ...mapping });
  }
  return out;
}

function mappingForProject(project) {
  const link = project?.externalLinks?.find((item) => normalizeName(item.system) === LINEAR_SYSTEM);
  const teamId = stringOr(link?.teamId ?? link?.team_id);
  if (!teamId) return undefined;
  return {
    teamId,
    projectId: stringOr(link?.projectId ?? link?.project_id),
  };
}

function localProjectForIssue(mappings, issue) {
  if (issue.project?.id) {
    const exact = mappings.find((mapping) => mapping.projectId === issue.project.id);
    if (exact) return exact.project;
  }
  const sameTeam = mappings.filter((mapping) => mapping.teamId === issue.team.id && !mapping.projectId);
  return sameTeam.length === 1 ? sameTeam[0].project : undefined;
}

function createLocalTaskFromLinear(store, idx, issue, project, deps) {
  const now = deps.nowIso();
  const task = {
    id: deps.uniqueId(idx, "tasks"),
    projectId: project.id,
    description: issue.title,
    details: stripLocalMetadata(issue.description ?? null),
    dueAt: linearDueToLocalDueAt(issue.dueDate, deps),
    status: issueStateToLocalStatus(issue.state),
    externalLinks: [],
    createdAt: deps.normalizeMaybeDate(issue.createdAt, now),
    updatedAt: now,
  };
  store.tasks.push(task);
  idx.tasksById.set(task.id, task);
  return task;
}

function findUnlinkedTaskByNameAndProject(store, description, projectId, deps) {
  return store.tasks.find((task) => {
    if (task.projectId !== projectId) return false;
    if (task.externalLinks.some((link) => deps.normalizeName(link.system) === LINEAR_SYSTEM)) return false;
    return deps.normalizeName(task.description) === deps.normalizeName(description);
  });
}

async function statesForTeam(client, cache, teamId) {
  if (!cache.has(teamId)) cache.set(teamId, client.teamStates(teamId));
  return cache.get(teamId);
}

function stateIdForLocalTask(states, task) {
  if (task.status === "done") return stateByType(states, "completed")?.id;
  return stateByType(states, "unstarted")?.id ?? stateByType(states, "backlog")?.id;
}

function issueStateToLocalStatus(state) {
  return state?.type === "completed" || state?.type === "canceled" ? "done" : "active";
}

function stateByType(states, type) {
  return states.find((state) => state.type === type);
}

function assertLinearNotAhead(localRecord, remoteUpdatedAt, message) {
  if (remoteNewerThanLocal(remoteUpdatedAt, localRecord.updatedAt)) throw new Error(message);
}

function remoteNewerThanLocal(remoteUpdatedAt, localUpdatedAt) {
  if (!remoteUpdatedAt || !localUpdatedAt) return true;
  const remote = Date.parse(remoteUpdatedAt);
  const local = Date.parse(localUpdatedAt);
  if (Number.isNaN(remote) || Number.isNaN(local)) return true;
  return remote > local + 1000;
}

function linearIssueId(link) {
  return link?.issueId;
}

function linearIssueLink(issue) {
  return {
    system: LINEAR_SYSTEM,
    issueId: issue.id,
    url: issue.url,
  };
}

function linearDescription(details, localProjectName) {
  const body = details ? `${details.trim()}\n\n` : "";
  return `${body}[proj_name-${localProjectName}]`;
}

function stripLocalMetadata(description) {
  if (!description) return null;
  const cleaned = description.replace(/\n?\s*\[proj_name-[^\]]+\]\s*$/u, "").trim();
  return cleaned || null;
}

function localDueDate(dueAt, deps) {
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return undefined;
  return deps.localDateKey(date);
}

function linearDueToLocalDueAt(dueDate, deps) {
  return dueDate ? deps.normalizeMaybeDate(dueDate, deps.localTodayStartIso()) : deps.localTodayStartIso();
}

function linearClient(apiKey) {
  async function request(query, variables = {}) {
    const response = await fetch(LINEAR_API, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const data = await response.json();
    if (!response.ok || data.errors?.length) {
      const message = data.errors?.map((error) => error.message).join("; ") || response.statusText;
      throw new Error(`Linear API ${response.status}: ${message}`);
    }
    return data.data;
  }

  const issueFields = `
    id
    identifier
    title
    description
    priority
    dueDate
    url
    createdAt
    updatedAt
    completedAt
    state { id name type }
    team { id key name }
    project { id name }
    assignee { id name email }
  `;

  return {
    async viewer() {
      return (await request(`query Viewer { viewer { id name email } }`)).viewer;
    },

    async teamStates(teamId) {
      const data = await request(
        `query TeamStates($teamId: String!) {
          team(id: $teamId) { states { nodes { id name type position } } }
        }`,
        { teamId },
      );
      return data.team.states.nodes.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    },

    async listAssignedIssues({ teamId, assigneeId }) {
      const data = await request(
        `query AssignedIssues($first: Int!, $filter: IssueFilter, $orderBy: PaginationOrderBy!) {
          issues(first: $first, filter: $filter, orderBy: $orderBy) { nodes { ${issueFields} } }
        }`,
        {
          first: 100,
          filter: { team: { id: { eq: teamId } }, assignee: { id: { eq: assigneeId } } },
          orderBy: "updatedAt",
        },
      );
      return data.issues.nodes;
    },

    async getIssue(id) {
      return (await request(`query Issue($id: String!) { issue(id: $id) { ${issueFields} } }`, { id })).issue;
    },

    async createIssue(input) {
      const data = await request(
        `mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { ${issueFields} } }
        }`,
        { input: stripUndefined(input) },
      );
      if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error("Linear issue creation failed");
      return data.issueCreate.issue;
    },

    async updateIssue(id, input) {
      const data = await request(
        `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { ${issueFields} } }
        }`,
        { id, input: stripUndefined(input) },
      );
      if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new Error("Linear issue update failed");
      return data.issueUpdate.issue;
    },
  };
}

function stripUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function normalizeName(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function stringOr(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

