import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getWhatsAppConfigPath, getWhatsAppHome } from "./paths.ts";

export type WhatsAppUsersConfig = Record<string, string[]>;

export type WhatsAppConfig = {
  defaultUser?: string;
  users: WhatsAppUsersConfig;
  pairingPhoneNumber?: string;
  typingDelayMs: number;
  daemonStartupTimeoutMs: number;
};

type WhatsAppConfigJson = {
  defaultUser?: string;
  users?: Record<string, unknown>;
  pairingPhoneNumber?: string;
  typingDelayMs?: number;
  daemonStartupTimeoutMs?: number;
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

function readJsonObject(filePath: string): WhatsAppConfigJson {
  if (!existsSync(filePath)) {
    return {};
  }

  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return {};
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`WhatsApp config must be a JSON object: ${filePath}`);
  }

  return parsed as WhatsAppConfigJson;
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
    throw new Error(`Invalid phone number: ${value}`);
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

export function loadWhatsAppConfig(configPath = getWhatsAppConfigPath()): WhatsAppConfig {
  ensureWhatsAppHome();
  const raw = readJsonObject(configPath);

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

export function resolveAcceptedInboundJids(config = loadWhatsAppConfig()): string[] {
  const selfJid = config.defaultUser ? resolveSelfJid(config) : undefined;
  return unique([...Object.values(config.users).flat(), ...(selfJid ? [selfJid] : [])]);
}

export function resolveUserForJid(
  remoteJid: string,
  config = loadWhatsAppConfig(),
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

export function resolveBroadcastJidsForUser(
  userId: string,
  config = loadWhatsAppConfig(),
): string[] {
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

export function resolvePairingPhoneNumber(config = loadWhatsAppConfig()): string {
  if (!config.pairingPhoneNumber) {
    throw new Error(
      `Missing pairing phone number. Set pairingPhoneNumber in ${path.join(getWhatsAppHome(), "config.json")}.`,
    );
  }

  return normalizePhoneNumber(config.pairingPhoneNumber.replace(/@s\.whatsapp\.net$/, ""));
}
