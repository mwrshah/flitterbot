import { chmodSync, mkdirSync } from "node:fs";
import type { JsonValue } from "../json-documents/store.ts";
import { getWhatsAppHome } from "./paths.ts";

export type WhatsAppUsersConfig = Record<string, string[]>;

export type WhatsAppConfig = {
  defaultUser?: string;
  users: WhatsAppUsersConfig;
  pairingPhoneNumber?: string;
  typingDelayMs: number;
  daemonStartupTimeoutMs: number;
};

const DEFAULT_WHATSAPP_CONFIG: WhatsAppConfig = {
  defaultUser: undefined,
  users: {},
  pairingPhoneNumber: undefined,
  typingDelayMs: 800,
  daemonStartupTimeoutMs: 8000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeWhatsAppConfig(input: unknown): Record<string, JsonValue> {
  if (!isRecord(input)) throw new Error("WhatsApp config must be a JSON object");
  const raw = { ...input };
  delete raw.recipientJid;
  delete raw.allowedJids;
  const keys = [
    "defaultUser",
    "users",
    "pairingPhoneNumber",
    "typingDelayMs",
    "daemonStartupTimeoutMs",
  ];
  if (Object.keys(raw).some((key) => !keys.includes(key)))
    throw new Error("Unknown WhatsApp config key");
  for (const key of ["defaultUser", "pairingPhoneNumber"]) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || !raw[key].trim()))
      throw new Error(`Invalid WhatsApp ${key}`);
  }
  for (const key of ["typingDelayMs", "daemonStartupTimeoutMs"]) {
    if (
      raw[key] !== undefined &&
      (typeof raw[key] !== "number" || !Number.isInteger(raw[key]) || (raw[key] as number) <= 0)
    )
      throw new Error(`Invalid WhatsApp ${key}`);
  }
  if (raw.users !== undefined) {
    if (!isRecord(raw.users)) throw new Error("Invalid WhatsApp users");
    for (const jids of Object.values(raw.users)) {
      if (!Array.isArray(jids) || jids.some((jid) => typeof jid !== "string" || !jid.trim()))
        throw new Error("Invalid WhatsApp user JIDs");
    }
  }
  const value = deriveWhatsAppConfig(raw);
  return {
    users: value.users,
    typingDelayMs: value.typingDelayMs,
    daemonStartupTimeoutMs: value.daemonStartupTimeoutMs,
    ...(value.defaultUser ? { defaultUser: value.defaultUser } : {}),
    ...(value.pairingPhoneNumber ? { pairingPhoneNumber: value.pairingPhoneNumber } : {}),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readJidList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
}

function readUsers(value: unknown): WhatsAppUsersConfig {
  if (!isRecord(value)) {
    return {};
  }

  const users: WhatsAppUsersConfig = {};
  for (const [userId, jids] of Object.entries(value)) {
    const cleaned = readJidList(jids).map(toWhatsAppJid);
    if (cleaned.length > 0) {
      users[userId] = unique(cleaned);
    }
  }
  return users;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizePhoneNumber(value: string): string {
  const normalized = value.replace(/[^\d]/g, "");
  if (!normalized) {
    throw new Error("Invalid WhatsApp phone number");
  }

  return normalized;
}

function toWhatsAppJid(value: string): string {
  if (value.includes("@")) {
    return value;
  }

  return `${normalizePhoneNumber(value)}@s.whatsapp.net`;
}

export function ensureWhatsAppHome(): string {
  const home = getWhatsAppHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  return home;
}

export function deriveWhatsAppConfig(raw: Record<string, unknown>): WhatsAppConfig {
  if (typeof raw.pairingPhoneNumber === "string") normalizePhoneNumber(raw.pairingPhoneNumber);
  return {
    defaultUser: readString(raw.defaultUser),
    users: readUsers(raw.users),
    pairingPhoneNumber: readString(raw.pairingPhoneNumber),
    typingDelayMs: readPositiveInt(raw.typingDelayMs, DEFAULT_WHATSAPP_CONFIG.typingDelayMs),
    daemonStartupTimeoutMs: readPositiveInt(
      raw.daemonStartupTimeoutMs,
      DEFAULT_WHATSAPP_CONFIG.daemonStartupTimeoutMs,
    ),
  };
}

function resolveSelfJid(config: WhatsAppConfig): string | undefined {
  return config.pairingPhoneNumber ? toWhatsAppJid(config.pairingPhoneNumber) : undefined;
}

export function resolveAcceptedInboundJids(config: WhatsAppConfig): string[] {
  const selfJid = config.defaultUser ? resolveSelfJid(config) : undefined;
  return unique([...Object.values(config.users).flat(), ...(selfJid ? [selfJid] : [])]);
}

export function resolveUserForJid(
  remoteJid: string,
  config: WhatsAppConfig,
): { userId: string; jids: string[] } | undefined {
  const normalized = toWhatsAppJid(remoteJid);
  const selfJid = resolveSelfJid(config);
  if (config.defaultUser && normalized === selfJid) {
    return { userId: config.defaultUser, jids: config.users[config.defaultUser] ?? [] };
  }

  for (const [userId, jids] of Object.entries(config.users)) {
    if (jids.includes(normalized)) {
      return { userId, jids };
    }
  }
  return undefined;
}

export function resolveBroadcastJidsForUser(userId: string, config: WhatsAppConfig): string[] {
  const jids = config.users[userId];
  if (!jids?.length) {
    throw new Error(`Unknown WhatsApp user: ${userId}`);
  }

  const phoneJids = jids.filter((jid) => jid.endsWith("@s.whatsapp.net"));
  if (phoneJids.length === 0) {
    throw new Error(`WhatsApp user ${userId} has no phone-number JID for outbound broadcast`);
  }

  return unique(phoneJids);
}

export function resolvePairingPhoneNumber(config: WhatsAppConfig): string {
  if (!config.pairingPhoneNumber) {
    throw new Error(
      "Missing pairing phone number. Set pairingPhoneNumber in WhatsApp configuration.",
    );
  }

  return normalizePhoneNumber(config.pairingPhoneNumber.replace(/@s\.whatsapp\.net$/, ""));
}
