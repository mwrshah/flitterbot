export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export function formatStartupFailure(error: unknown): string {
  const message = errorMessage(error);
  const detail = errorDetail(error);
  const lines = ["FATAL control surface startup failed"];
  if (detail && detail !== message) lines.push(detail);
  lines.push(`Reason: ${message}`);
  return lines.join("\n");
}
