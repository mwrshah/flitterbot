import { readFile } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { DueTaskProject, DueTasksResponse } from "../contracts/index.ts";
import { sendJson } from "./_shared.ts";

const DEFAULT_TASKS_FILE = path.join(os.homedir(), ".flitterbot", "data", "tasks", "tasks.json");

type TaskStore = {
  projects?: unknown;
  tasks?: unknown;
};

export function selectDueTaskProjects(store: TaskStore, now = new Date()): DueTaskProject[] {
  if (!Array.isArray(store.projects) || !Array.isArray(store.tasks)) return [];

  const projects = new Map<string, DueTaskProject>();
  for (const value of store.projects) {
    if (!isRecord(value) || value.archived === true) continue;
    if (typeof value.id !== "string" || typeof value.name !== "string") continue;
    projects.set(value.id, { id: value.id, name: value.name, tasks: [] });
  }

  const nowMs = now.getTime();
  for (const value of store.tasks) {
    if (!isRecord(value) || value.status !== "active") continue;
    if (
      typeof value.id !== "string" ||
      typeof value.projectId !== "string" ||
      typeof value.description !== "string" ||
      typeof value.dueAt !== "string"
    ) {
      continue;
    }
    const project = projects.get(value.projectId);
    if (!project || Date.parse(value.dueAt) > nowMs || Number.isNaN(Date.parse(value.dueAt)))
      continue;
    project.tasks.push({
      id: value.id,
      description: value.description,
      details: typeof value.details === "string" && value.details.trim() ? value.details : null,
    });
  }

  return [...projects.values()]
    .filter((project) => project.tasks.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readDueTasks(
  storePath = process.env.FLITTERBOT_TASKS_FILE || DEFAULT_TASKS_FILE,
): Promise<DueTasksResponse> {
  try {
    const store = JSON.parse(await readFile(storePath, "utf8")) as TaskStore;
    return { projects: selectDueTaskProjects(store) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: [] };
    throw new Error(
      `Task data could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handleBrowserDueTasksRoute(
  _request: http.IncomingMessage,
  response: http.ServerResponse,
) {
  return sendJson(response, 200, await readDueTasks());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
