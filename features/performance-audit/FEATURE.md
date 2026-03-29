# Feature: Performance Audit — Frontend & Algorithm

A structured audit of the entire Autonoma codebase — frontend-first — targeting maximum performance at the primitive level. Goal: lowest latency, lowest CPU/memory footprint, smoothest rendering, with no dependency on post-hoc mitigation strategies (virtualization, lazy rendering, deferred mounting). Fix the fundamentals so those strategies are never needed.

## Philosophy

Post-optimization strategies (virtual scroll, lazy mount, code splitting) paper over root causes. A component that renders in 2ms needs no virtualization even at 10,000 items. This audit works bottom-up:

1. Measure precisely
2. Fix algorithmic and structural problems at the source
3. Verify with the same tools

Virtualization, deferred rendering, and incremental loading are valid last resorts — not first moves.

---

## Measurement Tooling

### Precision: Algorithm Benchmarking

For comparing two implementations of the same function with a hard number.

**`vitest bench` / `tinybench`**
Built into Vitest. Runs a function thousands of times, reports ops/sec with statistical variance. Use for any pure function — packing algorithms, data transforms, store updates, message parsing.

```ts
bench('layout v1', () => packCards(cards, 1200));
bench('layout v2', () => packCardsV2(cards, 1200));
// → "layout v2: 48,320 ops/sec ±0.8% (faster by 3.2x)"
```

**`benchmark.js`**
Older, more verbose, still widely used for micro-benchmarks where confidence intervals matter. Useful when running benchmarks outside Vitest.

---

### Precision: Timing in Real App Context

**User Timing API (`performance.mark` / `performance.measure`)**
Zero-dependency, built into all browsers. Labels appear in the Chrome Performance flame chart as named bands. Use to measure specific algorithms *inside* the actual application — not isolated.

```ts
performance.mark('ws-parse-start');
parseWsPayload(raw);
performance.mark('ws-parse-end');
performance.measure('ws-parse', 'ws-parse-start', 'ws-parse-end');
```

**`performance.now()`**
High-resolution (sub-millisecond) wall clock. Use for lightweight inline timing without DevTools.

**Long Tasks API (`PerformanceObserver`)**
Reports any main-thread task exceeding 50ms. Catches blocking work that causes jank without requiring manual instrumentation:

```ts
new PerformanceObserver(list => {
  list.getEntries().forEach(e => console.warn('Long task:', e.duration, 'ms'));
}).observe({ entryTypes: ['longtask'] });
```

---

### Memory: Heap Profiling

**Chrome DevTools → Memory Panel**
- *Heap Snapshot*: full object graph at a point in time. Take snapshot before and after an operation; the delta shows exact allocations by type and byte size.
- *Allocation Timeline*: records all allocations live while code runs. Shows which functions allocate most.
- *Allocation Sampling*: lower overhead than Timeline; good for production-like profiling sessions.

**`performance.measureUserAgentSpecificMemory()`**
Programmatic heap size measurement. Requires `Cross-Origin-Isolation` headers (`COEP: require-corp`, `COOP: same-origin`). Returns a breakdown by realm. Use for before/after comparisons in automated tests.

```ts
const before = await performance.measureUserAgentSpecificMemory();
runAlgorithm();
const after = await performance.measureUserAgentSpecificMemory();
console.log('Delta:', after.bytes - before.bytes, 'bytes');
```

**`window.performance.memory.usedJSHeapSize`** (Chrome-only, not spec'd)
Useful for quick console comparisons. Not suitable for production assertions.

---

### CPU: Flame Charts & Profiling

**Chrome DevTools → Performance Panel**
Record → interact → stop. Produces a flame chart showing exact function call times per millisecond. Identifies which functions consume disproportionate CPU share. Shows:
- JS execution time
- Style recalculation and layout (purple)
- Painting (green)
- Compositing

Look for: unexpectedly deep call stacks, repeated recalculations, functions appearing too frequently.

**Chrome → `about:tracing`**
Lower-level than DevTools. Records Chromium internals including GPU, browser process, renderer process. Use when DevTools performance panel doesn't have enough resolution — e.g. to distinguish JS thread vs compositor thread vs GPU.

**V8 CPU Profiler (Node / `--prof`)**
For server-side code in `src/`. Run with `node --prof`; process output with `node --prof-process`. Produces tick-level CPU attribution.

**`clinic.js` + `0x`**
Flame graph profilers for Node.js workloads. `0x` produces an interactive SVG flamegraph. Use for profiling the control service under load.

---

### Coarse: Device-Level & Thermal

**Chrome Task Manager** (`Shift+Esc`)
Shows CPU % and memory per tab and per extension in real time. Coarse but immediate — useful for quickly identifying which tab is a CPU hog without opening DevTools.

**OS-Level Profilers**
- Linux: `perf record` + `perf report` for system-wide CPU sampling including browser processes
- macOS: Instruments → Time Profiler — deep call stack sampling across all threads including GPU drivers

**Thermal Throttling Detection**
When a device overheats, the CPU throttles — benchmarks run slower, jank appears. Detect thermal state indirectly:
- Run the same benchmark repeatedly; if ops/sec degrades over 3–5 runs, throttling is occurring
- `navigator.hardwareConcurrency` — number of logical CPU cores available; affects how much parallelism is practical
- Battery Status API (`navigator.getBattery()`) — low battery = CPU throttled by OS on many devices; performance under battery saver mode should be tested explicitly

**Frame Rate / `requestAnimationFrame` Timing**
Measure actual frame delivery time:

```ts
let last = performance.now();
const check = (now: DOMHighResTimeStamp) => {
  const delta = now - last;
  if (delta > 20) console.warn('Dropped frame:', delta.toFixed(1), 'ms');
  last = now;
  requestAnimationFrame(check);
};
requestAnimationFrame(check);
```

Target: 60fps = 16.67ms/frame. Any frame > 20ms is visible jank.

**Chrome DevTools → Rendering Tab**
Enable: DevTools → three-dot menu → More tools → Rendering:
- *Paint flashing* — green overlay on every repaint; should be minimal
- *Layout shift regions* — blue on any CLS event
- *Frame rendering stats* — live FPS counter + dropped frames overlay
- *Layer borders* — shows compositor layers (helps verify that animated elements are on their own layer)

---

### React-Specific: Render Counting & Why

**React DevTools Profiler**
Records which components rendered per commit, how long each took in ms, and the exact prop/state that triggered the render. Flame chart + ranked chart views. Primary tool for finding unnecessary React work.

**`why-did-you-render`** (`@welldone-software/why-did-you-render`)
Monkey-patches React in dev mode. Logs to console on every avoidable re-render (same props/state). Opt in per component:

```ts
MyComponent.whyDidYouRender = true;
```

**Manual Render Counter**
Exact render count with no tooling dependency:

```ts
const renderCount = useRef(0);
renderCount.current++;
// log or display renderCount.current
```

**`useCallback` / `useMemo` Effectiveness Check**
Use React DevTools Profiler to verify that memoization is actually preventing renders — not just assumed to. A `memo()`-wrapped component that still re-renders means a dependency is changing unexpectedly.

---

### Automated Scoring

**Lighthouse** (Chrome DevTools → Lighthouse tab)
Produces TBT (Total Blocking Time), TTI (Time to Interactive), CLS, LCP. Not for micro-optimization but useful as a before/after score after each audit phase.

**WebPageTest** (webpagetest.org)
Tests from real browsers on real hardware. Filmstrip view shows exactly when content appears. Network waterfall. Good for validating that local optimizations hold on lower-spec devices and slower networks.

**Core Web Vitals in field**
- LCP: largest contentful paint — when does the main content appear?
- INP: Interaction to Next Paint (replaced FID) — how fast does the UI respond to input?
- CLS: cumulative layout shift — does content jump around?

---

## Audit Scope: Autonoma Frontend

### Priority Areas

**1. WebSocket event processing (`web/src/lib/ws.ts`, `ws-route-subscriptions.ts`)**
Every streaming message flows through here. Parsing, routing, and store updates happen synchronously on the main thread. Measure: User Timing marks around the full WS→store→render pipeline per message. Target: < 1ms per event from receive to state commit.

**2. PiSessionStore appends (`web/src/lib/streaming-store.ts`)**
`appendedItems` grows unbounded per session. Benchmark array vs linked-list vs circular buffer for append-heavy workloads. Check whether store subscriptions trigger unnecessary React tree sweeps.

**3. WebSocket→TanStack Query bridge (`web/src/lib/ws-query-bridge.ts`)**
Every WS event that calls `queryClient.invalidateQueries()` triggers a background refetch. Profile how many network requests fire per user interaction. Measure: Chrome Network panel with timestamps.

**4. Chat panel rendering (`web/src/components/chat-panel.tsx`)**
Streaming text appends cause per-delta re-renders. Measure render count with React DevTools Profiler during a live stream. Check whether `PiMessageList` and `pi-web-ui-bridge.ts` do unnecessary object allocations per delta.

**5. Sidebar layout (`web/src/components/sidebar.tsx`)**
Known overflow issue at 27+ entries. Profile style recalculation cost with Chrome Performance panel. Measure repaint area with Paint Flashing. Verify the fix doesn't introduce layout thrashing.

**6. Root layout subscriptions (`web/src/routes/__root.tsx`)**
Root subscribes to `workstreams_changed` and `status_changed`. Every event here re-renders the entire tree unless properly memoized. Check with React DevTools: how many components re-render on each WS event at root level?

**7. Skill picker / command popover (`web/src/components/skill-picker.tsx`)**
Filtering on keypress. Benchmark filter algorithm. Check if filtering happens synchronously on input event (blocks frame) or deferred.

**8. Session list (`web/src/components/session-list.tsx`, `sessions.index.tsx`)**
10s polling via TanStack Query. Measure: does each poll trigger a visible re-render cascade? Check query key stability and whether list diffing is correct.

**9. Queries layer (`web/src/lib/queries.ts`)**
Centralised query definitions. Check `staleTime` and `gcTime` configuration. Overly aggressive refetching wastes network and CPU.

**10. Control surface (`src/` — Node.js)**
SQLite queries under load. WebSocket broadcast to N clients. Profile with `0x` or `clinic.js` under simulated load (multiple sessions, high message volume).

---

## Primitive-First Fix Order

Fix in this order — each layer compounds on the one below:

1. *Data structures* — are arrays being used where sets/maps are correct? Are objects recreated when they could be mutated (or vice versa)?
2. *Algorithmic complexity* — O(n²) loops in hot paths, redundant traversals, repeated calculations that could be cached
3. *Synchronous blocking* — anything > 5ms on the main thread during interaction; move to microtask, worker, or idle callback
4. *React structural issues* — component tree shape, context boundary placement, subscription granularity
5. *CSS layout & paint cost* — layout thrashing (read then write DOM in a loop), unintentionally large repaint regions, non-composited animations
6. *Network* — query frequency, payload size, unnecessary invalidations
7. *Post-hoc strategies* — virtual scroll, lazy mount, incremental rendering — only if 1–6 don't resolve the bottleneck

---

## Key Files

| File | Audit Focus |
|---|---|
| `web/src/lib/ws.ts` | Event parsing cost, message routing overhead |
| `web/src/lib/streaming-store.ts` | Append performance, subscription fan-out |
| `web/src/lib/ws-query-bridge.ts` | Invalidation frequency, unnecessary refetches |
| `web/src/lib/queries.ts` | staleTime, gcTime, query key stability |
| `web/src/lib/pi-web-ui-bridge.ts` | Object allocation per streaming delta |
| `web/src/routes/__root.tsx` | Root subscription re-render cascade |
| `web/src/routes/pi.default.tsx` | Per-message render count during streaming |
| `web/src/components/chat-panel.tsx` | Streaming render cost |
| `web/src/components/sidebar.tsx` | Layout cost at scale, overflow fix |
| `web/src/components/session-list.tsx` | Poll-driven re-render cost |
| `web/src/components/skill-picker.tsx` | Keypress filter synchronicity |
| `src/routes/` | HTTP handler latency |
| `src/blackboard/` | SQLite query cost under load |

---

## Deliverables Per Audit Cycle

1. *Baseline measurements* — benchmark and profiler outputs for current state, stored as reference
2. *Hotspot report* — ranked list of highest-cost operations by category (CPU, memory, renders, network)
3. *Fix PRs* — one PR per hotspot, each with before/after benchmark numbers in the PR description
4. *Regression baseline* — updated reference measurements after each fix; future regressions are detectable

