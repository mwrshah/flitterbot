import { readConfiguration } from "../config/documents.ts";
import { deriveWhatsAppConfig, ensureWhatsAppHome, type WhatsAppConfig } from "./config.ts";

export async function loadWhatsAppConfig(): Promise<WhatsAppConfig> {
  const raw = await readConfiguration("whatsapp-config");
  ensureWhatsAppHome();
  return deriveWhatsAppConfig(raw);
}
