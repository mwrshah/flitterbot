import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PendingActionRow } from "../contracts/index.ts";
import { getLatestPendingAction, getPendingActionByContextRef } from "./query-whatsapp.ts";

type SqlDatabase = Pick<DatabaseSync, "prepare">;

type CreatePendingActionInput = {
  actionId?: string;
  channel: string;
  contextRef?: string;
  kind: string;
  promptText: string;
  relatedSessionId?: string;
  relatedTodoistTaskId?: string;
  createdAt?: string;
};

function timestamp(value?: string): string {
  return value ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function createPendingAction(
  db: SqlDatabase,
  input: CreatePendingActionInput,
): PendingActionRow {
  const actionId = input.actionId ?? randomUUID();
  const contextRef = input.contextRef ?? actionId;
  const createdAt = timestamp(input.createdAt);

  db.prepare(
    `INSERT INTO pending_actions (
      action_id,
      channel,
      context_ref,
      kind,
      prompt_text,
      related_session_id,
      related_todoist_task_id,
      status,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    actionId,
    input.channel,
    contextRef,
    input.kind,
    input.promptText,
    input.relatedSessionId ?? null,
    input.relatedTodoistTaskId ?? null,
    createdAt,
  );

  return db
    .prepare("SELECT * FROM pending_actions WHERE action_id = ?")
    .get(actionId) as unknown as PendingActionRow;
}

export function resolvePendingActionByContextRef(
  db: SqlDatabase,
  contextRef: string,
  resolutionPayload: Record<string, unknown>,
  resolvedAt?: string,
): PendingActionRow | undefined {
  const action = getPendingActionByContextRef(db, contextRef);
  if (!action) {
    return undefined;
  }

  const effectiveResolvedAt = timestamp(resolvedAt);
  db.prepare(
    `UPDATE pending_actions
     SET status = 'resolved',
         resolved_at = ?,
         resolution_payload = ?
     WHERE action_id = ?`,
  ).run(effectiveResolvedAt, JSON.stringify(resolutionPayload), action.action_id);

  return db
    .prepare("SELECT * FROM pending_actions WHERE action_id = ?")
    .get(action.action_id) as unknown as PendingActionRow;
}

export function resolveLatestPendingAction(
  db: SqlDatabase,
  resolutionPayload: Record<string, unknown>,
  resolvedAt?: string,
): PendingActionRow | undefined {
  const action = getLatestPendingAction(db, "whatsapp");
  if (!action) {
    return undefined;
  }

  const contextRef = action.context_ref ?? action.action_id;
  return resolvePendingActionByContextRef(db, contextRef, resolutionPayload, resolvedAt);
}
