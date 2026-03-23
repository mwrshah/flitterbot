import fs from "node:fs";
import type { BlackboardDatabase } from "../../blackboard/db.ts";
import { getRecentConversationByWorkstream } from "../../blackboard/queries/messages.ts";
import {
  getWorkstreamByName,
  insertWorkstream,
  listOpenWorkstreams,
  listRecentlyClosedWorkstreams,
  reopenWorkstream,
} from "../../blackboard/queries/workstreams.ts";
import type { WorkstreamRow } from "../../contracts/index.ts";
import { buildClassificationPrompt } from "../../prompts/classifier.ts";
import { type ClassifyResult, callGroqClassify } from "./groq-client.ts";

export type ClassificationResult = {
  workstream: WorkstreamRow | null;
  isWorkMessage: boolean;
  action: "matched" | "created" | "reopened" | "none";
};

function listProjectDirs(projectsDir: string): string[] {
  try {
    if (!fs.existsSync(projectsDir)) return [];
    return fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export async function classifyMessage(
  message: string,
  db: BlackboardDatabase,
  apiKey: string,
  projectsDir: string,
): Promise<ClassificationResult> {
  const workstreams = listOpenWorkstreams(db);
  const recentlyClosed = listRecentlyClosedWorkstreams(db, 6);
  const recentConversation = getRecentConversationByWorkstream(db, 12, 4);
  const projects = listProjectDirs(projectsDir);
  const prompt = buildClassificationPrompt(
    message,
    workstreams,
    recentlyClosed,
    recentConversation,
    projects,
  );
  console.log("── [router] classification prompt ──\n%s\n── [/router prompt] ──", prompt);

  let result: ClassifyResult;
  try {
    result = await callGroqClassify(apiKey, prompt);
  } catch (error) {
    // If classification fails, pass through as non-work (don't block the message)
    console.error(
      `[router] Groq classification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { workstream: null, isWorkMessage: false, action: "none" };
  }

  if (!result.is_work_message) {
    return { workstream: null, isWorkMessage: false, action: "none" };
  }

  // Try to match existing open workstream
  if (result.workstream_id) {
    const existing = workstreams.find((ws) => ws.id === result.workstream_id);
    if (existing) {
      return { workstream: existing, isWorkMessage: true, action: "matched" };
    }

    // Check if it matches a recently closed workstream — reopen it
    const closed = recentlyClosed.find((ws) => ws.id === result.workstream_id);
    if (closed) {
      const reopened = reopenWorkstream(db, closed.id);
      if (reopened) {
        return { workstream: reopened, isWorkMessage: true, action: "reopened" };
      }
    }

    // LLM returned an id that doesn't exist — fall through to create
  }

  // Create new workstream (dedup: reuse existing open workstream with same name)
  if (result.new_workstream_name) {
    const existing = getWorkstreamByName(db, result.new_workstream_name);
    if (existing && existing.status === "open") {
      return { workstream: existing, isWorkMessage: true, action: "matched" };
    }
    const created = insertWorkstream(db, result.new_workstream_name);
    return { workstream: created, isWorkMessage: true, action: "created" };
  }

  // Work message but no workstream assignment
  return { workstream: null, isWorkMessage: true, action: "none" };
}
