export type StreamChunkerStats = {
  bufferDepth: number;
  lastDeltaTime: number;
  lastRenderTime: number;
  lagMs: number;
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
  private lastDeltaTime = 0;
  private lastRenderTime = 0;

  constructor({ onChunk, chunkSize = 4, intervalMs = 32 }: StreamChunkerOptions) {
    this.onChunk = onChunk;
    this.chunkSize = chunkSize;
    this.intervalMs = intervalMs;
    this.startLoop();
  }

  push(delta: string): void {
    this.buffer += delta;
    this.lastDeltaTime = performance.now();
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.fullText += this.buffer;
      this.buffer = "";
      this.onChunk(this.fullText);
      this.lastRenderTime = performance.now();
    }
  }

  setChunkSize(n: number): void {
    this.chunkSize = n;
  }

  setInterval(ms: number): void {
    this.intervalMs = ms;
    // Restart loop with new interval
    this.stopLoop();
    this.startLoop();
  }

  getStats(): StreamChunkerStats {
    return {
      bufferDepth: this.buffer.length,
      lastDeltaTime: this.lastDeltaTime,
      lastRenderTime: this.lastRenderTime,
      lagMs: this.lastDeltaTime > 0 && this.lastRenderTime > 0
        ? Math.max(0, this.lastDeltaTime - this.lastRenderTime)
        : 0,
    };
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
    this.lastRenderTime = performance.now();
  }
}
