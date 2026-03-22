import type { DeliveryMode, MessageSource } from "../../contracts/index.ts";

export type QueueSource = MessageSource;

export type QueueItem = {
  id: string;
  source: QueueSource;
  text: string;
  metadata?: Record<string, unknown>;
  receivedAt: string;
  webClientId?: string;
  deliveryMode?: DeliveryMode;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
};

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

    // Steer messages bypass the queue and interrupt the current turn immediately
    if (item.deliveryMode === "steer" && this.processing) {
      void this.processItem(item).catch(() => {});
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

  stop(): void {
    this.stopped = true;
  }

  private async pump(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;
    while (!this.stopped && this.items.length > 0) {
      const item = this.items.shift()!;
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
}
