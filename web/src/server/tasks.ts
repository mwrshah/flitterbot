import { createServerFn } from "@tanstack/react-start";
import type { DueTasksResponse } from "@/lib/types";

const BASE_URL = process.env.VITE_FLITTERBOT_BASE_URL || "http://127.0.0.1:18820";
const TOKEN = process.env.VITE_FLITTERBOT_TOKEN || "";

export const fetchDueTasks = createServerFn({ method: "GET" }).handler(
  async (): Promise<DueTasksResponse> => {
    const response = await fetch(`${BASE_URL.replace(/\/$/, "")}/api/tasks/due`, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : undefined,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return (await response.json()) as DueTasksResponse;
  },
);
