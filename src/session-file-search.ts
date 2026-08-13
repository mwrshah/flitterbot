import path from "node:path";
import type { FileFinder } from "@ff-labs/fff-node";
import type { BlackboardDatabase } from "./blackboard/db.ts";
import { FILE_FINDER_MAX_FILE_SIZE } from "./file-finder/manager.ts";

export type SessionFileSearchResult = {
  matches: Array<{ piSessionId: string; matchCount: number }>;
};

export function searchSessionFiles(
  blackboard: BlackboardDatabase,
  finder: FileFinder,
  sessionsDir: string,
  query: string,
): SessionFileSearchResult {
  const patterns = [...new Set(query.trim().split(/\s+/))].filter(Boolean);
  if (patterns.length === 0) return { matches: [] };

  const result = finder.multiGrep({
    patterns,
    constraints: "*.jsonl",
    maxFileSize: FILE_FINDER_MAX_FILE_SIZE,
    maxMatchesPerFile: 20,
  });
  if (!result.ok) throw new Error(`FFF session search failed: ${result.error}`);

  const matchCountByFile = new Map<string, number>();
  for (const match of result.value.items) {
    const sessionFile = path.resolve(sessionsDir, match.relativePath);
    matchCountByFile.set(sessionFile, (matchCountByFile.get(sessionFile) ?? 0) + 1);
  }

  const sessionFiles = [...matchCountByFile.keys()];
  if (sessionFiles.length === 0) return { matches: [] };

  const placeholders = sessionFiles.map(() => "?").join(", ");
  const rows = blackboard.all<{ pi_session_id: string; session_file: string }>(
    `SELECT pi_session_id, session_file FROM pi_sessions WHERE session_file IN (${placeholders})`,
    ...sessionFiles,
  );
  return {
    matches: rows.map((row) => ({
      piSessionId: row.pi_session_id,
      matchCount: matchCountByFile.get(row.session_file)!,
    })),
  };
}
