import type { PendingActionKind } from "./blackboard.ts";
import type { WhatsAppDaemonStatus as ControlSurfaceWhatsAppStatus } from "./control-surface-api.ts";

export type WhatsAppConnectionStatus = Exclude<ControlSurfaceWhatsAppStatus, "unknown">;

export interface WhatsAppDaemonRuntimeStatus {
  ok: boolean;
  pid: number;
  status: WhatsAppConnectionStatus;
  recipientJid?: string;
  managedByControlSurface?: boolean;
  socketPath: string;
  authPath: string;
  startedAt: string;
  connectedAt?: string;
  lastDisconnectAt?: string;
  reconnectAttempt: number;
  lastError?: string;
  requiresManualAuth: boolean;
}

export interface SendWhatsAppRequest {
  text: string;
  contextRef?: string;
}

export interface SendWhatsAppResult {
  ok: boolean;
  messageId?: string;
  rowId?: number;
  contextRef?: string;
  status: string;
  error?: string;
}

export interface PendingActionRequest {
  kind: PendingActionKind;
  promptText: string;
  relatedSessionId?: string;
  relatedTodoistTaskId?: string;
}

export type DaemonCommand =
  | { command: "status" }
  | { command: "shutdown" }
  | {
      command: "send";
      text: string;
      contextRef?: string;
      pendingAction?: PendingActionRequest;
    };

export interface DaemonResponse {
  ok: boolean;
  status?: string;
  error?: string;
  pid?: number;
  messageId?: string;
  rowId?: number;
  contextRef?: string;
  daemon?: WhatsAppDaemonRuntimeStatus;
}
