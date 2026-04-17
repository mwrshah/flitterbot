import { createServerFn } from "@tanstack/react-start";
import type { ChatTimelineItem, DownstreamSessionItem } from "~/lib/types";

const BASE_URL = process.env.VITE_FLITTERBOT_BASE_URL || "http://127.0.0.1:18820";
const TOKEN = process.env.VITE_FLITTERBOT_TOKEN || "";

async function streamsRequest(path: string): Promise<unknown> {
  const url = `${BASE_URL.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export const fetchStreamsHistory = createServerFn({ method: "GET" })
  .inputValidator((input: { piSessionId?: string; surface?: "input" | "agent" }) => input)
  .handler(async ({ data }): Promise<ChatTimelineItem[]> => {
    const params = new URLSearchParams();
    if (data.piSessionId) params.set("piSessionId", data.piSessionId);
    if (data.surface) params.set("surface", data.surface);
    const qs = params.toString();
    const path = qs ? `/api/streams/history?${qs}` : "/api/streams/history";
    try {
      const res = (await streamsRequest(path)) as { items: ChatTimelineItem[] };
      return res.items;
    } catch (err) {
      console.error(
        "fetchStreamsHistory failed (piSessionId=%s, surface=%s):",
        data.piSessionId ?? "none",
        data.surface ?? "none",
        err,
      );
      throw err;
    }
  });

export const fetchDownstreamSessions = createServerFn({ method: "GET" })
  .inputValidator((input: { piSessionId: string }) => input)
  .handler(async ({ data }): Promise<DownstreamSessionItem[]> => {
    const path = `/api/pi-sessions/${encodeURIComponent(data.piSessionId)}/sessions`;
    try {
      const res = (await streamsRequest(path)) as { items: DownstreamSessionItem[] };
      return res.items;
    } catch (err) {
      console.error("fetchDownstreamSessions failed (piSessionId=%s):", data.piSessionId, err);
      throw err;
    }
  });

export type StreamInfo = {
  streamId: string;
  name: string;
  repoPath: string | null;
  worktreePath: string | null;
  baseBranch: string;
  piSessionCwd: string | null;
};

export const fetchStreamsWorktree = createServerFn({ method: "GET" })
  .inputValidator((input: { piSessionId: string }) => input)
  .handler(async ({ data }): Promise<StreamInfo | null> => {
    const path = `/api/pi-sessions/${encodeURIComponent(data.piSessionId)}/stream`;
    try {
      return (await streamsRequest(path)) as StreamInfo;
    } catch {
      return null;
    }
  });

export type DiffResult =
  | { mode: "diff"; diff: string }
  | { mode: "summary"; stat: string; files: number; insertions: number; deletions: number };

export const fetchStreamsDiff = createServerFn({ method: "GET" })
  .inputValidator((input: { piSessionId: string }) => input)
  .handler(async ({ data }): Promise<DiffResult | null> => {
    const url = `${BASE_URL.replace(/\/$/, "")}/api/pi-sessions/${encodeURIComponent(data.piSessionId)}/diff`;
    const headers: Record<string, string> = {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return (await res.json()) as DiffResult;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  });

export const fetchStreamsInputHistory = createServerFn({ method: "GET" }).handler(
  async (): Promise<ChatTimelineItem[]> => {
    try {
      const res = (await streamsRequest("/api/streams/history?surface=input")) as {
        items: ChatTimelineItem[];
      };
      return res.items;
    } catch (err) {
      console.error("fetchStreamsInputHistory failed:", err);
      throw err;
    }
  },
);
