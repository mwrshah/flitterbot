import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import readline from "node:readline";
import type {
  TranscriptNormalizedItem,
  TranscriptPageResponse,
  TranscriptToolStatus,
} from "../contracts/index.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (value === null || value === undefined || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    const values = value
      .map((item) => firstString(item))
      .filter((item): item is string => Boolean(item));
    return values.length > 0 ? values.join("\n") : null;
  }

  const record = asRecord(value);
  const direct = [record.text, record.content, record.message, record.summary, record.error]
    .map((item) => firstString(item))
    .find((item) => Boolean(item));
  if (direct) {
    return direct;
  }

  if (Array.isArray(record.parts)) {
    return firstString(record.parts);
  }

  if (Array.isArray(record.content)) {
    return firstString(record.content);
  }

  return null;
}

function detectToolStatus(record: Record<string, unknown>): TranscriptToolStatus | null {
  const candidate = [record.status, record.tool_status, record.toolStatus].find(
    (value) => typeof value === "string" && value.trim(),
  ) as string | undefined;

  if (!candidate) {
    return null;
  }

  const normalized = candidate.toLowerCase();
  if (normalized.includes("start")) return "started";
  if (normalized.includes("fail") || normalized.includes("error")) return "failed";
  if (
    normalized.includes("complete") ||
    normalized.includes("finish") ||
    normalized.includes("success")
  ) {
    return "completed";
  }
  return null;
}

function normalizeTranscriptItem(
  sessionId: string,
  transcriptPath: string,
  lineNumber: number,
  rawLine: string,
  parsed: unknown,
): TranscriptNormalizedItem {
  const record = asRecord(parsed);
  const rawType = [record.event_name, record.type, record.kind, record.event].find(
    (value) => typeof value === "string" && value.trim(),
  ) as string | undefined;
  const role = [record.role, record.sender, record.author].find(
    (value) => value === "user" || value === "assistant" || value === "system",
  ) as "user" | "assistant" | "system" | undefined;
  const timestamp = [
    record.timestamp,
    record.ts,
    record.time,
    record.created_at,
    record.createdAt,
  ].find((value) => typeof value === "string" && value.trim()) as string | undefined;
  const toolName = [record.tool_name, record.toolName, record.name].find(
    (value) => typeof value === "string" && value.trim(),
  ) as string | undefined;
  const toolUseId = [record.tool_use_id, record.toolUseId, record.id].find(
    (value) => typeof value === "string" && value.trim(),
  ) as string | undefined;
  const text = firstString(record) ?? rawLine;
  const toolStatus = detectToolStatus(record);
  const isError = Boolean(record.error) || toolStatus === "failed";

  let actor: TranscriptNormalizedItem["actor"] = "unknown";
  if (role) {
    actor = role;
  } else if (toolName) {
    actor = "tool";
  } else if (rawType) {
    actor = "runtime";
  }

  let kind: TranscriptNormalizedItem["kind"] = "unknown";
  if (toolName && toolStatus === "started") {
    kind = "tool_call";
  } else if (toolName) {
    kind = "tool_result";
  } else if (role) {
    kind = "message";
  } else if (rawType) {
    kind = "event";
  }

  const title =
    toolName && kind === "tool_call"
      ? `Tool call: ${toolName}`
      : toolName && kind === "tool_result"
        ? `Tool result: ${toolName}`
        : rawType
          ? rawType
          : null;

  return {
    id: `${sessionId}:${lineNumber}`,
    cursor: String(lineNumber),
    sessionId,
    transcriptPath,
    lineNumber,
    timestamp: timestamp ?? null,
    actor,
    kind,
    role: role ?? null,
    title,
    text,
    toolName: toolName ?? null,
    toolUseId: toolUseId ?? null,
    toolStatus,
    isError,
    metadata: {
      rawKeys: Object.keys(record),
    },
    rawType: rawType ?? null,
  };
}

export async function readTranscriptPage(
  sessionId: string,
  transcriptPath: string,
  cursor = "0",
  limit = 100,
): Promise<TranscriptPageResponse> {
  const startLine = Math.max(0, Number.parseInt(cursor, 10) || 0);
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 100, 1), 200);
  await stat(transcriptPath);
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const items: TranscriptNormalizedItem[] = [];
  let lineNumber = 0;
  let nextCursor: string | undefined;

  try {
    for await (const line of lines) {
      if (lineNumber < startLine) {
        lineNumber += 1;
        continue;
      }

      if (items.length >= safeLimit) {
        nextCursor = String(lineNumber);
        break;
      }

      const trimmed = line.trim();
      if (!trimmed) {
        lineNumber += 1;
        continue;
      }

      let parsed: unknown = trimmed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = { type: "raw", text: trimmed };
      }

      items.push(
        normalizeTranscriptItem(sessionId, transcriptPath, lineNumber + 1, trimmed, parsed),
      );
      lineNumber += 1;
    }
  } finally {
    lines.close();
    stream.close();
  }

  return {
    sessionId,
    transcriptPath,
    oldestFirst: true,
    items,
    nextCursor,
  };
}
