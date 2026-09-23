const required = [
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
  "WORKOS_REDIRECT_URI",
] as const;

export function validateAuthConfig(): void {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0 || (process.env.WORKOS_COOKIE_PASSWORD?.length ?? 0) < 32) {
    throw new Error("WorkOS authentication is not configured correctly.");
  }
}
