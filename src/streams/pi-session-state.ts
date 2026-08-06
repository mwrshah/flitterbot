import type { PiSessionRuntimeStatus } from "../contracts/index.ts";
import type { QueueItem } from "./turn-queue.ts";

type PiSessionRuntimeSnapshot = Omit<
  PiSessionRuntimeStatus,
  "piSessionId" | "sessionFile" | "lastPromptAt" | "isCompacting"
> & {
  piSessionId?: string;
  sessionFile?: string;
  lastPromptAt?: string;
  lastEventAt?: string;
  currentItem?: QueueItem;
  currentTurnStartedAt?: string;
};

export class PiSessionState {
  private readonly steeredItems: QueueItem[] = [];
  private currentItemAwaitingUserMessage = false;
  private snapshot: PiSessionRuntimeSnapshot = {
    messageCount: 0,
    busy: false,
  };

  initialize(piSessionId: string, sessionFile: string | undefined, messageCount: number): void {
    this.steeredItems.length = 0;
    this.currentItemAwaitingUserMessage = false;
    this.snapshot.piSessionId = piSessionId;
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
    this.currentItemAwaitingUserMessage = busy && item?.source !== "hook";
    if (!busy) {
      this.snapshot.currentItem = undefined;
    }
  }

  addSteeredItem(item: QueueItem): void {
    this.steeredItems.push(item);
  }

  takeUserMessageItem(): QueueItem | undefined {
    if (this.currentItemAwaitingUserMessage) {
      this.currentItemAwaitingUserMessage = false;
      return this.snapshot.currentItem;
    }
    return this.steeredItems.shift();
  }

  peekUserMessageItem(): QueueItem | undefined {
    return this.currentItemAwaitingUserMessage ? this.snapshot.currentItem : this.steeredItems[0];
  }

  removeSteeredItem(item: QueueItem): void {
    const index = this.steeredItems.indexOf(item);
    if (index !== -1) this.steeredItems.splice(index, 1);
  }

  getSnapshot(): PiSessionRuntimeSnapshot {
    return { ...this.snapshot };
  }
}
