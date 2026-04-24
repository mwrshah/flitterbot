import type { DeliveryMode, MessageMetadata, MessageSource } from "../contracts/index.ts";

export type QueueSource = MessageSource;

export type QueueItem = {
  id: string;
  source: QueueSource;
  /**
   * Origin of this queue item.
   *   "user"   — real user input via message-input (web/whatsapp).
   *   "system" — hook, cron, agent enqueues, create_stream bootstrap prompts.
   * Used by pump() to decide whether an item is eligible for coalescing.
   */
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
  /**
   * Client-generated UUID for the optimistic UI bubble. Echoed back to the
   * originating web client on the user-role `message_end` WS envelope so
   * optimistic entries can be reconciled with their canonical server copy.
   */
  clientMessageId?: string;
};

/**
 * A QueueItem is coalescable iff it originated from real user input via
 * message-input (web/whatsapp), is not a steer, and carries no attachments.
 * Non-user enqueues (hook, agent tool calls, cron, bootstrap prompts) break
 * the run and are delivered on their own.
 */
export function isCoalescableUserInput(item: QueueItem): boolean {
  if (item.sender !== "user") return false;
  if (item.source !== "web" && item.source !== "whatsapp") return false;
  if (item.deliveryMode === "steer") return false;
  if (item.images && item.images.length > 0) return false;
  return true;
}

/**
 * Merge consecutive user-input items into a single delivery.
 *   - text:              joined with "\n"
 *   - metadata:          last-wins key merge + explicit `coalescedFrom` audit array
 *   - serverMessageId:   last in group (SDK stamps a single user entry; matches the
 *                        most recent optimistic UI bubble)
 *   - receivedAt/id:     first in group; id gets a `coalesced:` prefix for logs
 *   - webClientId:       last in group (for any correlation WS events on close)
 *   - streamId/Name:     first (all peers share stream — validated by caller)
 */
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
    // Last in group (same rationale as serverMessageId — the SDK stamps a
    // single user entry on delivery, which matches the most recent optimistic
    // UI bubble).
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

    // Steer messages bypass the queue and interrupt the current turn immediately
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

  /**
   * Pop the next delivery from the queue. When the head is a coalescable user
   * input, greedily drains consecutive coalescable peers from the same stream
   * into a single merged delivery. Non-user items are delivered one-by-one.
   */
  private drainNext(): QueueItem {
    const head = this.items.shift()!;
    if (!isCoalescableUserInput(head)) return head;
    const group: QueueItem[] = [head];
    while (this.items.length > 0) {
      const next = this.items[0]!;
      if (!isCoalescableUserInput(next)) break;
      if ((next.streamId ?? null) !== (head.streamId ?? null)) break;
      group.push(this.items.shift()!);
    }
    return group.length === 1 ? head : coalesceUserItems(group);
  }
}
