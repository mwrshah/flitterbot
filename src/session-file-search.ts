import path from "node:path";
import type { FileFinder, GrepCursor } from "@ff-labs/fff-node";
import type { BlackboardDatabase } from "./blackboard/db.ts";
import { FILE_FINDER_MAX_FILE_SIZE } from "./file-finder/manager.ts";

export type SessionFileSearchResult = {
  matches: Array<{ piSessionId: string; matchCount: number }>;
};

export function searchSessionFiles(
  blackboard: BlackboardDatabase,
  finder: FileFinder,
  sessionsDir: string,
  patterns: string[],
): SessionFileSearchResult {
  if (patterns.length === 0) return { matches: [] };

  const matchCountsByFile = new Map<string, number[]>();
  for (const [patternIndex, pattern] of patterns.entries()) {
    let cursor: GrepCursor | null = null;
    do {
      const result = finder.multiGrep({
        patterns: [pattern],
        constraints: "*.jsonl",
        maxFileSize: FILE_FINDER_MAX_FILE_SIZE,
        maxMatchesPerFile: 20,
        cursor,
      });
      if (!result.ok) throw new Error(`FFF session search failed: ${result.error}`);

      for (const match of result.value.items) {
        const sessionFile = path.resolve(sessionsDir, match.relativePath);
        const counts = matchCountsByFile.get(sessionFile) ?? Array(patterns.length).fill(0);
        counts[patternIndex] = (counts[patternIndex] ?? 0) + 1;
        matchCountsByFile.set(sessionFile, counts);
      }
      cursor = result.value.nextCursor;
    } while (cursor);
  }

  const matchScoreByFile = new Map(
    [...matchCountsByFile]
      .filter(([, counts]) => counts.every((count) => count > 0))
      .map(([sessionFile, counts]) => [
        sessionFile,
        Math.round(
          Math.exp(counts.reduce((sum, count) => sum + Math.log(count), 0) / counts.length) * 1e12,
        ) / 1e12,
      ]),
  );
  const sessionFiles = [...matchScoreByFile.keys()];
  if (sessionFiles.length === 0) return { matches: [] };

  const placeholders = sessionFiles.map(() => "?").join(", ");
  const rows = blackboard.all<{ pi_session_id: string; session_file: string }>(
    `SELECT pi_session_id, session_file FROM pi_sessions WHERE session_file IN (${placeholders})`,
    ...sessionFiles,
  );
  return {
    matches: rows.map((row) => ({
      piSessionId: row.pi_session_id,
      matchCount: matchScoreByFile.get(row.session_file)!,
    })),
  };
}
