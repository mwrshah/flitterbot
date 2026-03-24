import type { SendWhatsAppRequest, SendWhatsAppResult } from "../contracts/index.ts";
import { sendDaemonCommand } from "./ipc.ts";

/**
 * Send a WhatsApp message via the daemon IPC.
 * Used by the CLI. The runtime calls sendDaemonCommand directly
 * because it needs access to the full DaemonResponse (e.g. daemon status).
 */
export async function sendWhatsAppViaDaemon(
  request: SendWhatsAppRequest,
): Promise<SendWhatsAppResult> {
  const response = await sendDaemonCommand({
    command: "send",
    text: request.text,
    contextRef: request.contextRef,
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
