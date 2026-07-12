import { createServerFn } from "@tanstack/react-start";

const BASE_URL = process.env.VITE_FLITTERBOT_BASE_URL || "http://127.0.0.1:18820";
const TOKEN = process.env.VITE_FLITTERBOT_TOKEN || "";

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  };
}

export const fetchUserConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<Record<string, string>> => {
    const url = `${BASE_URL.replace(/\/$/, "")}/api/user-config/default_user`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = (await res.json()) as { config: Record<string, string> };
    return data.config;
  },
);

export const saveUserConfig = createServerFn({ method: "POST" })
  .validator((input: { config: Record<string, string> }) => input)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const url = `${BASE_URL.replace(/\/$/, "")}/api/user-config/default_user`;
    const res = await fetch(url, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ config: data.config }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return { ok: true };
  });
