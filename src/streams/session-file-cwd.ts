import { randomUUID } from "node:crypto";
import fs from "node:fs";

export function rewriteSessionHeaderCwd(sessionFile: string, cwd: string): string | undefined {
  const lines = fs.readFileSync(sessionFile, "utf8").split("\n");
  const header = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  if (header.type !== "session") throw new Error("Session file has no native header");
  const previousCwd = typeof header.cwd === "string" ? header.cwd : undefined;
  header.cwd = cwd;
  lines[0] = JSON.stringify(header);
  const temporary = `${sessionFile}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, lines.join("\n"), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, sessionFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return previousCwd;
}
