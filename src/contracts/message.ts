export type MessageSource = "whatsapp" | "web" | "hook" | "cron" | "init" | "agent" | "pi_outbound";

export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string };

export interface UnifiedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  blocks?: MessageBlock[];
  images?: Array<{ data: string; mimeType: string }>;
  source: MessageSource;
  workstreamId?: string;
  workstreamName?: string;
  createdAt: string;
  intermediate?: boolean;
  textDelta?: string;
  metadata?: Record<string, unknown>;
}
