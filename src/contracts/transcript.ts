import type { MessageMetadata } from "./blackboard.ts";

export type TranscriptActor = "user" | "assistant" | "system" | "tool" | "runtime" | "unknown";
export type TranscriptItemKind =
  | "message"
  | "tool_call"
  | "tool_result"
  | "event"
  | "summary"
  | "unknown";

export type TranscriptToolStatus = "started" | "completed" | "failed";

export interface TranscriptNormalizedItem {
  id: string;
  cursor: string;
  sessionId: string;
  transcriptPath: string | null;
  lineNumber: number;
  timestamp: string | null;
  actor: TranscriptActor;
  kind: TranscriptItemKind;
  role: "user" | "assistant" | "system" | null;
  title: string | null;
  text: string | null;
  toolName: string | null;
  toolUseId: string | null;
  toolStatus: TranscriptToolStatus | null;
  isError: boolean;
  metadata: MessageMetadata;
  rawType: string | null;
}

export interface TranscriptPageResponse {
  sessionId: string;
  transcriptPath: string | null;
  oldestFirst: true;
  items: TranscriptNormalizedItem[];
  nextCursor?: string;
}
