import type { PiRuntimeStatus } from "../contracts/index.ts";
import type { QueueItem } from "./turn-queue.ts";

type PiRuntimeSnapshot = Omit<PiRuntimeStatus, "sessionId" | "sessionFile" | "lastPromptAt"> & {
  sessionId?: string;
  sessionFile?: string;
  lastPromptAt?: string;
  lastEventAt?: string;
  currentItem?: QueueItem;
  currentTurnStartedAt?: string;
};

export class PiSessionState {
  private snapshot: PiRuntimeSnapshot = {
    messageCount: 0,
    busy: false,
  };

  initialize(sessionId: string, sessionFile: string | undefined, messageCount: number): void {
    this.snapshot.sessionId = sessionId;
    this.snapshot.sessionFile = sessionFile;
    this.snapshot.messageCount = messageCount;
    this.snapshot.lastEventAt = new Date().toISOString();
  }

  notePrompt(messageCount: number): string {
    const now = new Date().toISOString();
    this.snapshot.lastPromptAt = now;
    this.snapshot.lastEventAt = now;
    this.snapshot.messageCount = messageCount;
    return now;
  }

  noteEvent(messageCount?: number): string {
    const now = new Date().toISOString();
    this.snapshot.lastEventAt = now;
    if (typeof messageCount === "number") this.snapshot.messageCount = messageCount;
    return now;
  }

  setBusy(busy: boolean, item?: QueueItem): void {
    this.snapshot.busy = busy;
    this.snapshot.currentItem = item;
    this.snapshot.currentTurnStartedAt = busy ? new Date().toISOString() : undefined;
    if (!busy) {
      this.snapshot.currentItem = undefined;
    }
  }

  getSnapshot(): PiRuntimeSnapshot {
    return { ...this.snapshot };
  }
}
