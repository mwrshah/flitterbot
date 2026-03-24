import type { DatabaseSync } from "node:sqlite";
import type { PendingActionRow, WhatsAppMessageRow } from "../contracts/index.ts";

type SqlDatabase = Pick<DatabaseSync, "prepare">;

function maybeRow<T>(result: unknown): T | undefined {
  return result as T | undefined;
}

export function getWhatsAppMessageByWaMessageId(
  db: SqlDatabase,
  waMessageId: string,
): WhatsAppMessageRow | undefined {
  return maybeRow<WhatsAppMessageRow>(
    db
      .prepare(
        "SELECT * FROM whatsapp_messages WHERE wa_message_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(waMessageId),
  );
}

export function getLatestPendingAction(
  db: SqlDatabase,
  channel = "whatsapp",
): PendingActionRow | undefined {
  return maybeRow<PendingActionRow>(
    db
      .prepare(
        `SELECT *
       FROM pending_actions
       WHERE channel = ?
         AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
      )
      .get(channel),
  );
}

export function getPendingActionByContextRef(
  db: SqlDatabase,
  contextRef: string,
): PendingActionRow | undefined {
  return maybeRow<PendingActionRow>(
    db
      .prepare(
        `SELECT *
       FROM pending_actions
       WHERE context_ref = ?
         AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
      )
      .get(contextRef),
  );
}

export function getLatestOutboundMessage(
  db: SqlDatabase,
  remoteJid?: string,
): WhatsAppMessageRow | undefined {
  return maybeRow<WhatsAppMessageRow>(
    remoteJid
      ? db
          .prepare(
            `SELECT *
         FROM whatsapp_messages
         WHERE direction = 'outbound'
           AND remote_jid = ?
         ORDER BY created_at DESC
         LIMIT 1`,
          )
          .get(remoteJid)
      : db
          .prepare(
            `SELECT *
         FROM whatsapp_messages
         WHERE direction = 'outbound'
         ORDER BY created_at DESC
         LIMIT 1`,
          )
          .get(),
  );
}

export function getLatestOutboundWithContext(db: SqlDatabase): WhatsAppMessageRow | undefined {
  return maybeRow<WhatsAppMessageRow>(
    db
      .prepare(
        `SELECT *
       FROM whatsapp_messages
       WHERE direction = 'outbound'
         AND context_ref IS NOT NULL
         AND context_ref != ''
       ORDER BY created_at DESC
       LIMIT 1`,
      )
      .get(),
  );
}
