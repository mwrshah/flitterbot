import type { MessageMetadata, MessageSource } from "../contracts/index.ts";

export type QueueSource = MessageSource;

export type QueueItem = {
  id: string;
  source: QueueSource;
  sender?: "user" | "system";
  text: string;
  metadata?: MessageMetadata;
  receivedAt: string;
  webClientId?: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  streamId?: string;
  streamName?: string;
  serverMessageId?: string;
};

export type TurnQueueItemState = "open" | "accepting";

export type TurnQueueItem = Pick<
  QueueItem,
  "id" | "source" | "text" | "receivedAt" | "webClientId"
> & { state: TurnQueueItemState };

export type TurnQueueSnapshot = {
  version: number;
  items: TurnQueueItem[];
};

export function isCoalescableUserInput(item: QueueItem): boolean {
  if (item.sender !== "user") return false;
  return item.source === "web" || item.source === "whatsapp";
}

function queueItemRemoteJid(item: QueueItem): string | undefined {
  const value = item.metadata?.remote_jid;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function hasSameReplyTarget(a: QueueItem, b: QueueItem): boolean {
  return (queueItemRemoteJid(a) ?? null) === (queueItemRemoteJid(b) ?? null);
}

function canCoalesce(a: QueueItem, b: QueueItem): boolean {
  return (
    isCoalescableUserInput(a) &&
    isCoalescableUserInput(b) &&
    (a.streamId ?? null) === (b.streamId ?? null) &&
    hasSameReplyTarget(a, b)
  );
}

export function coalesceUserItems(items: QueueItem[]): QueueItem {
  if (items.length === 0) throw new Error("coalesceUserItems: empty group");
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const metadata: MessageMetadata = {};
  for (const item of items) {
    if (item.metadata) Object.assign(metadata, item.metadata);
  }
  metadata.coalescedFrom = items.map((item) => item.id);
  const images = items.flatMap((item) => item.images ?? []);
  return {
    id: `coalesced:${first.id}+${items.length - 1}`,
    source: first.source,
    sender: "user",
    text: items.map((item) => item.text).join("\n"),
    metadata,
    receivedAt: first.receivedAt,
    webClientId: last.webClientId,
    images: images.length > 0 ? images : undefined,
    streamId: first.streamId,
    streamName: first.streamName,
    serverMessageId: last.serverMessageId,
  };
}

function coalesceHookItems(items: QueueItem[]): QueueItem {
  if (items.length === 0) throw new Error("coalesceHookItems: empty group");
  if (items.length === 1) return items[0]!;
  const first = items[0]!;
  return {
    id: `coalesced:${first.id}+${items.length - 1}`,
    source: "hook",
    sender: "system",
    text: items.map((item) => item.text).join("\n\n-----\n\n"),
    metadata: {
      coalescedFrom: items.map((item) => item.id),
      hooks: items.map((item) => ({ id: item.id, metadata: item.metadata })),
    },
    receivedAt: first.receivedAt,
    streamId: first.streamId,
    streamName: first.streamName,
  };
}

type QueueEntry = { item: QueueItem; state: TurnQueueItemState };

type TurnQueueOptions = {
  process: (item: QueueItem, onAccepted: () => void) => Promise<void>;
  steer: (item: QueueItem) => Promise<void>;
  canSteer: () => boolean;
  onItemStart?: (item: QueueItem) => void;
  onItemEnd?: (item: QueueItem, error?: unknown, steered?: boolean, accepted?: boolean) => void;
  onChanged?: (snapshot: TurnQueueSnapshot) => void;
  initialVersion?: number;
};

export class TurnQueue {
  private readonly entries: QueueEntry[] = [];
  private readonly processItem: TurnQueueOptions["process"];
  private readonly steerItem: TurnQueueOptions["steer"];
  private readonly canSteer: TurnQueueOptions["canSteer"];
  private readonly onItemStart?: TurnQueueOptions["onItemStart"];
  private readonly onItemEnd?: TurnQueueOptions["onItemEnd"];
  private readonly onChanged?: TurnQueueOptions["onChanged"];
  private processing = false;
  private accepting = false;
  private readonly idleWaiters = new Set<() => void>();
  private readonly settlementWaiters = new Set<() => void>();
  private stopped = false;
  private admissionFreezeDepth = 0;
  private drainAcceptedAfterStop = false;
  private paused = false;
  private currentItem?: QueueItem;
  private version: number;
  private holdAfterCurrent = false;
  private resumeHeld = false;

  constructor(options: TurnQueueOptions) {
    this.processItem = options.process;
    this.steerItem = options.steer;
    this.canSteer = options.canSteer;
    this.onItemStart = options.onItemStart;
    this.onItemEnd = options.onItemEnd;
    this.onChanged = options.onChanged;
    this.version = options.initialVersion ?? 0;
  }

  assertAccepting(): void {
    if (this.stopped) throw new Error("turn queue is stopped");
    if (this.admissionFreezeDepth > 0) throw new Error("turn queue admission is frozen");
  }

  enqueue(item: QueueItem): void {
    this.assertAccepting();
    this.entries.push({ item, state: "open" });
    if (this.holdAfterCurrent && item.sender === "user") {
      if (this.processing) this.resumeHeld = true;
      else this.holdAfterCurrent = false;
    }
    if (!this.processing && !this.paused && !this.holdAfterCurrent) void this.pump();
    else this.changed();
  }

  getDepth(): number {
    return this.entries.length;
  }

  isBusy(): boolean {
    return this.processing;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  getCurrentItem(): QueueItem | undefined {
    return this.currentItem;
  }

  getSnapshot(): TurnQueueSnapshot {
    return {
      version: this.version,
      items: this.entries.flatMap(({ item, state }) =>
        item === this.currentItem
          ? []
          : [
              {
                id: item.id,
                source: item.source,
                text: item.text,
                receivedAt: item.receivedAt,
                ...(item.webClientId ? { webClientId: item.webClientId } : {}),
                state,
              },
            ],
      ),
    };
  }

  remove(itemId: string): {
    removed: boolean;
    accepting: boolean;
    snapshot: TurnQueueSnapshot;
  } {
    const index = this.entries.findIndex(({ item }) => item.id === itemId);
    if (index === -1) {
      return {
        removed: false,
        accepting: false,
        snapshot: this.getSnapshot(),
      };
    }
    if (this.entries[index]!.state === "accepting") {
      return {
        removed: false,
        accepting: true,
        snapshot: this.getSnapshot(),
      };
    }
    this.entries.splice(index, 1);
    this.changed();
    this.resolveWaiters();
    return {
      removed: true,
      accepting: false,
      snapshot: this.getSnapshot(),
    };
  }

  holdPendingAfterCurrent(): void {
    if (this.processing && !this.stopped) this.holdAfterCurrent = true;
  }

  async admitPendingSteering(): Promise<void> {
    if (
      this.accepting ||
      !this.processing ||
      !this.canProcessAcceptedItems() ||
      this.paused ||
      this.holdAfterCurrent ||
      !this.canSteer()
    ) {
      return;
    }

    const firstIndex = this.entries.findIndex(({ state }) => state === "open");
    if (firstIndex === -1) return;
    const first = this.entries[firstIndex]!.item;
    const leased: QueueEntry[] = [this.entries[firstIndex]!];
    if (first.source === "hook") {
      for (let index = firstIndex + 1; index < this.entries.length; index++) {
        const entry = this.entries[index]!;
        if (entry.state !== "open" || entry.item.source !== "hook") break;
        leased.push(entry);
      }
    } else if (isCoalescableUserInput(first)) {
      for (let index = firstIndex + 1; index < this.entries.length; index++) {
        const entry = this.entries[index]!;
        if (entry.state !== "open" || !canCoalesce(first, entry.item)) break;
        leased.push(entry);
      }
    }

    for (const entry of leased) entry.state = "accepting";
    this.accepting = true;
    this.changed();
    const admittedItem =
      first.source === "hook"
        ? coalesceHookItems(leased.map(({ item }) => item))
        : leased.length > 1
          ? coalesceUserItems(leased.map(({ item }) => item))
          : first;

    try {
      await this.steerItem(admittedItem);
      const leasedIds = new Set(leased.map(({ item }) => item.id));
      for (let index = this.entries.length - 1; index >= 0; index--) {
        if (leasedIds.has(this.entries[index]!.item.id)) this.entries.splice(index, 1);
      }
      this.changed();
      this.onItemEnd?.(admittedItem, undefined, true, true);
    } catch (error) {
      for (const entry of leased) entry.state = "open";
      this.changed();
      this.onItemEnd?.(admittedItem, error, true, false);
    } finally {
      this.accepting = false;
      this.resolveWaiters();
    }
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  waitForSettlement(): Promise<void> {
    if (this.isSettled()) return Promise.resolve();
    return new Promise((resolve) => this.settlementWaiters.add(resolve));
  }

  freezeAdmission(): void {
    if (this.stopped) throw new Error("turn queue is stopped");
    this.admissionFreezeDepth++;
  }

  restoreAdmission(): void {
    if (!this.stopped && this.admissionFreezeDepth > 0) this.admissionFreezeDepth--;
  }

  async stopAndWait(): Promise<void> {
    this.stopped = true;
    this.admissionFreezeDepth++;
    this.drainAcceptedAfterStop = true;
    this.paused = false;
    this.holdAfterCurrent = false;
    this.resumeHeld = false;
    if (!this.processing) void this.pump();
    await this.waitForIdle();
  }

  pause(): boolean {
    if (this.processing || this.stopped || this.paused || this.accepting) return false;
    this.paused = true;
    return true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (!this.holdAfterCurrent) void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.processing || !this.canProcessAcceptedItems() || this.paused) return;
    this.processing = true;
    try {
      while (this.canProcessAcceptedItems() && !this.paused && this.entries.length > 0) {
        const entry = this.entries[0]!;
        if (entry.state !== "open") break;
        entry.state = "accepting";
        const item = entry.item;
        this.currentItem = item;
        this.changed();
        let accepted = false;
        const markAccepted = () => {
          if (accepted) return;
          accepted = true;
          const index = this.entries.indexOf(entry);
          if (index !== -1) this.entries.splice(index, 1);
          this.changed();
        };
        this.onItemStart?.(item);
        let publishAfterCurrent = false;
        try {
          let itemError: unknown;
          try {
            await this.processItem(item, markAccepted);
          } catch (error) {
            itemError = error;
          }
          if (!accepted) {
            if (this.stopped) {
              const index = this.entries.indexOf(entry);
              if (index !== -1) this.entries.splice(index, 1);
            } else {
              entry.state = "open";
              this.holdAfterCurrent = true;
            }
            publishAfterCurrent = true;
          }
          this.onItemEnd?.(item, itemError, false, accepted);
        } finally {
          this.currentItem = undefined;
          if (publishAfterCurrent) this.changed();
        }
        if (this.holdAfterCurrent) {
          if (!this.resumeHeld) break;
          this.holdAfterCurrent = false;
          this.resumeHeld = false;
        }
      }
    } finally {
      this.processing = false;
      this.resolveWaiters();
    }
  }

  private canProcessAcceptedItems(): boolean {
    return !this.stopped || this.drainAcceptedAfterStop;
  }

  private isSettled(): boolean {
    return !this.processing && !this.accepting;
  }

  private isIdle(): boolean {
    return this.entries.length === 0 && this.isSettled();
  }

  private resolveWaiters(): void {
    if (this.isSettled()) {
      for (const resolve of this.settlementWaiters) resolve();
      this.settlementWaiters.clear();
    }
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private changed(): void {
    this.version++;
    this.onChanged?.(this.getSnapshot());
  }
}
