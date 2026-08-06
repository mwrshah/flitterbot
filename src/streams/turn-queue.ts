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

export function isCoalescableUserInput(item: QueueItem): boolean {
  if (item.sender !== "user") return false;
  if (item.source !== "web" && item.source !== "whatsapp") return false;
  if (item.images && item.images.length > 0) return false;
  return true;
}

function queueItemRemoteJid(item: QueueItem): string | undefined {
  const value = item.metadata?.remote_jid;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function hasSameReplyTarget(a: QueueItem, b: QueueItem): boolean {
  return (queueItemRemoteJid(a) ?? null) === (queueItemRemoteJid(b) ?? null);
}

export function coalesceUserItems(items: QueueItem[]): QueueItem {
  if (items.length === 0) throw new Error("coalesceUserItems: empty group");
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const metadata: MessageMetadata = {};
  for (const it of items) {
    if (it.metadata) Object.assign(metadata, it.metadata);
  }
  metadata.coalescedFrom = items.map((it) => it.id);
  return {
    id: `coalesced:${first.id}+${items.length - 1}`,
    source: first.source,
    sender: "user",
    text: items.map((it) => it.text).join("\n"),
    metadata,
    receivedAt: first.receivedAt,
    webClientId: last.webClientId,
    images: undefined,
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

type TurnQueueOptions = {
  process: (item: QueueItem) => Promise<void>;
  steer: (item: QueueItem) => Promise<void>;
  canSteer: () => boolean;
  onItemStart?: (item: QueueItem) => void;
  onItemEnd?: (item: QueueItem, error?: unknown, steered?: boolean) => void;
};

export class TurnQueue {
  private readonly items: QueueItem[] = [];
  private readonly processItem: TurnQueueOptions["process"];
  private readonly steerItem: TurnQueueOptions["steer"];
  private readonly canSteer: TurnQueueOptions["canSteer"];
  private readonly onItemStart?: TurnQueueOptions["onItemStart"];
  private readonly onItemEnd?: TurnQueueOptions["onItemEnd"];
  private processing = false;
  private steering = false;
  private steeringEnabled = false;
  private stopped = false;
  private currentItem?: QueueItem;

  constructor(options: TurnQueueOptions) {
    this.processItem = options.process;
    this.steerItem = options.steer;
    this.canSteer = options.canSteer;
    this.onItemStart = options.onItemStart;
    this.onItemEnd = options.onItemEnd;
  }

  enqueue(item: QueueItem): void {
    if (this.stopped) {
      throw new Error("turn queue is stopped");
    }

    this.items.push(item);
    if (this.processing) {
      if (item.source !== "hook" && this.steeringEnabled) void this.steerPending();
    } else {
      void this.pump();
    }
  }

  getDepth(): number {
    return this.items.length;
  }

  isBusy(): boolean {
    return this.processing;
  }

  getCurrentItem(): QueueItem | undefined {
    return this.currentItem;
  }

  enableSteering(): void {
    if (!this.processing || this.stopped) return;
    this.steeringEnabled = true;
    void this.steerPending();
  }

  steerPendingHooks(): void {
    if (!this.processing || this.stopped || !this.canSteer()) return;
    const hooks = this.items.filter((item) => item.source === "hook");
    if (hooks.length === 0) return;
    this.items.splice(0, this.items.length, ...this.items.filter((item) => item.source !== "hook"));
    const item = coalesceHookItems(hooks);
    void this.steerItem(item).then(
      () => this.onItemEnd?.(item, undefined, true),
      (error) => this.onItemEnd?.(item, error, true),
    );
  }

  getPendingItems(): QueueItem[] {
    return [...this.items];
  }

  stop(): void {
    this.stopped = true;
  }

  private async pump(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;
    while (!this.stopped && this.items.length > 0) {
      const item = this.drainNextAt(0);
      this.currentItem = item;
      this.steeringEnabled = false;
      this.onItemStart?.(item);
      try {
        await this.processItem(item);
        this.onItemEnd?.(item);
      } catch (error) {
        this.onItemEnd?.(item, error);
      } finally {
        this.currentItem = undefined;
      }
    }
    this.processing = false;
    this.steeringEnabled = false;
  }

  private async steerPending(): Promise<void> {
    if (this.steering || this.stopped) return;
    this.steering = true;
    await Promise.resolve();
    try {
      let index = this.items.findIndex((item) => item.source !== "hook");
      while (this.processing && !this.stopped && this.canSteer() && index !== -1) {
        const item = this.drainNextAt(index);
        try {
          await this.steerItem(item);
          this.onItemEnd?.(item, undefined, true);
        } catch (error) {
          this.onItemEnd?.(item, error, true);
        }
        index = this.items.findIndex((item) => item.source !== "hook");
      }
    } finally {
      this.steering = false;
      if (
        this.processing &&
        !this.stopped &&
        this.canSteer() &&
        this.items.some((item) => item.source !== "hook")
      ) {
        void this.steerPending();
      }
    }
  }

  private drainNextAt(index: number): QueueItem {
    const head = this.items.splice(index, 1)[0]!;
    if (!isCoalescableUserInput(head)) return head;
    const group: QueueItem[] = [head];
    while (index < this.items.length) {
      const next = this.items[index]!;
      if (!isCoalescableUserInput(next)) break;
      if ((next.streamId ?? null) !== (head.streamId ?? null)) break;
      if (!hasSameReplyTarget(head, next)) break;
      group.push(this.items.splice(index, 1)[0]!);
    }
    return group.length === 1 ? head : coalesceUserItems(group);
  }
}
