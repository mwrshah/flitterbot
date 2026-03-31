import { createServerFn } from "@tanstack/react-start";
import type { ChatTimelineItem, DownstreamSessionItem } from "~/lib/types";

const BASE_URL = process.env.VITE_AUTONOMA_BASE_URL || "http://127.0.0.1:18820";
const TOKEN = process.env.VITE_AUTONOMA_TOKEN || "";

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
  .inputValidator((input: { streamsSessionId?: string; surface?: "input" | "agent" }) => input)
  .handler(async ({ data }): Promise<ChatTimelineItem[]> => {
    const params = new URLSearchParams();
    if (data.streamsSessionId) params.set("streamsSessionId", data.streamsSessionId);
    if (data.surface) params.set("surface", data.surface);
    const qs = params.toString();
    const path = qs ? `/api/streams/history?${qs}` : "/api/streams/history";
    try {
      const res = (await streamsRequest(path)) as { items: ChatTimelineItem[] };
      return res.items;
    } catch (err) {
      console.error(
        "fetchStreamsHistory failed (streamsSessionId=%s, surface=%s):",
        data.streamsSessionId ?? "none",
        data.surface ?? "none",
        err,
      );
      throw err;
    }
  });

export const fetchStreamsSessions = createServerFn({ method: "GET" })
  .inputValidator((input: { streamsSessionId: string }) => input)
  .handler(async ({ data }): Promise<DownstreamSessionItem[]> => {
    const path = `/api/stream-sessions/${encodeURIComponent(data.streamsSessionId)}/sessions`;
    try {
      const res = (await streamsRequest(path)) as { items: DownstreamSessionItem[] };
      return res.items;
    } catch (err) {
      console.error("fetchStreamsSessions failed (streamsSessionId=%s):", data.streamsSessionId, err);
      throw err;
    }
  });

export type StreamInfo = {
  streamId: string;
  name: string;
  repoPath: string | null;
  worktreePath: string | null;
};

export const fetchStreamsWorktree = createServerFn({ method: "GET" })
  .inputValidator((input: { streamsSessionId: string }) => input)
  .handler(async ({ data }): Promise<StreamInfo | null> => {
    const path = `/api/stream-sessions/${encodeURIComponent(data.streamsSessionId)}/stream`;
    try {
      return (await streamsRequest(path)) as StreamInfo;
    } catch {
      return null;
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
