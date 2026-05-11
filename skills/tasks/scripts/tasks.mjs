#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createTaskActions, TASK_ACTION_NAMES } from "./local-provider.mjs";

export { TASK_ACTION_NAMES };

const DEFAULT_STORE_PATH = path.join(os.homedir(), ".flitterbot", "data", "tasks", "tasks.json");
const STORE_PATH = process.env.FLITTERBOT_TASKS_FILE || DEFAULT_STORE_PATH;
const CONFIG_PATH = process.env.FLITTERBOT_CONFIG || path.join(os.homedir(), ".flitterbot", "config.json");
const actionImplementations = createTaskActions({ storePath: STORE_PATH, configPath: CONFIG_PATH });

export const TASK_DATA_MODELS = deepFreeze({
  Project: {
    description: "A local task project. A task may only be connected to one project.",
    fields: {
      id: { type: "string" },
      name: { type: "string" },
      archived: { type: "boolean" },
      externalLinks: { type: "ExternalLink[]" },
      createdAt: { type: "ISO datetime string" },
      updatedAt: { type: "ISO datetime string" },
    },
  },
  Task: {
    description: "A local task. Action outputs include projectName on task records.",
    fields: {
      id: { type: "string" },
      projectId: { type: "string" },
      projectName: { type: "string", outputOnly: true },
      description: { type: "string" },
      details: { type: "string|null" },
      dueAt: { type: "ISO datetime string", notes: "Always set. Defaults to today's local midnight." },
      status: { type: "active|done" },
      externalLinks: { type: "ExternalLink[]" },
      createdAt: { type: "ISO datetime string" },
      updatedAt: { type: "ISO datetime string" },
    },
  },
  ExternalLink: {
    description: "Provider linkage. One entry per provider system.",
    variants: [
      { system: "todoist", project: { projectId: "string" }, task: { taskId: "string", url: "string?" } },
      { system: "linear", project: { teamId: "string", projectId: "string|null?" }, task: { issueId: "string", url: "string?" } },
      { system: "other", fields: "string|number|boolean|null provider-specific fields" },
    ],
  },
});

export const TASK_ACTION_CONTRACTS = deepFreeze({
  list_projects: {
    action: "list_projects",
    description: "List local projects.",
    input: {
      include_archived_projects: { type: "boolean", optional: true, default: false },
    },
    output: { ok: "boolean", message: "string", projects: "Project[]" },
  },
  create_project: {
    action: "create_project",
    description: "Create a project locally and in configured providers first.",
    input: {
      project_name: { type: "string", required: true, notes: "Must be unique." },
      external_links: { type: "ExternalLink[]", optional: true },
    },
    output: { ok: "boolean", message: "string", project: "Project" },
    effects: ["Creates configured-provider projects before the local write."],
  },
  update_project: {
    action: "update_project",
    description: "Rename, archive, or replace external links for a project.",
    input: {
      project_id: { type: "string", optional: true, identifyBy: true },
      project_name_current: { type: "string", optional: true, identifyBy: true },
      project_name: { type: "string", optional: true, notes: "New name. Also accepted as an identifier when no current name is supplied." },
      project_archived: { type: "boolean", optional: true },
      external_links: { type: "ExternalLink[]", optional: true, notes: "Full replacement when supplied." },
    },
    output: { ok: "boolean", message: "string", project: "Project" },
    effects: ["Mirrors changes to configured providers before the local write."],
  },
  list_tasks: {
    action: "list_tasks",
    description: "List tasks, optionally filtered by project, status, and due-date range.",
    input: {
      project_id: { type: "string", optional: true },
      project_name: { type: "string", optional: true },
      status: { type: "active|done|any", optional: true, default: "active" },
      include_archived_projects: { type: "boolean", optional: true, default: false },
      preset: { type: "overdue|today|tomorrow|next_days|between|all", optional: true, default: "all" },
      days: { type: "number", optional: true, appliesWhen: { preset: "next_days" }, default: 7 },
      start_date: { type: "YYYY-MM-DD", optional: true, appliesWhen: { preset: "between" } },
      end_date: { type: "YYYY-MM-DD", optional: true, appliesWhen: { preset: "between" } },
      start_at: { type: "ISO datetime string", optional: true, appliesWhen: { preset: "between" } },
      end_at: { type: "ISO datetime string", optional: true, appliesWhen: { preset: "between" } },
    },
    output: { ok: "boolean", message: "string", tasks: "Task[]" },
    sorting: ["dueAt", "projectName", "createdAt"],
  },
  search_tasks: {
    action: "search_tasks",
    description: "Search local tasks by task description, task details, or project name.",
    input: {
      query: { type: "string", required: true, aliases: ["q", "search"] },
      project_id: { type: "string", optional: true },
      project_name: { type: "string", optional: true },
      status: { type: "active|done|any", optional: true, default: "active" },
      include_archived_projects: { type: "boolean", optional: true, default: false },
      preset: { type: "overdue|today|tomorrow|next_days|between|all", optional: true, default: "all" },
      days: { type: "number", optional: true, appliesWhen: { preset: "next_days" }, default: 7 },
      start_date: { type: "YYYY-MM-DD", optional: true, appliesWhen: { preset: "between" } },
      end_date: { type: "YYYY-MM-DD", optional: true, appliesWhen: { preset: "between" } },
      start_at: { type: "ISO datetime string", optional: true, appliesWhen: { preset: "between" } },
      end_at: { type: "ISO datetime string", optional: true, appliesWhen: { preset: "between" } },
      limit: { type: "number", optional: true, notes: "Positive integer maximum result count." },
    },
    output: { ok: "boolean", message: "string", tasks: "Task[]" },
    matching: ["Case-insensitive substring search", "All query terms must appear across description, details, or projectName", "Description matches rank ahead of details, then project name"],
  },
  get_task: {
    action: "get_task",
    description: "Fetch one task by local ID.",
    input: {
      task_id: { type: "string", required: true },
    },
    output: { ok: "boolean", message: "string", task: "Task" },
  },
  create_task: {
    action: "create_task",
    description: "Create a task locally and in configured providers first.",
    input: {
      description: { type: "string", required: true },
      project_id: { type: "string", optional: true },
      project_name: { type: "string", optional: true, default: "Inbox", notes: "Auto-creates the local project when missing." },
      details: { type: "string|null", optional: true },
      due_at: { type: "YYYY-MM-DD|ISO datetime string", optional: true },
      due_in_days: { type: "number", optional: true },
      external_links: { type: "ExternalLink[]", optional: true },
    },
    output: { ok: "boolean", message: "string", task: "Task" },
    effects: ["Creates configured-provider tasks before the local write.", "dueAt defaults to today's local midnight."],
  },
  update_task: {
    action: "update_task",
    description: "Patch task fields, mark done/active, move projects, or replace external links.",
    input: {
      task_id: { type: "string", required: true },
      description: { type: "string", optional: true },
      details: { type: "string|null", optional: true, notes: "null clears details." },
      due_at: { type: "YYYY-MM-DD|ISO datetime string", optional: true },
      due_in_days: { type: "number", optional: true },
      status: { type: "active|done", optional: true },
      project_id: { type: "string", optional: true },
      project_name: { type: "string", optional: true, notes: "Auto-creates the local project when missing." },
      external_links: { type: "ExternalLink[]", optional: true, notes: "Full replacement when supplied." },
    },
    output: { ok: "boolean", message: "string", task: "Task" },
    effects: ["Pushes the patch to configured providers before the local write."],
    conflicts: ["Fails before writing if a provider has a newer updated_at than local updatedAt."],
  },
  periodic_sync_and_cleanup: {
    action: "periodic_sync_and_cleanup",
    description: "Pull configured providers inward, run local cleanup, and migrate old external-link shapes.",
    input: {
      cleanup_days: { type: "number", optional: true, default: 90 },
      completed_since: { type: "YYYY-MM-DD|ISO datetime string", optional: true, notes: "Overrides Todoist completion window start." },
      completed_until: { type: "YYYY-MM-DD|ISO datetime string", optional: true, notes: "Overrides Todoist completion window end." },
    },
    output: { ok: "boolean", message: "string", todoist: "ProviderSyncResult", linear: "ProviderSyncResult", cleanup: "CleanupResult" },
    effects: [
      "Deletes local done tasks whose updatedAt is older than cleanup_days without propagating upstream.",
      "Todoist and Linear skip quietly when their API keys or mappings are absent.",
      "Inbound active provider items create/update local tasks; completed provider items only mark existing linked local tasks done.",
      "Backs up and migrates old external-link shapes when detected.",
    ],
  },
});

export const TASK_CONTRACTS = deepFreeze({
  models: TASK_DATA_MODELS,
  actions: TASK_ACTION_CONTRACTS,
  conventions: {
    requestShape: "{ action, ...input } for execute(); thin wrappers take only the action input fields.",
    inputCase: "snake_case",
    storedRecordCase: "camelCase",
    successShape: "{ ok: true, message, ...data }",
    errorShape: "CLI emits { ok: false, error } in JSON mode or Error: <message> in Markdown mode.",
  },
});

assertContractCoverage();

export async function list_projects(input = {}) {
  return actionImplementations.list_projects(input);
}

export async function create_project(input = {}) {
  return actionImplementations.create_project(input);
}

export async function update_project(input = {}) {
  return actionImplementations.update_project(input);
}

export async function list_tasks(input = {}) {
  return actionImplementations.list_tasks(input);
}

export async function search_tasks(input = {}) {
  return actionImplementations.search_tasks(input);
}

export async function get_task(input = {}) {
  return actionImplementations.get_task(input);
}

export async function create_task(input = {}) {
  return actionImplementations.create_task(input);
}

export async function update_task(input = {}) {
  return actionImplementations.update_task(input);
}

export async function periodic_sync_and_cleanup(input = {}) {
  return actionImplementations.periodic_sync_and_cleanup(input);
}

export const taskActions = Object.freeze({
  list_projects,
  create_project,
  update_project,
  list_tasks,
  search_tasks,
  get_task,
  create_task,
  update_task,
  periodic_sync_and_cleanup,
});

export async function execute(input = {}) {
  const actionName = input?.action;
  const action = Object.hasOwn(taskActions, actionName) ? taskActions[actionName] : undefined;
  if (!action) throw new Error(`Unknown action: ${String(actionName)}`);
  return action(input);
}

function normalizeOutputFormat(value) {
  const format = String(value ?? "markdown").trim().toLowerCase();
  if (format === "json") return "json";
  if (["markdown", "md", "text"].includes(format)) return "markdown";
  throw new Error("format must be markdown or json");
}

function parseCliArgs(argv) {
  let inputArg;
  let outputFormat;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (["--json", "--markdown", "--md", "--text"].includes(arg)) {
      outputFormat = arg === "--json" ? "json" : "markdown";
      continue;
    }
    if (arg === "--format" || arg.startsWith("--format=")) {
      const value = arg === "--format" ? argv[++i] : arg.slice("--format=".length);
      if (!value) throw new Error("--format requires markdown or json");
      outputFormat = normalizeOutputFormat(value);
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") throw new Error(`Unknown option: ${arg}`);
    if (inputArg !== undefined) throw new Error("Only one JSON request argument is supported");
    inputArg = arg;
  }
  return { inputArg, outputFormat };
}

async function readInput(inputArg) {
  if (inputArg && inputArg !== "-") return inputArg;
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function formatOutput(result, format) {
  return format === "json" ? JSON.stringify(result, null, 2) : formatMarkdownResult(result);
}

function formatError(error, format) {
  const message = error instanceof Error ? error.message : String(error);
  return format === "json" ? JSON.stringify({ ok: false, error: message }, null, 2) : `Error: ${message}`;
}

function formatMarkdownResult(result) {
  const body = Array.isArray(result.tasks) ? formatTaskBlocks(result.tasks)
    : result.task ? formatTaskBlocks([result.task], { includeLinks: true })
      : Array.isArray(result.projects) ? formatProjectBlocks(result.projects)
        : result.project ? formatProjectBlocks([result.project])
          : [];
  return [...(result.message ? [result.message] : []), ...(body.length ? ["", ...body] : [])]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n")
    .trimEnd();
}

function formatTaskBlocks(tasks, options = {}) {
  if (tasks.length === 0) return ["No matching tasks."];
  return tasks.flatMap((task) => [
    formatTaskLine(task),
    ...(task.details ? [`  - Details: ${oneLine(task.details)}`] : []),
    ...(options.includeLinks ? (task.externalLinks ?? []).map((link) => `  - Link: ${formatExternalLink(link)}`) : []),
  ]);
}

function formatTaskLine(task) {
  const status = task.status && task.status !== "active" ? ` — ${task.status}` : "";
  return `- \`${task.id}\` [${oneLine(task.projectName)}] ${oneLine(task.description)} — ${formatDueAt(task.dueAt)}${status}`;
}

function formatProjectBlocks(projects) {
  if (projects.length === 0) return ["No projects found."];
  return projects.map((project) => `- \`${project.id}\` ${oneLine(project.name)}${project.archived ? " — archived" : ""}`);
}

function formatExternalLink(link) {
  const parts = [oneLine(link.system)];
  for (const key of ["projectId", "taskId", "teamId", "issueId", "id", "externalId"]) {
    if (link[key]) parts.push(oneLine(link[key]));
  }
  if (link.url) parts.push(`— ${oneLine(link.url)}`);
  return parts.join(" ");
}

function formatDueAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return `due ${oneLine(value)}`;
  const dateText = localDateKey(date);
  const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0 || date.getSeconds() !== 0 || date.getMilliseconds() !== 0;
  const timeText = hasTime ? ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}` : "";
  const relative = relativeDateLabel(date);
  return `due ${dateText}${timeText}${relative ? ` (${relative})` : ""}`;
}

function relativeDateLabel(date) {
  const taskDate = localDateKey(date);
  const today = localDateKey(localTodayStart());
  const tomorrow = localDateKey(addDays(localTodayStart(), 1));
  if (taskDate < today) return "overdue";
  if (taskDate === today) return "today";
  if (taskDate === tomorrow) return "tomorrow";
  return "";
}

function localTodayStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
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

function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function assertContractCoverage() {
  const contractNames = Object.keys(TASK_ACTION_CONTRACTS);
  const missingContracts = TASK_ACTION_NAMES.filter((name) => !Object.hasOwn(TASK_ACTION_CONTRACTS, name));
  const extraContracts = contractNames.filter((name) => !TASK_ACTION_NAMES.includes(name));
  if (missingContracts.length || extraContracts.length) {
    throw new Error(`Task action contract mismatch. Missing: ${missingContracts.join(", ") || "none"}. Extra: ${extraContracts.join(", ") || "none"}.`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function printHelp() {
  console.log(`Usage: node scripts/tasks.mjs [--json|--format json] '<json-request>' | -
Example: node scripts/tasks.mjs '{"action":"list_tasks","preset":"today"}'
Actions: ${TASK_ACTION_NAMES.join(", ")}`);
}

function isDirectCli() {
  const invokedPath = process.argv[1];
  return Boolean(invokedPath) && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href;
}

async function main(argv = process.argv) {
  if (argv.includes("--help")) {
    printHelp();
    return;
  }

  let outputFormat = argv.includes("--json") ? "json" : "markdown";
  try {
    const cli = parseCliArgs(argv);
    outputFormat = normalizeOutputFormat(cli.outputFormat ?? outputFormat);
    const raw = await readInput(cli.inputArg);
    const input = raw.trim() ? JSON.parse(raw) : { action: "list_tasks" };
    outputFormat = normalizeOutputFormat(cli.outputFormat ?? input.format ?? input.output_format ?? "markdown");
    console.log(formatOutput(await execute(input), outputFormat));
  } catch (error) {
    console.log(formatError(error, outputFormat));
    process.exitCode = 1;
  }
}

if (isDirectCli()) await main();
