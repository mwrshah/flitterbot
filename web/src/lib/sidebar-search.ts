const MAX_OPEN_CONTENT_MATCHES = 4;
const MAX_CONTENT_MATCHES = 7;

export function projectSidebarRows<
  T extends { name: string; piSessionId?: string; section: "open" | "closed" },
>(
  rows: readonly T[],
  normalizedQuery: string,
  matchCountByPiSessionId: ReadonlyMap<string, number>,
): readonly T[] {
  if (!normalizedQuery) return rows;

  const nameQueryParts = normalizedQuery.split(/\s+/);
  const nameQueries = [" ", "-", "_"].map((separator) => nameQueryParts.join(separator));
  const openNameMatches: T[] = [];
  const closedNameMatches: T[] = [];
  const contentMatches: T[] = [];
  for (const row of rows) {
    const name = row.name.toLowerCase();
    if (nameQueries.some((query) => name.includes(query))) {
      (row.section === "open" ? openNameMatches : closedNameMatches).push(row);
    } else if (row.piSessionId && matchCountByPiSessionId.has(row.piSessionId)) {
      contentMatches.push(row);
    }
  }
  const matchCount = (row: T) =>
    row.piSessionId ? (matchCountByPiSessionId.get(row.piSessionId) ?? 0) : 0;
  contentMatches.sort((left, right) => matchCount(right) - matchCount(left));
  const openContentMatches = contentMatches.filter((row) => row.section === "open");
  const closedContentMatches = contentMatches.filter((row) => row.section === "closed");
  const closedContentLimit = Math.min(
    closedContentMatches.length,
    MAX_CONTENT_MATCHES - Math.min(MAX_OPEN_CONTENT_MATCHES, openContentMatches.length),
  );
  const openContentLimit = MAX_CONTENT_MATCHES - closedContentLimit;
  return [
    ...openNameMatches,
    ...openContentMatches.slice(0, openContentLimit),
    ...closedNameMatches,
    ...closedContentMatches.slice(0, closedContentLimit),
  ];
}
