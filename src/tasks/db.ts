import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 10;
const FLITTERBOT_DIR = path.join(os.homedir(), ".flitterbot");

export const TASKS_DB_PATH = path.join(FLITTERBOT_DIR, "tasks.db");
export const TASKS_OUTPUT_DIR = path.join(FLITTERBOT_DIR, "tasks");

export type TaskStatus = "active" | "done";

export type ExternalTaskLink = {
  system: string;
  externalId?: string;
  url?: string;
  syncedAt?: string;
  metadata?: Record<string, unknown>;
};

export type TaskProject = {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TaskItem = {
  id: string;
  projectId: string;
  projectName: string;
  description: string;
  details: string | null;
  dueAt: string;
  status: TaskStatus;
  externalLinks: ExternalTaskLink[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type TaskRangePreset = "all" | "overdue" | "today" | "tomorrow" | "next_days" | "between";

export type ListTasksOptions = {
  projectId?: string;
  projectName?: string;
  status?: TaskStatus | "any";
  includeArchivedProjects?: boolean;
  preset?: TaskRangePreset;
  days?: number;
  startDate?: string;
  endDate?: string;
  startAt?: string;
  endAt?: string;
};

type TaskProjectRow = {
  id: string;
  name: string;
  archived: number;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  project_id: string;
  project_name: string;
  description: string;
  details: string | null;
  due_at: string;
  status: TaskStatus;
  external_links: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export class TasksDatabase {
  readonly dbPath: string;
  readonly outputDir: string;
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly sqlite: DatabaseSync;

  constructor(dbPath: string, outputDir: string) {
    this.dbPath = dbPath;
    this.outputDir = outputDir;
    this.jsonPath = path.join(outputDir, "tasks.json");
    this.markdownPath = path.join(outputDir, "active.md");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec("PRAGMA journal_mode=WAL;");
    this.sqlite.exec("PRAGMA busy_timeout=5000;");
    this.sqlite.exec("PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
  }

  exec(sql: string): void {
    this.sqlite.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.sqlite.prepare(sql);
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.prepare(sql).get(...(params as Array<import("node:sqlite").SQLInputValue>)) as
      | T
      | undefined;
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.prepare(sql).all(...(params as Array<import("node:sqlite").SQLInputValue>)) as T[];
  }

  createProject(name: string): TaskProject {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Project name is required");
    const now = nowIso();
    const id = this.generateUniqueId("task_projects");
    this.prepare(
      `INSERT INTO task_projects (id, name, archived, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
    ).run(id, trimmed, now, now);
    this.exportActiveTasks();
    return this.getProjectById(id)!;
  }

  upsertProject(name: string): TaskProject {
    const existing = this.getProjectByName(name);
    return existing ?? this.createProject(name);
  }

  updateProject(input: { id?: string; name?: string; archived?: boolean }): TaskProject {
    const project = this.resolveProject(input.id, input.name);
    const nextName = input.name?.trim() || project.name;
    const archived = input.archived ?? project.archived;
    this.prepare(
      `UPDATE task_projects
       SET name = ?, archived = ?, updated_at = ?
       WHERE id = ?`,
    ).run(nextName, archived ? 1 : 0, nowIso(), project.id);
    this.exportActiveTasks();
    return this.getProjectById(project.id)!;
  }

  listProjects(includeArchived = false): TaskProject[] {
    const rows = includeArchived
      ? this.all<TaskProjectRow>(`SELECT * FROM task_projects ORDER BY archived ASC, name ASC`)
      : this.all<TaskProjectRow>(
          `SELECT * FROM task_projects WHERE archived = 0 ORDER BY name ASC`,
        );
    return rows.map(mapProject);
  }

  getProjectById(id: string): TaskProject | undefined {
    const row = this.get<TaskProjectRow>(`SELECT * FROM task_projects WHERE id = ?`, id);
    return row ? mapProject(row) : undefined;
  }

  getProjectByName(name: string): TaskProject | undefined {
    const row = this.get<TaskProjectRow>(
      `SELECT * FROM task_projects WHERE lower(name) = lower(?)`,
      name.trim(),
    );
    return row ? mapProject(row) : undefined;
  }

  createTask(input: {
    projectId?: string;
    projectName?: string;
    description: string;
    details?: string | null;
    dueAt?: string | null;
    dueInDays?: number | null;
    externalLinks?: ExternalTaskLink[];
  }): TaskItem {
    const description = input.description.trim();
    if (!description) throw new Error("Task description is required");
    const project = input.projectId
      ? this.resolveProject(input.projectId, undefined)
      : this.upsertProject(input.projectName ?? "Inbox");
    const now = nowIso();
    const id = this.generateUniqueId("tasks");
    const dueAt = resolveDueAt(input.dueAt, input.dueInDays);
    this.prepare(
      `INSERT INTO tasks (
         id, project_id, description, details, due_at, status, external_links,
         created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
    ).run(
      id,
      project.id,
      description,
      nullableTrim(input.details),
      dueAt,
      encodeExternalLinks(input.externalLinks ?? []),
      now,
      now,
    );
    this.exportActiveTasks();
    return this.getTask(id)!;
  }

  updateTask(input: {
    id: string;
    projectId?: string;
    projectName?: string;
    description?: string;
    details?: string | null;
    dueAt?: string | null;
    dueInDays?: number | null;
    status?: TaskStatus;
    externalLinks?: ExternalTaskLink[];
  }): TaskItem {
    const current = this.getTask(input.id);
    if (!current) throw new Error(`Task not found: ${input.id}`);
    const nextProject =
      input.projectId || input.projectName
        ? this.resolveOrCreateProject(input.projectId, input.projectName)
        : { id: current.projectId };
    const nextDescription =
      input.description === undefined ? current.description : input.description.trim();
    if (!nextDescription) throw new Error("Task description is required");
    const nextStatus = input.status ?? current.status;
    const completedAt = nextStatus === "done" ? (current.completedAt ?? nowIso()) : null;
    const dueAt =
      input.dueAt !== undefined || input.dueInDays !== undefined
        ? resolveDueAt(input.dueAt, input.dueInDays)
        : current.dueAt;
    const details = input.details === undefined ? current.details : nullableTrim(input.details);
    const externalLinks =
      input.externalLinks === undefined ? current.externalLinks : input.externalLinks;
    this.prepare(
      `UPDATE tasks
       SET project_id = ?, description = ?, details = ?, due_at = ?, status = ?,
           external_links = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
    ).run(
      nextProject.id,
      nextDescription,
      details,
      dueAt,
      nextStatus,
      encodeExternalLinks(externalLinks),
      nowIso(),
      completedAt,
      current.id,
    );
    this.exportActiveTasks();
    return this.getTask(current.id)!;
  }

  getTask(id: string): TaskItem | undefined {
    const row = this.get<TaskRow>(
      `SELECT t.*, p.name AS project_name
       FROM tasks t
       JOIN task_projects p ON p.id = t.project_id
       WHERE t.id = ?`,
      id,
    );
    return row ? mapTask(row) : undefined;
  }

  listTasks(options: ListTasksOptions = {}): TaskItem[] {
    const params: Array<string | number> = [];
    const where: string[] = [];
    const status = options.status ?? "active";
    if (status !== "any") {
      where.push("t.status = ?");
      params.push(status);
    }
    if (!options.includeArchivedProjects) {
      where.push("p.archived = 0");
    }
    if (options.projectId) {
      where.push("t.project_id = ?");
      params.push(options.projectId);
    } else if (options.projectName) {
      where.push("lower(p.name) = lower(?)");
      params.push(options.projectName.trim());
    }

    const range = buildRange(options);
    if (range.kind === "lt") {
      where.push("t.due_at < ?");
      params.push(range.before);
    } else if (range.kind === "between") {
      where.push("t.due_at >= ? AND t.due_at <= ?");
      params.push(range.start, range.end);
    } else if (range.kind === "date-window") {
      where.push("t.due_at >= ? AND t.due_at < ?");
      params.push(range.startInclusive, range.endExclusive);
    }

    const sql = `SELECT t.*, p.name AS project_name
      FROM tasks t
      JOIN task_projects p ON p.id = t.project_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY t.due_at ASC, p.name ASC, t.created_at ASC`;
    return this.all<TaskRow>(sql, ...params).map(mapTask);
  }

  exportActiveTasks(): { jsonPath: string; markdownPath: string; taskCount: number } {
    const projects = this.listProjects(false);
    const tasks = this.listTasks({ status: "active" });
    const grouped = projects
      .map((project) => ({
        ...project,
        tasks: tasks.filter((task) => task.projectId === project.id),
      }))
      .filter((project) => project.tasks.length > 0);

    const payload = {
      exportedAt: nowIso(),
      source: this.dbPath,
      projects: grouped,
    };
    writeAtomic(this.jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
    writeAtomic(this.markdownPath, renderMarkdown(grouped));
    return { jsonPath: this.jsonPath, markdownPath: this.markdownPath, taskCount: tasks.length };
  }

  private resolveProject(id?: string, name?: string): TaskProject {
    if (id) {
      const project = this.getProjectById(id);
      if (!project) throw new Error(`Project not found: ${id}`);
      return project;
    }
    if (name) {
      const project = this.getProjectByName(name);
      if (!project) throw new Error(`Project not found: ${name}`);
      return project;
    }
    throw new Error("Project id or name is required");
  }

  private resolveOrCreateProject(id?: string, name?: string): TaskProject {
    if (id) return this.resolveProject(id, undefined);
    if (name) return this.upsertProject(name);
    throw new Error("Project id or name is required");
  }

  private generateUniqueId(table: "task_projects" | "tasks"): string {
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = compactId();
      const row = this.get<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, id);
      if (!row) return id;
    }
    throw new Error(`Unable to generate unique id for ${table}`);
  }

  private migrate(): void {
    this.exec(`
      CREATE TABLE IF NOT EXISTS task_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES task_projects(id) ON DELETE RESTRICT,
        description TEXT NOT NULL,
        details TEXT,
        due_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
        external_links TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_task_projects_archived_name
        ON task_projects(archived, name);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_status_due
        ON tasks(project_id, status, due_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_status_due
        ON tasks(status, due_at);
    `);
    this.prepare(`UPDATE tasks SET due_at = ? WHERE due_at IS NULL`).run(localTodayStartIso());
  }
}

export function openTasksDatabase(dbPath: string, outputDir: string): TasksDatabase {
  return new TasksDatabase(dbPath, outputDir);
}

export function openDefaultTasksDatabase(): TasksDatabase {
  return openTasksDatabase(TASKS_DB_PATH, TASKS_OUTPUT_DIR);
}

function compactId(): string {
  let out = "";
  const bytes = crypto.randomBytes(ID_LENGTH);
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

function localTodayStartIso(): string {
  return localTodayStart().toISOString();
}

function nullableTrim(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function encodeExternalLinks(links: ExternalTaskLink[]): string {
  return JSON.stringify(links.map(normalizeExternalLink));
}

function decodeExternalLinks(raw: string): ExternalTaskLink[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeExternalLink).filter((link) => link.system);
  } catch {
    return [];
  }
}

function normalizeExternalLink(input: unknown): ExternalTaskLink {
  if (!input || typeof input !== "object") return { system: "" };
  const value = input as Partial<ExternalTaskLink>;
  const link: ExternalTaskLink = {
    system: typeof value.system === "string" ? value.system.trim() : "",
  };
  if (typeof value.externalId === "string" && value.externalId.trim()) {
    link.externalId = value.externalId.trim();
  }
  if (typeof value.url === "string" && value.url.trim()) link.url = value.url.trim();
  if (typeof value.syncedAt === "string" && value.syncedAt.trim()) {
    link.syncedAt = normalizeDateTime(value.syncedAt);
  }
  if (value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)) {
    link.metadata = value.metadata as Record<string, unknown>;
  }
  return link;
}

function mapProject(row: TaskProjectRow): TaskProject {
  return {
    id: row.id,
    name: row.name,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row: TaskRow): TaskItem {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    description: row.description,
    details: row.details,
    dueAt: row.due_at,
    status: row.status,
    externalLinks: decodeExternalLinks(row.external_links),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function resolveDueAt(dueAt?: string | null, dueInDays?: number | null): string {
  if (dueAt?.trim()) return normalizeDateTime(dueAt);
  if (dueInDays !== undefined && dueInDays !== null) {
    if (!Number.isFinite(dueInDays)) throw new Error("dueInDays must be finite");
    const date = new Date();
    date.setDate(date.getDate() + Math.trunc(dueInDays));
    return date.toISOString();
  }
  return localTodayStartIso();
}

function normalizeDateTime(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Date/time value is required");
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return localDateStart(trimmed).toISOString();
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date/time: ${value}`);
  return date.toISOString();
}

type RangeClause =
  | { kind: "none" }
  | { kind: "lt"; before: string }
  | { kind: "between"; start: string; end: string }
  | { kind: "date-window"; startInclusive: string; endExclusive: string };

function buildRange(options: ListTasksOptions): RangeClause {
  const preset =
    options.preset ??
    (options.startDate || options.endDate || options.startAt || options.endAt ? "between" : "all");
  if (preset === "all") return { kind: "none" };
  const today = localTodayStart();
  if (preset === "overdue") return { kind: "lt", before: today.toISOString() };
  if (preset === "today") return dateWindow(today, 1);
  if (preset === "tomorrow") return dateWindow(addDays(today, 1), 1);
  if (preset === "next_days") {
    const days = Math.max(1, Math.trunc(options.days ?? 7));
    return dateWindow(today, days);
  }

  if (options.startDate || options.endDate) {
    const start = localDateStart(options.startDate ?? options.endDate!);
    const end = localDateStart(options.endDate ?? options.startDate!);
    return {
      kind: "date-window",
      startInclusive: start.toISOString(),
      endExclusive: addDays(end, 1).toISOString(),
    };
  }

  const start = normalizeDateTime(options.startAt ?? options.endAt ?? nowIso());
  const end = normalizeDateTime(options.endAt ?? options.startAt ?? nowIso());
  return { kind: "between", start, end };
}

function dateWindow(start: Date, days: number): RangeClause {
  return {
    kind: "date-window",
    startInclusive: start.toISOString(),
    endExclusive: addDays(start, days).toISOString(),
  };
}

function localTodayStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function localDateStart(date: string): Date {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  if (!year || !month || !day) throw new Error(`Invalid date: ${date}`);
  return new Date(year, month - 1, day);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function renderMarkdown(projects: Array<TaskProject & { tasks: TaskItem[] }>): string {
  const lines = ["# Active Tasks", "", `Generated: ${nowIso()}`, ""];
  if (projects.length === 0) {
    lines.push("No active tasks.", "");
    return lines.join("\n");
  }
  for (const project of projects) {
    lines.push(`## ${project.name}`, "");
    for (const task of project.tasks) {
      lines.push(`- [ ] ${task.description} _(due ${task.dueAt})_ <!-- task:${task.id} -->`);
      if (task.details) lines.push(`  - ${task.details.replace(/\n/g, "\n  - ")}`);
      if (task.externalLinks.length > 0) {
        const links = task.externalLinks
          .map((link) => [link.system, link.externalId, link.url].filter(Boolean).join(":"))
          .join(", ");
        lines.push(`  - External: ${links}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.tmp-${path.basename(filePath)}-${process.pid}`);
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}
