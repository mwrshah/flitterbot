export function isPreparedLaunchCwdTrigger(value: string, triggerIndex: number): boolean {
  const lineStart = value.lastIndexOf("\n", triggerIndex - 1) + 1;
  return value.slice(lineStart, triggerIndex).includes('"cwd"');
}

export function preparedLaunchCompletionTokenEnd(value: string, triggerIndex: number): number {
  let tokenEnd = triggerIndex + 1;
  while (tokenEnd < value.length && value[tokenEnd] !== '"' && !/\s/.test(value[tokenEnd]!)) {
    tokenEnd++;
  }
  return tokenEnd;
}

export function readPreparedLaunchCwd(value: string): string | null {
  const keyStart = value.indexOf('"cwd"');
  if (keyStart < 0) return null;
  const colon = value.indexOf(":", keyStart + '"cwd"'.length);
  if (colon < 0) return null;
  const valueStart = value.indexOf('"', colon + 1);
  if (valueStart < 0) return null;
  const valueEnd = value.indexOf('"', valueStart + 1);
  if (valueEnd < 0) return null;

  const cwd = value
    .slice(valueStart + 1, valueEnd)
    .trim()
    .replace(/^@(?=\/)/, "");
  return cwd.startsWith("/") ? cwd : null;
}

export function escapeJsonStringFragment(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export function stringifyPreparedLaunchForEditing(value: unknown): string {
  if (typeof value !== "object" || !value || Array.isArray(value)) {
    return JSON.stringify(value, null, 2) ?? "";
  }

  const launch = value as Record<string, unknown>;
  const cwd = launch.cwd;
  if (typeof cwd !== "string") return JSON.stringify(launch, null, 2) ?? "";

  const trimmedCwd = cwd.trim();
  const editableCwd = trimmedCwd.startsWith("/") ? `@${trimmedCwd}` : trimmedCwd;
  return JSON.stringify({ ...launch, cwd: editableCwd }, null, 2) ?? "";
}
