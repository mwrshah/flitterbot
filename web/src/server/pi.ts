import { createServerFn } from "@tanstack/react-start";
import type { ChatTimelineItem, StatusResponse } from "~/lib/types";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJson = any;

export const fetchPiHistory = createServerFn({ method: "GET" })
  .inputValidator((input: { piSessionId?: string }) => input)
  .handler(async ({ data }): Promise<AnyJson> => {
    const params = new URLSearchParams();
    if (data.piSessionId) params.set("piSessionId", data.piSessionId);
    const qs = params.toString();
    const path = qs ? `/api/pi/history?${qs}` : "/api/pi/history";
    const res = (await piRequest(path)) as { items: ChatTimelineItem[] };
    return res.items;
  });

export const fetchPiStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<AnyJson> => {
    return (await piRequest("/status")) as StatusResponse;
  },
);
