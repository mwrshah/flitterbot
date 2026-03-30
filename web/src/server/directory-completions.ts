import { createServerFn } from "@tanstack/react-start";
import type { DirectoryCompletionItem } from "~/lib/types";

const BASE_URL = process.env.VITE_AUTONOMA_BASE_URL || "http://127.0.0.1:18820";
const TOKEN = process.env.VITE_AUTONOMA_TOKEN || "";

export const fetchDirectoryCompletions = createServerFn({ method: "GET" })
  .inputValidator((input: { path: string; piSessionId?: string }) => input)
  .handler(async ({ data }): Promise<DirectoryCompletionItem[]> => {
    const params = new URLSearchParams({ path: data.path });
    if (data.piSessionId) params.set("piSessionId", data.piSessionId);

    const url = `${BASE_URL.replace(/\/$/, "")}/api/directory-completions?${params}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { items: DirectoryCompletionItem[] };
      return body.items;
    } catch (err) {
      console.error("fetchDirectoryCompletions failed (path=%s):", data.path, err);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  });
