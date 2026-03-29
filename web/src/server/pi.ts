import { createServerFn } from "@tanstack/react-start";
import type { ChatTimelineItem, DownstreamSessionItem } from "~/lib/types";

const BASE_URL = process.env.VITE_AUTONOMA_BASE_URL || "http://127.0.0.1:18820";
const TOKEN = process.env.VITE_AUTONOMA_TOKEN || "";

async function piRequest(path: string): Promise<unknown> {
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

export const fetchPiHistory = createServerFn({ method: "GET" })
  .inputValidator((input: { piSessionId?: string; surface?: "input" | "agent" }) => input)
  .handler(async ({ data }): Promise<ChatTimelineItem[]> => {
    const params = new URLSearchParams();
    if (data.piSessionId) params.set("piSessionId", data.piSessionId);
    if (data.surface) params.set("surface", data.surface);
    const qs = params.toString();
    const path = qs ? `/api/pi/history?${qs}` : "/api/pi/history";
    try {
      const res = (await piRequest(path)) as { items: ChatTimelineItem[] };
      return res.items;
    } catch (err) {
      console.error(
        "fetchPiHistory failed (piSessionId=%s, surface=%s):",
        data.piSessionId ?? "none",
        data.surface ?? "none",
        err,
      );
      throw err;
    }
  });

export const fetchPiSessions = createServerFn({ method: "GET" })
  .inputValidator((input: { piSessionId: string }) => input)
  .handler(async ({ data }): Promise<DownstreamSessionItem[]> => {
    const path = `/api/pi-sessions/${encodeURIComponent(data.piSessionId)}/sessions`;
    try {
      const res = (await piRequest(path)) as { items: DownstreamSessionItem[] };
      return res.items;
    } catch (err) {
      console.error("fetchPiSessions failed (piSessionId=%s):", data.piSessionId, err);
      throw err;
    }
  });

export type PiWorkstreamInfo = {
  workstreamId: string;
  name: string;
  repoPath: string | null;
  worktreePath: string | null;
};

export const fetchPiWorktree = createServerFn({ method: "GET" })
  .inputValidator((input: { piSessionId: string }) => input)
  .handler(async ({ data }): Promise<PiWorkstreamInfo | null> => {
    const path = `/api/pi-sessions/${encodeURIComponent(data.piSessionId)}/workstream`;
    try {
      return (await piRequest(path)) as PiWorkstreamInfo;
    } catch {
      return null;
    }
  });

export const fetchPiInputHistory = createServerFn({ method: "GET" }).handler(
  async (): Promise<ChatTimelineItem[]> => {
    try {
      const res = (await piRequest("/api/pi/history?surface=input")) as {
        items: ChatTimelineItem[];
      };
      return res.items;
    } catch (err) {
      console.error("fetchPiInputHistory failed:", err);
      throw err;
    }
  },
);
