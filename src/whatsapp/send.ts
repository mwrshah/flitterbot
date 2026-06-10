import type { SendWhatsAppRequest, SendWhatsAppResult } from "../contracts/index.ts";
import { sendDaemonCommand } from "./ipc.ts";

export async function sendWhatsAppViaDaemon(
  request: SendWhatsAppRequest,
): Promise<SendWhatsAppResult> {
  const response = await sendDaemonCommand({
    command: "send",
    text: request.text,
    contextRef: request.contextRef,
    remoteJid: request.remoteJid,
    targetUserId: request.targetUserId,
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
