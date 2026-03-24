import { createServerFn } from "@tanstack/react-start";
import type { ChatTimelineItem } from "~/lib/types";

const BASE_URL = process.env.VITE_AUTONOMA_BASE_URL || "http://127.0.0.1:18820";
const TOKEN = process.env.VITE_AUTONOMA_TOKEN || "";

async function piRequest(path: string): Promise<unknown> {
  const url = `${BASE_URL.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

type AnyJson = unknown;

export const fetchPiHistory = createServerFn({ method: "GET" })
  .inputValidator((input: { piSessionId?: string; surface?: "input" | "agent" }) => input)
  .handler(async ({ data }): Promise<AnyJson> => {
    const params = new URLSearchParams();
    if (data.piSessionId) params.set("piSessionId", data.piSessionId);
    if (data.surface) params.set("surface", data.surface);
    const qs = params.toString();
    const path = qs ? `/api/pi/history?${qs}` : "/api/pi/history";
    const res = (await piRequest(path)) as { items: ChatTimelineItem[] };
    return res.items;
  });

export const fetchPiInputHistory = createServerFn({ method: "GET" }).handler(
  async (): Promise<AnyJson> => {
    const res = (await piRequest("/api/pi/history?surface=input")) as {
      items: ChatTimelineItem[];
    };
    return res.items;
  },
);

