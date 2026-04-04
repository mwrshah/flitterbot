import { createServerFn } from "@tanstack/react-start";
import type { DirectoryCompletionItem } from "~/lib/types";

const BASE_URL = process.env.VITE_AUTONOMA_BASE_URL || "http://127.0.0.1:18820";
const TOKEN = process.env.VITE_AUTONOMA_TOKEN || "";

export type DirectoryCompletionsResult = {
  items: DirectoryCompletionItem[];
  cwd: string;
  query: string;
};

export const fetchDirectoryCompletions = createServerFn({ method: "GET" })
  .inputValidator((input: { query: string; piSessionId?: string; streamId?: string }) => input)
  .handler(async ({ data }): Promise<DirectoryCompletionsResult> => {
    const params = new URLSearchParams({ query: data.query });
    if (data.piSessionId) params.set("piSessionId", data.piSessionId);
    if (data.streamId) params.set("streamId", data.streamId);

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
      const body = (await res.json()) as {
        items: DirectoryCompletionItem[];
        cwd: string;
        query: string;
      };
      return { items: body.items, cwd: body.cwd, query: body.query };
    } catch (err) {
      console.error("fetchDirectoryCompletions failed (query=%s):", data.query, err);
      return { items: [], cwd: "", query: data.query };
    } finally {
      clearTimeout(timeout);
    }
  });
