/**
 * Dev-only floating overlay for tuning StreamChunker parameters in real time.
 * Reads the chunker instance from window.__streamChunker (set by chat-panel).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { StreamChunker, StreamChunkerStats } from "~/lib/stream-chunker";

function getChunker(): StreamChunker | null {
  return (window as unknown as Record<string, unknown>).__streamChunker as StreamChunker | null;
}

export function DevStreamTuner() {
  useWhyDidYouRender("DevStreamTuner", {});
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

  // Poll stats via rAF when visible
  useEffect(() => {
    if (!visible) return;
    const tick = () => {
      const c = getChunker();
      if (c) setStats(c.getStats());
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
    getChunker()?.setChunkSize(v);
  }, []);

  const handleInterval = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setIntervalMs(v);
    getChunker()?.setInterval(v);
  }, []);

  if (!visible) {
    return (
      <button
        type="button"
        onClick={() => setVisible(true)}
        className="fixed bottom-3 right-3 z-50 bg-zinc-800 text-zinc-300 text-xs px-2 py-1 rounded opacity-40 hover:opacity-100"
      >
        Stream Tuner
      </button>
    );
  }

  return (
    <div className="fixed bottom-3 right-3 z-50 bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg p-3 text-xs w-64 shadow-xl">
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
  );
}
