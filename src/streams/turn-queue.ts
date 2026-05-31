import type { DeliveryMode, MessageMetadata, MessageSource } from "../contracts/index.ts";

export type QueueSource = MessageSource;

export type QueueItem = {
  id: string;
  source: QueueSource;
  sender?: "user" | "system";
  text: string;
  metadata?: MessageMetadata;
  receivedAt: string;
  webClientId?: string;
  deliveryMode?: DeliveryMode;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  streamId?: string;
  streamName?: string;
  serverMessageId?: string;
  clientMessageId?: string;
};

export function isCoalescableUserInput(item: QueueItem): boolean {
  if (item.sender !== "user") return false;
  if (item.source !== "web" && item.source !== "whatsapp") return false;
  if (item.deliveryMode === "steer") return false;
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
  if (last.serverMessageId) metadata.serverMessageId = last.serverMessageId;
  return {
    id: `coalesced:${first.id}+${items.length - 1}`,
    source: first.source,
    sender: "user",
    text: items.map((it) => it.text).join("\n"),
    metadata,
    receivedAt: first.receivedAt,
    webClientId: last.webClientId,
    deliveryMode: first.deliveryMode,
    images: undefined,
    streamId: first.streamId,
    streamName: first.streamName,
    serverMessageId: last.serverMessageId,
    clientMessageId: last.clientMessageId,
  };
}

type TurnQueueOptions = {
  process: (item: QueueItem) => Promise<void>;
  onItemStart?: (item: QueueItem) => void;
  onItemEnd?: (item: QueueItem, error?: unknown) => void;
};

export class TurnQueue {
  private readonly items: QueueItem[] = [];
  private readonly processItem: TurnQueueOptions["process"];
  private readonly onItemStart?: TurnQueueOptions["onItemStart"];
  private readonly onItemEnd?: TurnQueueOptions["onItemEnd"];
  private processing = false;
  private stopped = false;
  private currentItem?: QueueItem;

  constructor(options: TurnQueueOptions) {
    this.processItem = options.process;
    this.onItemStart = options.onItemStart;
    this.onItemEnd = options.onItemEnd;
  }

  enqueue(item: QueueItem): void {
    if (this.stopped) {
      throw new Error("turn queue is stopped");
    }

    if (item.deliveryMode === "steer" && this.processing) {
      void this.processItem(item).catch((error) => {
        this.onItemEnd?.(item, error);
      });
      return;
    }

    this.items.push(item);
    void this.pump();
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
      const item = this.drainNext();
      this.currentItem = item;
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
  }

  private drainNext(): QueueItem {
    const head = this.items.shift()!;
    if (!isCoalescableUserInput(head)) return head;
    const group: QueueItem[] = [head];
    while (this.items.length > 0) {
      const next = this.items[0]!;
      if (!isCoalescableUserInput(next)) break;
      if ((next.streamId ?? null) !== (head.streamId ?? null)) break;
      if (!hasSameReplyTarget(head, next)) break;
      group.push(this.items.shift()!);
    }
    return group.length === 1 ? head : coalesceUserItems(group);
  }
}
