import type { DatabaseSync } from "node:sqlite";
import type { WAMessage } from "@whiskeysockets/baileys";
import pino from "pino";

type SqlDatabase = Pick<DatabaseSync, "prepare">;

import {
  getLatestOutboundMessage,
  getWhatsAppMessageByWaMessageId,
} from "../blackboard/queries/whatsapp.ts";
import {
  insertInboundWhatsAppMessage,
  resolveInboundContextRef,
} from "../blackboard/writers/whatsapp-writer.ts";
import { loadConfig } from "../config/load-config.ts";
import { resolveRecipientJid } from "./config.ts";

const logger = pino({ level: process.env.AUTONOMA_WA_LOG_LEVEL ?? "info" });
const OUTBOUND_ECHO_WINDOW_MS = 5_000;

function previewBody(value: string, max = 160): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function parseTimestamp(value?: string | null): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function shouldFilterRecentOutboundEcho(db: SqlDatabase, message: WAMessage): boolean {
  if (!message.key.fromMe) {
    return false;
  }

  const latestOutbound = getLatestOutboundMessage(db, message.key.remoteJid ?? undefined);
  const outboundTimestamp = parseTimestamp(latestOutbound?.created_at);
  if (!latestOutbound || outboundTimestamp === undefined) {
    return false;
  }

  return Date.now() - outboundTimestamp <= OUTBOUND_ECHO_WINDOW_MS;
}

function unwrapMessageContent(message: WAMessage): Record<string, unknown> | undefined {
  let content = message.message as Record<string, unknown> | undefined;

  while (content) {
    const nested =
      (content.ephemeralMessage as { message?: Record<string, unknown> } | undefined)?.message ??
      (content.viewOnceMessage as { message?: Record<string, unknown> } | undefined)?.message ??
      (content.viewOnceMessageV2 as { message?: Record<string, unknown> } | undefined)?.message ??
      (content.viewOnceMessageV2Extension as { message?: Record<string, unknown> } | undefined)
        ?.message ??
      (content.documentWithCaptionMessage as { message?: Record<string, unknown> } | undefined)
        ?.message;

    if (!nested) {
      break;
    }

    content = nested;
  }

  return content;
}

function extractConversationBody(message: WAMessage): string | undefined {
  const content = unwrapMessageContent(message) as
    | {
        conversation?: string;
        extendedTextMessage?: { text?: string };
        imageMessage?: { caption?: string };
        videoMessage?: { caption?: string };
        documentMessage?: { caption?: string };
      }
    | undefined;

  if (!content) {
    return undefined;
  }

  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    undefined
  )?.trim();
}

function extractQuotedWaMessageId(message: WAMessage): string | undefined {
  const content = unwrapMessageContent(message) as
    | {
        extendedTextMessage?: { contextInfo?: { stanzaId?: string } };
        imageMessage?: { contextInfo?: { stanzaId?: string } };
        videoMessage?: { contextInfo?: { stanzaId?: string } };
      }
    | undefined;

  return (
    content?.extendedTextMessage?.contextInfo?.stanzaId ??
    content?.imageMessage?.contextInfo?.stanzaId ??
    content?.videoMessage?.contextInfo?.stanzaId ??
    undefined
  );
}

export function getInboundMessageRejectionReason(message: WAMessage): string | undefined {
  const remoteJid = message.key.remoteJid;
  if (!remoteJid) {
    return "missing_remote_jid";
  }
  if (remoteJid !== resolveRecipientJid()) {
    return `unexpected_remote_jid:${remoteJid}`;
  }
  return undefined;
}

export function shouldAcceptInboundMessage(message: WAMessage): boolean {
  return getInboundMessageRejectionReason(message) === undefined;
}

async function forwardInboundToControlSurface(input: {
  body: string;
  waMessageId?: string;
  contextRef?: string;
  remoteJid: string;
}): Promise<void> {
  const config = loadConfig();
  const url = `http://127.0.0.1:${config.controlSurfacePort}/message`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.controlSurfaceToken) {
    headers.Authorization = `Bearer ${config.controlSurfaceToken}`;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: input.body,
        source: "whatsapp",
        metadata: {
          wa_message_id: input.waMessageId,
          context_ref: input.contextRef,
          remote_jid: input.remoteJid,
        },
      }),
    });

    const responseText = await response.text();
    if (!response.ok) {
      logger.error(
        {
          url,
          status: response.status,
          waMessageId: input.waMessageId,
          contextRef: input.contextRef,
          remoteJid: input.remoteJid,
          responseBody: responseText,
          bodyPreview: previewBody(input.body),
        },
        "failed to forward inbound WhatsApp message to control surface",
      );
      return;
    }

    logger.info(
      {
        status: response.status,
        waMessageId: input.waMessageId,
        contextRef: input.contextRef,
        remoteJid: input.remoteJid,
        responseBody: responseText,
        bodyPreview: previewBody(input.body),
      },
      "forwarded inbound WhatsApp message to control surface",
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        url,
        waMessageId: input.waMessageId,
        contextRef: input.contextRef,
        remoteJid: input.remoteJid,
        bodyPreview: previewBody(input.body),
      },
      "network error forwarding inbound WhatsApp message to control surface",
    );
  }
}

export async function persistInboundMessage(
  db: SqlDatabase,
  message: WAMessage,
): Promise<{ body?: string; contextRef?: string; rowId?: number }> {
  const waMessageId = message.key.id;
  const remoteJid = message.key.remoteJid ?? resolveRecipientJid();

  // Extract body first — no DB needed for this check
  const body = extractConversationBody(message);
  if (!body) {
    logger.info(
      { waMessageId, remoteJid },
      "ignored inbound WhatsApp message without supported text body",
    );
    return {};
  }

  // Filter echoes and duplicates BEFORE forwarding to control surface
  try {
    if (shouldFilterRecentOutboundEcho(db, message)) {
      logger.info(
        {
          waMessageId,
          remoteJid,
          bodyPreview: previewBody(body),
          windowMs: OUTBOUND_ECHO_WINDOW_MS,
        },
        "outbound echo — skipping forward and persistence",
      );
      return { body };
    }

    if (waMessageId) {
      const existing = getWhatsAppMessageByWaMessageId(db, waMessageId);
      if (existing?.direction === "inbound") {
        logger.info(
          { rowId: existing.id, waMessageId, remoteJid: existing.remote_jid },
          "duplicate inbound WhatsApp message — skipping forward and persistence",
        );
        return { body, contextRef: existing.context_ref ?? undefined, rowId: existing.id };
      }
    }
  } catch (error) {
    logger.error(
      { err: error, waMessageId, remoteJid, bodyPreview: previewBody(body) },
      "failed echo/duplicate check — skipping message to be safe",
    );
    return { body };
  }

  // Forward to control surface only after echo/duplicate filtering
  await forwardInboundToControlSurface({ body, waMessageId, remoteJid });

  // Persist to blackboard as a secondary concern
  try {
    const quotedWaMessageId = extractQuotedWaMessageId(message);
    const contextRef = resolveInboundContextRef(db, {
      quotedWaMessageId,
      fallbackChannel: "whatsapp",
    });
    const row = insertInboundWhatsAppMessage(db, { waMessageId, remoteJid, body, contextRef });

    logger.info(
      {
        rowId: row.id,
        waMessageId,
        remoteJid: row.remote_jid,
        contextRef,
        quotedWaMessageId,
        bodyPreview: previewBody(body),
      },
      "persisted inbound WhatsApp message",
    );

    return { body, contextRef, rowId: row.id };
  } catch (error) {
    logger.error(
      { err: error, waMessageId, remoteJid, bodyPreview: previewBody(body) },
      "failed to persist inbound WhatsApp message — message was already forwarded to control surface",
    );
    return { body };
  }
}
