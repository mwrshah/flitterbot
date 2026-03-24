import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getWhatsAppConfigPath, getWhatsAppHome } from "./paths.ts";

type WhatsAppConfig = {
  recipientJid?: string;
  pairingPhoneNumber?: string;
  typingDelayMs: number;
  daemonStartupTimeoutMs: number;
};

type WhatsAppConfigJson = {
  recipientJid?: string;
  pairingPhoneNumber?: string;
  typingDelayMs?: number;
  daemonStartupTimeoutMs?: number;
};

const DEFAULT_WHATSAPP_CONFIG: WhatsAppConfig = {
  recipientJid: undefined,
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

function normalizePhoneNumber(value: string): string {
  const normalized = value.replace(/[^\d]/g, "");
  if (!normalized) {
    throw new Error(`Invalid phone number: ${value}`);
  }

  return normalized;
}

function toWhatsAppJid(value: string): string {
  if (value.endsWith("@s.whatsapp.net")) {
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

  const recipientJid = readString(raw.recipientJid);

  return {
    recipientJid,
    pairingPhoneNumber: readString(raw.pairingPhoneNumber),
    typingDelayMs: readPositiveInt(raw.typingDelayMs, DEFAULT_WHATSAPP_CONFIG.typingDelayMs),
    daemonStartupTimeoutMs: readPositiveInt(
      raw.daemonStartupTimeoutMs,
      DEFAULT_WHATSAPP_CONFIG.daemonStartupTimeoutMs,
    ),
  };
}

export function resolveRecipientJid(config = loadWhatsAppConfig()): string {
  if (config.recipientJid) {
    return toWhatsAppJid(config.recipientJid);
  }

  throw new Error(
    `Missing recipient configuration. Set recipientJid in ${path.join(getWhatsAppHome(), "config.json")}.`,
  );
}

export function resolvePairingPhoneNumber(config = loadWhatsAppConfig()): string {
  const value = config.pairingPhoneNumber ?? config.recipientJid;
  if (!value) {
    throw new Error(
      "Missing pairing phone number. Set pairingPhoneNumber in ~/.autonoma/whatsapp/config.json.",
    );
  }

  return normalizePhoneNumber(value.replace(/@s\.whatsapp\.net$/, ""));
}
