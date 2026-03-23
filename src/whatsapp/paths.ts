import { homedir } from "node:os";
import path from "node:path";

export function getWhatsAppHome(): string {
  return path.join(homedir(), ".autonoma", "whatsapp");
}

export function getWhatsAppAuthDir(): string {
  return path.join(getWhatsAppHome(), "auth");
}

export function getWhatsAppAuthBackupDir(): string {
  return path.join(getWhatsAppHome(), "auth-backup");
}

export function getWhatsAppConfigPath(): string {
  return path.join(getWhatsAppHome(), "config.json");
}

export function getWhatsAppSocketPath(): string {
  return path.join(getWhatsAppHome(), "daemon.sock");
}

export function getWhatsAppPidPath(): string {
  return path.join(getWhatsAppHome(), "daemon.pid");
}

export function getWhatsAppLogPath(): string {
  return path.join(homedir(), ".autonoma", "logs", "whatsapp-daemon.log");
}

export function getWhatsAppStatusSignalPath(): string {
  return path.join(getWhatsAppHome(), "status.signal");
}
