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
  const images = items.flatMap((item) => item.images ?? []);
  return {
    id: `coalesced:${first.id}+${items.length - 1}`,
    source: first.source,
    sender: "user",
    text: items.map((it) => it.text).join("\n"),
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
  private steeringTask?: Promise<void>;
  private readonly steeringChildren = new Set<Promise<void>>();
  private readonly idleWaiters = new Set<() => void>();
  private steeringEnabled = false;
  private stopped = false;
  private admissionFreezeDepth = 0;
  private drainAcceptedAfterStop = false;
  private paused = false;
  private currentItem?: QueueItem;

  constructor(options: TurnQueueOptions) {
    this.processItem = options.process;
    this.steerItem = options.steer;
    this.canSteer = options.canSteer;
    this.onItemStart = options.onItemStart;
    this.onItemEnd = options.onItemEnd;
  }

  assertAccepting(): void {
    if (this.stopped) throw new Error("turn queue is stopped");
    if (this.admissionFreezeDepth > 0) throw new Error("turn queue admission is frozen");
  }

  enqueue(item: QueueItem): void {
    this.assertAccepting();
    this.items.push(item);
    if (this.processing && !this.paused) {
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

  isStopped(): boolean {
    return this.stopped;
  }

  getCurrentItem(): QueueItem | undefined {
    return this.currentItem;
  }

  enableSteering(): void {
    if (!this.processing || !this.canProcessAcceptedItems()) return;
    this.steeringEnabled = true;
    this.steerPending();
  }

  steerPendingHooks(): void {
    if (!this.processing || !this.canProcessAcceptedItems() || !this.canSteer()) return;
    const hooks = this.items.filter((item) => item.source === "hook");
    if (hooks.length === 0) return;
    this.items.splice(0, this.items.length, ...this.items.filter((item) => item.source !== "hook"));
    const item = coalesceHookItems(hooks);
    void this.deliverSteeringItem(item);
  }

  getPendingItems(): QueueItem[] {
    return [...this.items];
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
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

    if (this.processing) {
      if (this.steeringEnabled) this.steerPending();
    } else {
      void this.pump();
    }

    await this.waitForIdle();
  }

  pause(): boolean {
    if (this.processing || this.stopped || this.paused) return false;
    this.paused = true;
    return true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.processing || !this.canProcessAcceptedItems() || this.paused) return;
    this.processing = true;
    try {
      while (this.canProcessAcceptedItems() && !this.paused && this.items.length > 0) {
        const item = this.drainNextAt(0);
        this.currentItem = item;
        this.steeringEnabled = false;
        this.onItemStart?.(item);
        try {
          let itemError: unknown;
          try {
            await this.processItem(item);
          } catch (error) {
            itemError = error;
          }

          while (this.hasActiveSteering()) {
            await Promise.allSettled([
              ...(this.steeringTask ? [this.steeringTask] : []),
              ...this.steeringChildren,
            ]);
          }

          this.onItemEnd?.(item, itemError);
        } finally {
          this.currentItem = undefined;
        }
      }
    } finally {
      this.processing = false;
      this.steeringEnabled = false;
      this.resolveIdleWaiters();
    }
  }

  private steerPending(): void {
    if (this.steeringTask || !this.canProcessAcceptedItems() || this.paused) return;
    const task = this.runSteering();
    this.steeringTask = task;
    void task.then(
      () => this.finishSteering(task),
      () => this.finishSteering(task),
    );
  }

  private async runSteering(): Promise<void> {
    await Promise.resolve();
    let index = this.items.findIndex((item) => item.source !== "hook");
    while (
      this.processing &&
      this.canProcessAcceptedItems() &&
      !this.paused &&
      this.canSteer() &&
      index !== -1
    ) {
      const item = this.drainNextAt(index);
      await this.deliverSteeringItem(item);
      index = this.items.findIndex((item) => item.source !== "hook");
    }
  }

  private finishSteering(task: Promise<void>): void {
    if (this.steeringTask !== task) return;
    this.steeringTask = undefined;
    if (
      this.processing &&
      this.canProcessAcceptedItems() &&
      !this.paused &&
      this.canSteer() &&
      this.items.some((item) => item.source !== "hook")
    ) {
      this.steerPending();
    }
    this.resolveIdleWaiters();
  }

  private deliverSteeringItem(item: QueueItem): Promise<void> {
    const delivery = this.runSteeringItem(item);
    this.steeringChildren.add(delivery);
    const remove = () => {
      this.steeringChildren.delete(delivery);
      this.resolveIdleWaiters();
    };
    void delivery.then(remove, remove);
    return delivery;
  }

  private async runSteeringItem(item: QueueItem): Promise<void> {
    try {
      await this.steerItem(item);
      this.onItemEnd?.(item, undefined, true);
    } catch (error) {
      this.onItemEnd?.(item, error, true);
    }
  }

  private canProcessAcceptedItems(): boolean {
    return !this.stopped || this.drainAcceptedAfterStop;
  }

  private hasActiveSteering(): boolean {
    return Boolean(this.steeringTask) || this.steeringChildren.size > 0;
  }

  private isIdle(): boolean {
    return this.items.length === 0 && !this.processing && !this.hasActiveSteering();
  }

  private resolveIdleWaiters(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
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
