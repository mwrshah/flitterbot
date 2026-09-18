import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DocumentError } from "./store.ts";

export const hashBytes = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
export type FileSnapshot = { bytes: Buffer; hash: string; identity: string } | null;
const identity = (stat: fs.Stats): string =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
export function observe(filePath: string): FileSnapshot {
  let fd: number;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new DocumentError("ProjectionReadError", filePath);
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new DocumentError("InvalidProjection", filePath);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    let current: fs.Stats;
    try {
      current = fs.lstatSync(filePath);
    } catch {
      throw new DocumentError("FileChanged", filePath);
    }
    if (identity(before) !== identity(after) || identity(after) !== identity(current))
      throw new DocumentError("FileChanged", filePath);
    return { bytes, hash: hashBytes(bytes), identity: identity(after) };
  } finally {
    fs.closeSync(fd);
  }
}
export function unchanged(filePath: string, expected: FileSnapshot): FileSnapshot {
  const current = observe(filePath);
  if (current?.hash !== expected?.hash || current?.identity !== expected?.identity)
    throw new DocumentError("FileChanged", filePath);
  return current;
}
export function replaceFile(filePath: string, bytes: string, expected?: FileSnapshot): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (expected !== undefined) unchanged(filePath, expected);
    else observe(filePath);
    fs.renameSync(tmp, filePath);
    const dir = fs.openSync(path.dirname(filePath), "r");
    try {
      try {
        fs.fsyncSync(dir);
      } catch (error) {
        if (!["EINVAL", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
    } finally {
      fs.closeSync(dir);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
