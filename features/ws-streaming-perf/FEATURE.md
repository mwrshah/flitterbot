# WS Streaming Performance

Optimize WebSocket streaming performance by eliminating full React re-render cycles on every text delta during LLM response streaming. The goal is zero React re-renders during active streaming, sub-millisecond delta-to-pixel latency, and a single reconciliation when the stream completes.
