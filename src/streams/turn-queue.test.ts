import { describe, expect, test } from "bun:test";
import {
  coalesceUserItems,
  isCoalescableUserInput,
  type QueueItem,
  TurnQueue,
} from "./turn-queue.ts";

function mk(
  partial: Partial<QueueItem> & { id: string; text: string; source: QueueItem["source"] },
): QueueItem {
  return {
    receivedAt: "2026-04-19T00:00:00.000Z",
    ...partial,
  };
}

/**
 * Drive the queue with a "primer + burst" pattern that mirrors production
 * backpressure.
 *
 * Why: `enqueue()` starts pump() synchronously, so the very first item in an
 * empty queue is always drained alone before any follow-ups can pile up.
 * Coalescing only kicks in for items that arrive while a prior delivery is
 * in-flight — which in production is the common case (pi is busy on a turn
 * and user fires off a burst).
 *
 * The helper enqueues `primer` first and holds it inside process() on a gate.
 * While the primer is parked, `burst` is enqueued synchronously — so all of
 * those items are in the queue before pump() advances. Releasing the gate
 * lets pump() drain the burst, where coalescing actually happens.
 *
 * Returns deliveries in order: [primer, ...post-coalesce burst deliveries].
 */
async function drainWithPrimer(primer: QueueItem, burst: QueueItem[]): Promise<QueueItem[]> {
  const delivered: QueueItem[] = [];
  let releasePrimer: (() => void) | undefined;
  const primerGate = new Promise<void>((resolve) => {
    releasePrimer = resolve;
  });
  let primerSeen = false;
  const queue = new TurnQueue({
    process: async (item) => {
      delivered.push(item);
      if (!primerSeen) {
        primerSeen = true;
        await primerGate;
      }
    },
  });
  queue.enqueue(primer);
  // Yield once so pump() advances into processItem(primer) and parks on the gate.
  await Promise.resolve();
  // Now seed the burst — pump is gated, so these all pile up in the queue.
  for (const it of burst) queue.enqueue(it);
  releasePrimer?.();
  // Flush remaining microtasks so pump() drains the burst.
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
    if (!queue.isBusy() && queue.getDepth() === 0) break;
  }
  return delivered;
}

/**
 * Convenience wrapper: drain without primer, accepting the reality that the
 * head of the queue is dispatched solo. Useful for single-item sanity checks.
 */
async function drainSolo(items: QueueItem[]): Promise<QueueItem[]> {
  const delivered: QueueItem[] = [];
  const queue = new TurnQueue({
    process: async (item) => {
      delivered.push(item);
    },
  });
  for (const it of items) queue.enqueue(it);
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
    if (!queue.isBusy() && queue.getDepth() === 0) break;
  }
  return delivered;
}

// --- Predicate unit tests ---

describe("isCoalescableUserInput", () => {
  test("accepts web+user+no-images+no-steer", () => {
    expect(isCoalescableUserInput(mk({ id: "a", text: "hi", source: "web", sender: "user" }))).toBe(
      true,
    );
  });

  test("accepts whatsapp+user", () => {
    expect(
      isCoalescableUserInput(mk({ id: "a", text: "hi", source: "whatsapp", sender: "user" })),
    ).toBe(true);
  });

  test("rejects sender=system", () => {
    expect(
      isCoalescableUserInput(mk({ id: "a", text: "hi", source: "web", sender: "system" })),
    ).toBe(false);
  });

  test("rejects missing sender (legacy)", () => {
    expect(isCoalescableUserInput(mk({ id: "a", text: "hi", source: "web" }))).toBe(false);
  });

  test("rejects source=hook/agent/cron", () => {
    for (const source of ["hook", "agent", "cron"] as const) {
      expect(isCoalescableUserInput(mk({ id: "a", text: "hi", source, sender: "user" }))).toBe(
        false,
      );
    }
  });

  test("rejects items with images", () => {
    expect(
      isCoalescableUserInput(
        mk({
          id: "a",
          text: "hi",
          source: "web",
          sender: "user",
          images: [{ type: "image", data: "x", mimeType: "image/png" }],
        }),
      ),
    ).toBe(false);
  });

  test("rejects steer delivery mode", () => {
    expect(
      isCoalescableUserInput(
        mk({ id: "a", text: "hi", source: "web", sender: "user", deliveryMode: "steer" }),
      ),
    ).toBe(false);
  });
});

// --- Coalesce builder unit tests ---

describe("coalesceUserItems", () => {
  test("joins text with \\n and preserves order", () => {
    const merged = coalesceUserItems([
      mk({ id: "a", text: "first", source: "web", sender: "user", serverMessageId: "sm-a" }),
      mk({ id: "b", text: "second", source: "web", sender: "user", serverMessageId: "sm-b" }),
      mk({ id: "c", text: "third", source: "web", sender: "user", serverMessageId: "sm-c" }),
    ]);
    expect(merged.text).toBe("first\nsecond\nthird");
  });

  test("serverMessageId comes from the last item", () => {
    const merged = coalesceUserItems([
      mk({ id: "a", text: "1", source: "web", sender: "user", serverMessageId: "sm-a" }),
      mk({ id: "b", text: "2", source: "web", sender: "user", serverMessageId: "sm-b" }),
    ]);
    expect(merged.serverMessageId).toBe("sm-b");
    expect(merged.metadata?.serverMessageId).toBe("sm-b");
  });

  test("clientMessageId comes from the last item (matches most recent optimistic bubble)", () => {
    const merged = coalesceUserItems([
      mk({ id: "a", text: "1", source: "web", sender: "user", clientMessageId: "cm-a" }),
      mk({ id: "b", text: "2", source: "web", sender: "user", clientMessageId: "cm-b" }),
    ]);
    expect(merged.clientMessageId).toBe("cm-b");
  });

  test("metadata is last-wins merged with coalescedFrom audit array", () => {
    const merged = coalesceUserItems([
      mk({
        id: "a",
        text: "1",
        source: "web",
        sender: "user",
        metadata: { stream_id: "ws-1", foo: "A" },
      }),
      mk({
        id: "b",
        text: "2",
        source: "web",
        sender: "user",
        metadata: { stream_id: "ws-1", foo: "B", bar: "B" },
      }),
    ]);
    expect(merged.metadata?.stream_id).toBe("ws-1");
    expect(merged.metadata?.foo).toBe("B"); // last wins
    expect(merged.metadata?.bar).toBe("B");
    expect(merged.metadata?.coalescedFrom).toEqual(["a", "b"]);
  });

  test("id gets coalesced: prefix; receivedAt from first", () => {
    const merged = coalesceUserItems([
      mk({
        id: "first-id",
        text: "1",
        source: "web",
        sender: "user",
        receivedAt: "2026-04-19T00:00:00.000Z",
      }),
      mk({
        id: "second-id",
        text: "2",
        source: "web",
        sender: "user",
        receivedAt: "2026-04-19T00:00:05.000Z",
      }),
    ]);
    expect(merged.id).toBe("coalesced:first-id+1");
    expect(merged.receivedAt).toBe("2026-04-19T00:00:00.000Z");
  });

  test("always clears images (coalescing is gated on no-images anyway)", () => {
    const merged = coalesceUserItems([
      mk({ id: "a", text: "1", source: "web", sender: "user" }),
      mk({ id: "b", text: "2", source: "web", sender: "user" }),
    ]);
    expect(merged.images).toBeUndefined();
  });
});

// --- Pump integration tests ---

describe("TurnQueue.pump coalescing", () => {
  test("single user message: unchanged payload, not wrapped", async () => {
    const delivered = await drainSolo([
      mk({ id: "u1", text: "hello", source: "web", sender: "user" }),
    ]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.id).toBe("u1");
    expect(delivered[0]!.text).toBe("hello");
  });

  test("three user messages queued while pi is busy → one coalesced delivery", async () => {
    const delivered = await drainWithPrimer(
      mk({ id: "prime", text: "prime", source: "hook", sender: "system" }),
      [
        mk({ id: "u1", text: "a", source: "web", sender: "user", serverMessageId: "sm-1" }),
        mk({ id: "u2", text: "b", source: "web", sender: "user", serverMessageId: "sm-2" }),
        mk({ id: "u3", text: "c", source: "web", sender: "user", serverMessageId: "sm-3" }),
      ],
    );
    // [primer, coalesced(u1+u2+u3)]
    expect(delivered).toHaveLength(2);
    expect(delivered[1]!.text).toBe("a\nb\nc");
    expect(delivered[1]!.id).toBe("coalesced:u1+2");
    expect(delivered[1]!.serverMessageId).toBe("sm-3");
    expect(delivered[1]!.metadata?.coalescedFrom).toEqual(["u1", "u2", "u3"]);
  });

  test("user / agent / user / user queued while busy → agent breaks the run, last pair merges", async () => {
    const delivered = await drainWithPrimer(
      mk({ id: "prime", text: "prime", source: "hook", sender: "system" }),
      [
        mk({ id: "u1", text: "one", source: "web", sender: "user" }),
        mk({ id: "a1", text: "agent-note", source: "agent", sender: "system" }),
        mk({ id: "u2", text: "two", source: "web", sender: "user" }),
        mk({ id: "u3", text: "three", source: "web", sender: "user" }),
      ],
    );
    // [primer, u1, a1, coalesced(u2+u3)]
    expect(delivered.map((d) => d.text)).toEqual(["prime", "one", "agent-note", "two\nthree"]);
    expect(delivered[3]!.id).toBe("coalesced:u2+1");
  });

  test("user with images is delivered alone; breaks the run either side", async () => {
    const delivered = await drainWithPrimer(
      mk({ id: "prime", text: "prime", source: "hook", sender: "system" }),
      [
        mk({ id: "u1", text: "before", source: "web", sender: "user" }),
        mk({
          id: "u2",
          text: "with-image",
          source: "web",
          sender: "user",
          images: [{ type: "image", data: "x", mimeType: "image/png" }],
        }),
        mk({ id: "u3", text: "after1", source: "web", sender: "user" }),
        mk({ id: "u4", text: "after2", source: "web", sender: "user" }),
      ],
    );
    expect(delivered.map((d) => d.text)).toEqual([
      "prime",
      "before",
      "with-image",
      "after1\nafter2",
    ]);
  });

  test("hook between users breaks the run", async () => {
    const delivered = await drainWithPrimer(
      mk({ id: "prime", text: "prime", source: "hook", sender: "system" }),
      [
        mk({ id: "u1", text: "one", source: "web", sender: "user" }),
        mk({ id: "h1", text: "hook-event", source: "hook", sender: "system" }),
        mk({ id: "u2", text: "two", source: "web", sender: "user" }),
      ],
    );
    expect(delivered.map((d) => d.text)).toEqual(["prime", "one", "hook-event", "two"]);
  });

  test("cron source never coalesces (sender=system)", async () => {
    const delivered = await drainWithPrimer(
      mk({ id: "prime", text: "prime", source: "hook", sender: "system" }),
      [
        mk({ id: "u1", text: "user-msg", source: "web", sender: "user" }),
        mk({ id: "c1", text: "idle-check", source: "cron", sender: "system" }),
      ],
    );
    expect(delivered.map((d) => d.text)).toEqual(["prime", "user-msg", "idle-check"]);
  });

  test("different streamId breaks the run (defensive)", async () => {
    const delivered = await drainWithPrimer(
      mk({ id: "prime", text: "prime", source: "hook", sender: "system" }),
      [
        mk({ id: "u1", text: "a", source: "web", sender: "user", streamId: "ws-1" }),
        mk({ id: "u2", text: "b", source: "web", sender: "user", streamId: "ws-2" }),
      ],
    );
    expect(delivered.map((d) => d.text)).toEqual(["prime", "a", "b"]);
  });

  test("user-web and user-whatsapp mix: coalesce (both are user-input channels)", async () => {
    const delivered = await drainWithPrimer(
      mk({ id: "prime", text: "prime", source: "hook", sender: "system" }),
      [
        mk({ id: "u1", text: "web-msg", source: "web", sender: "user" }),
        mk({ id: "u2", text: "wa-msg", source: "whatsapp", sender: "user" }),
      ],
    );
    expect(delivered).toHaveLength(2);
    expect(delivered[1]!.text).toBe("web-msg\nwa-msg");
  });

  test("ws-init bootstrap (source=web, sender=system) does NOT coalesce with user follow-up", async () => {
    const delivered = await drainWithPrimer(
      mk({ id: "prime", text: "prime", source: "hook", sender: "system" }),
      [
        mk({ id: "ws-init-1", text: "[bootstrap]", source: "web", sender: "system" }),
        mk({ id: "u1", text: "user-follow-up-1", source: "web", sender: "user" }),
        mk({ id: "u2", text: "user-follow-up-2", source: "web", sender: "user" }),
      ],
    );
    expect(delivered.map((d) => d.text)).toEqual([
      "prime",
      "[bootstrap]",
      "user-follow-up-1\nuser-follow-up-2",
    ]);
  });
});
