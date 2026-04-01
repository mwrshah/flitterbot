/**
 * Streaming pipeline performance instrumentation.
 *
 * Enable via browser console: window.__STREAMING_PERF = true
 * View report: streamingPerf.report()
 * Reset data: streamingPerf.reset()
 */

type SpanKind =
  | "deltaToCallback"
  | "streamingDomWrite"
  | "streamingLitRender"
  | "committedLitRender"
  | "scroll";

type CounterKind =
  | "deltasReceived"
  | "callbacksFired"
  | "streamingUpdateCalls"
  | "committedMessageSyncs"
  | "scrollCalls"
  | "messageListUpdates"
  | "streamingAssistantUpdates"
  | "committedAssistantUpdates";

type PendingSpan = {
  kind: SpanKind;
  start: number;
};

const spanSamples: Record<SpanKind, number[]> = {
  deltaToCallback: [],
  streamingDomWrite: [],
  streamingLitRender: [],
  committedLitRender: [],
  scroll: [],
};

const counters: Record<CounterKind, number> = {
  deltasReceived: 0,
  callbacksFired: 0,
  streamingUpdateCalls: 0,
  committedMessageSyncs: 0,
  scrollCalls: 0,
  messageListUpdates: 0,
  streamingAssistantUpdates: 0,
  committedAssistantUpdates: 0,
};

const pendingSpans = new Map<number, PendingSpan>();
let nextSpanToken = 1;

function enabled(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as Record<string, unknown>).__STREAMING_PERF === true
  );
}

function beginSpan(kind: SpanKind): number | null {
  if (!enabled()) return null;
  const token = nextSpanToken++;
  pendingSpans.set(token, { kind, start: performance.now() });
  return token;
}

function endSpan(token: number | null): void {
  if (!enabled() || token == null) return;
  const span = pendingSpans.get(token);
  if (!span) return;
  spanSamples[span.kind].push(performance.now() - span.start);
  pendingSpans.delete(token);
}

function incrementCounter(kind: CounterKind): void {
  if (!enabled()) return;
  counters[kind] += 1;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function formatMs(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

function reportSpan(label: string, samples: number[]): void {
  if (samples.length === 0) return;
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length;
  console.log(
    `${label}: count=${sorted.length} avg=${formatMs(avg)} p50=${formatMs(percentile(sorted, 50))} p95=${formatMs(percentile(sorted, 95))} p99=${formatMs(percentile(sorted, 99))}`,
  );
}

export const streamingPerf = {
  beginDeltaToCallback() {
    incrementCounter("deltasReceived");
    return beginSpan("deltaToCallback");
  },

  endDeltaToCallback(token: number | null) {
    incrementCounter("callbacksFired");
    endSpan(token);
  },

  beginStreamingDomWrite() {
    incrementCounter("streamingUpdateCalls");
    return beginSpan("streamingDomWrite");
  },

  endStreamingDomWrite(token: number | null) {
    endSpan(token);
  },

  beginStreamingLitRender() {
    return beginSpan("streamingLitRender");
  },

  endStreamingLitRender(token: number | null) {
    endSpan(token);
  },

  beginCommittedLitRender() {
    incrementCounter("committedMessageSyncs");
    return beginSpan("committedLitRender");
  },

  endCommittedLitRender(token: number | null) {
    endSpan(token);
  },

  beginScroll() {
    incrementCounter("scrollCalls");
    return beginSpan("scroll");
  },

  endScroll(token: number | null) {
    endSpan(token);
  },

  markMessageListUpdated() {
    incrementCounter("messageListUpdates");
  },

  markAssistantUpdated(isStreaming: boolean) {
    incrementCounter(isStreaming ? "streamingAssistantUpdates" : "committedAssistantUpdates");
  },

  report() {
    const totalSamples = Object.values(spanSamples).reduce(
      (sum, samples) => sum + samples.length,
      0,
    );
    const totalCounters = Object.values(counters).reduce((sum, count) => sum + count, 0);
    if (totalSamples === 0 && totalCounters === 0) {
      console.log(
        "[streaming-perf] No samples recorded. Enable with: window.__STREAMING_PERF = true",
      );
      return;
    }

    console.group("[streaming-perf] Report");
    console.log("Counters:", { ...counters, pendingSpans: pendingSpans.size });
    reportSpan("Delta -> callback", spanSamples.deltaToCallback);
    reportSpan("Streaming DOM write", spanSamples.streamingDomWrite);
    reportSpan("Streaming Lit render", spanSamples.streamingLitRender);
    reportSpan("Committed Lit render", spanSamples.committedLitRender);
    reportSpan("Scroll", spanSamples.scroll);
    console.groupEnd();
  },

  reset() {
    for (const samples of Object.values(spanSamples)) {
      samples.length = 0;
    }
    for (const key of Object.keys(counters) as CounterKind[]) {
      counters[key] = 0;
    }
    pendingSpans.clear();
    nextSpanToken = 1;
    console.log("[streaming-perf] Reset.");
  },
};

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).streamingPerf = streamingPerf;
}
