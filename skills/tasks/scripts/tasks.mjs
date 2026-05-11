#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { createTaskActions, TASK_ACTION_NAMES } from "./local-provider.mjs";

const DEFAULT_STORE_PATH = path.join(os.homedir(), ".flitterbot", "data", "tasks", "tasks.json");
const STORE_PATH = process.env.FLITTERBOT_TASKS_FILE || DEFAULT_STORE_PATH;
const CONFIG_PATH = process.env.FLITTERBOT_CONFIG || path.join(os.homedir(), ".flitterbot", "config.json");
const actions = createTaskActions({ storePath: STORE_PATH, configPath: CONFIG_PATH });

async function execute(input) {
  const action = actions[input.action];
  if (!action) throw new Error(`Unknown action: ${String(input.action)}`);
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

if (process.argv.includes("--help")) {
  console.log(`Usage: node scripts/tasks.mjs [--json|--format json] '<json-request>' | -
Example: node scripts/tasks.mjs '{"action":"list_tasks","preset":"today"}'
Actions: ${TASK_ACTION_NAMES.join(", ")}`);
  process.exit(0);
}

let outputFormat = process.argv.includes("--json") ? "json" : "markdown";
try {
  const cli = parseCliArgs(process.argv);
  outputFormat = normalizeOutputFormat(cli.outputFormat ?? outputFormat);
  const raw = await readInput(cli.inputArg);
  const input = raw.trim() ? JSON.parse(raw) : { action: "list_tasks" };
  outputFormat = normalizeOutputFormat(cli.outputFormat ?? input.format ?? input.output_format ?? "markdown");
  console.log(formatOutput(await execute(input), outputFormat));
} catch (error) {
  console.log(formatError(error, outputFormat));
  process.exitCode = 1;
}
