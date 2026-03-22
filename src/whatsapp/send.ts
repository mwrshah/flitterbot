import type {
  PendingActionRequest,
  SendWhatsAppRequest,
  SendWhatsAppResult,
} from "../contracts/index.ts";
import { sendDaemonCommand } from "./ipc.ts";

type SendViaDaemonOptions = {
  autoStart?: () => Promise<void>;
  pendingAction?: PendingActionRequest;
};

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /ENOENT|ECONNREFUSED|ENOTSOCK|socket/i.test(error.message);
}

export async function sendWhatsAppViaDaemon(
  request: SendWhatsAppRequest,
  options: SendViaDaemonOptions = {},
): Promise<SendWhatsAppResult> {
  try {
    const response = await sendDaemonCommand({
      command: "send",
      text: request.text,
      contextRef: request.contextRef,
      pendingAction: options.pendingAction,
    });

    return {
      ok: response.ok,
      messageId: response.messageId,
      rowId: response.rowId,
      contextRef: response.contextRef,
      status: response.status ?? "unknown",
      error: response.error,
    };
  } catch (error) {
    if (options.autoStart && isConnectionError(error)) {
      await options.autoStart();
      const response = await sendDaemonCommand({
        command: "send",
        text: request.text,
        contextRef: request.contextRef,
        pendingAction: options.pendingAction,
      });

      return {
        ok: response.ok,
        messageId: response.messageId,
        rowId: response.rowId,
        contextRef: response.contextRef,
        status: response.status ?? "unknown",
        error: response.error,
      };
    }

    throw error;
  }
}
