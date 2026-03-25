export type StreamChunkerStats = {
  bufferDepth: number;
  profiling: boolean;
  profileStartTime: number;
  lastPushTime: number;
  lastRenderTime: number;
};

export type ProfileResult = {
  wsSpan: number;
  renderSpan: number;
  totalLag: number;
};

export type StreamChunkerOptions = {
  onChunk: (fullText: string) => void;
  chunkSize?: number;
  intervalMs?: number;
};

export class StreamChunker {
  private buffer = "";
  private fullText = "";
  private onChunk: (fullText: string) => void;
  private chunkSize: number;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  // Profiling state
  private profiling = false;
  private profileStartTime = 0;
  private lastPushTime = 0;
  private lastRenderTime = 0;

  constructor({ onChunk, chunkSize = 4, intervalMs = 32 }: StreamChunkerOptions) {
    this.onChunk = onChunk;
    this.chunkSize = chunkSize;
    this.intervalMs = intervalMs;
    this.startLoop();
  }

  push(delta: string): void {
    this.buffer += delta;
    const now = performance.now();
    if (this.profiling) {
      if (this.profileStartTime === 0) {
        this.profileStartTime = now;
        console.log("[StreamTuner] push @ T+0ms (profile start)");
      } else {
        console.log("[StreamTuner] push @ T+%sms", (now - this.profileStartTime).toFixed(1));
      }
      this.lastPushTime = now;
    }
  }

  setChunkSize(n: number): void {
    this.chunkSize = n;
  }

  setIntervalMs(ms: number): void {
    this.intervalMs = ms;
    this.stopLoop();
    this.startLoop();
  }

  getStats(): StreamChunkerStats {
    return {
      bufferDepth: this.buffer.length,
      profiling: this.profiling,
      profileStartTime: this.profileStartTime,
      lastPushTime: this.lastPushTime,
      lastRenderTime: this.lastRenderTime,
    };
  }

  startProfiling(): void {
    this.profiling = true;
    this.profileStartTime = 0; // locked on first push
    this.lastPushTime = 0;
    this.lastRenderTime = 0;
  }

  stopProfiling(): ProfileResult {
    this.profiling = false;
    const wsSpan = this.profileStartTime > 0
      ? this.lastPushTime - this.profileStartTime
      : 0;
    const renderSpan = this.profileStartTime > 0
      ? this.lastRenderTime - this.profileStartTime
      : 0;
    const totalLag = this.lastRenderTime - this.lastPushTime;
    const result = { wsSpan, renderSpan, totalLag };
    console.log("[StreamTuner] Profile result:", {
      wsSpan: wsSpan.toFixed(1) + "ms",
      renderSpan: renderSpan.toFixed(1) + "ms",
      totalLag: totalLag.toFixed(1) + "ms",
    });
    return result;
  }

  destroy(): void {
    this.stopLoop();
  }

  private startLoop(): void {
    this.timer = setInterval(() => this.drain(), this.intervalMs);
  }

  private stopLoop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private drain(): void {
    if (this.buffer.length === 0) return;

    // Adaptive: larger chunks when buffer is deep
    const adaptive = this.buffer.length > this.chunkSize * 3
      ? Math.min(this.buffer.length, this.chunkSize * 2)
      : this.chunkSize;

    const slice = this.buffer.slice(0, adaptive);
    this.buffer = this.buffer.slice(adaptive);
    this.fullText += slice;
    this.onChunk(this.fullText);

    if (this.profiling) {
      this.lastRenderTime = performance.now();
    }
  }
}
