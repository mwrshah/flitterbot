import fs from "node:fs";

const DEFAULT_TAIL_BYTES = 50_000;

/**
 * Extract the last assistant text from a CC transcript JSONL file.
 * Reads only the tail of the file (last `maxBytes`) to avoid loading multi-MB transcripts.
 */
export function extractLastAssistantText(
  transcriptPath: string,
  maxBytes: number = DEFAULT_TAIL_BYTES,
): string | undefined {
  let fd: number | undefined;
  try {
    if (!fs.existsSync(transcriptPath)) return undefined;
    const stat = fs.statSync(transcriptPath);
    if (stat.size === 0) return undefined;

    fd = fs.openSync(transcriptPath, "r");
    const readSize = Math.min(maxBytes, stat.size);
    const offset = stat.size - readSize;
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, offset);

    const chunk = buffer.toString("utf8");
    const lines = chunk.split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type !== "assistant") continue;
      const message = obj.message as Record<string, unknown> | undefined;
      if (!message || message.role !== "assistant") continue;

      const text = extractTextFromContent(message.content);
      if (!text) continue;

      return text;
    }

    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      parts.push((block as Record<string, unknown>).text as string);
    }
  }
  const joined = parts.join("").trim();
  return joined || undefined;
}
