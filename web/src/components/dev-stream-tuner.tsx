/**
 * Dev-only sidebar widget for tuning StreamChunker parameters in real time.
 * Renders an inline icon button; when toggled, shows a popover panel anchored
 * to the button. Keyboard shortcut: Ctrl+Shift+S.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamChunker, StreamChunkerStats } from "~/lib/stream-chunker";

function getChunker(): StreamChunker | null {
  return (window as unknown as Record<string, unknown>).__streamChunker as StreamChunker | null;
}

export function DevStreamTuner() {
  const [visible, setVisible] = useState(false);
  const [chunkSize, setChunkSize] = useState(4);
  const [intervalMs, setIntervalMs] = useState(32);
  const [stats, setStats] = useState<StreamChunkerStats>({
    bufferDepth: 0,
    lastDeltaTime: 0,
    lastRenderTime: 0,
    lagMs: 0,
  });
  const rafRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Poll stats via rAF when visible, log summary every ~1s
  useEffect(() => {
    if (!visible) return;
    let lastLogTime = 0;
    const tick = () => {
      const c = getChunker();
      if (c) {
        const s = c.getStats();
        setStats(s);
        const now = performance.now();
        if (now - lastLogTime >= 1000 && (s.bufferDepth > 0 || s.lagMs > 0)) {
          console.log("[StreamTuner] stats:", {
            bufferDepth: s.bufferDepth,
            lagMs: s.lagMs,
            lastDeltaTime: s.lastDeltaTime,
            lastRenderTime: s.lastRenderTime,
          });
          lastLogTime = now;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [visible]);

  // Keyboard shortcut: Ctrl+Shift+S toggles
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "S") {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleChunkSize = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setChunkSize(v);
    const c = getChunker();
    if (c) {
      c.setChunkSize(v);
      console.log("[StreamTuner] chunkSize changed:", v);
    }
  }, []);

  const handleInterval = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setIntervalMs(v);
    const c = getChunker();
    if (c) {
      c.setInterval(v);
      console.log("[StreamTuner] interval changed:", v, "ms");
    }
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        title="Stream Tuner (Ctrl+Shift+S)"
        className="w-6 h-6 rounded-md flex items-center justify-center text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
          <path d="M1 3h4v2H1V3Zm6 0h8v2H7V3ZM1 7h8v2H1V7Zm10 0h4v2h-4V7ZM1 11h3v2H1v-2Zm5 0h9v2H6v-2Z" />
        </svg>
      </button>

      {visible && (
        <div className="absolute left-full top-0 ml-2 z-50 bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg p-3 text-xs w-64 shadow-xl">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold">Stream Tuner</span>
            <button type="button" onClick={() => setVisible(false)} className="text-zinc-500 hover:text-zinc-300">
              x
            </button>
          </div>

          <label className="block mb-1">
            Chunk size: {chunkSize}
            <input
              type="range"
              min={1}
              max={20}
              value={chunkSize}
              onChange={handleChunkSize}
              className="w-full"
            />
          </label>

          <label className="block mb-2">
            Interval: {intervalMs}ms
            <input
              type="range"
              min={10}
              max={100}
              value={intervalMs}
              onChange={handleInterval}
              className="w-full"
            />
          </label>

          <div className="space-y-0.5 text-zinc-400 font-mono">
            <div>Buffer: {stats.bufferDepth} chars</div>
            <div>Lag: {stats.lagMs.toFixed(1)}ms</div>
          </div>
        </div>
      )}
    </div>
  );
}
