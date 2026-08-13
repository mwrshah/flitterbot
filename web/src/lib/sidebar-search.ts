export function projectSidebarRows<T extends { name: string; piSessionId?: string }>(
  rows: readonly T[],
  normalizedQuery: string,
  matchCountByPiSessionId: ReadonlyMap<string, number>,
): readonly T[] {
  if (!normalizedQuery) return rows;

  const nameMatches: T[] = [];
  const contentMatches: T[] = [];
  for (const row of rows) {
    if (row.name.toLowerCase().includes(normalizedQuery)) {
      nameMatches.push(row);
    } else if (row.piSessionId && matchCountByPiSessionId.has(row.piSessionId)) {
      contentMatches.push(row);
    }
  }
  const matchCount = (row: T) =>
    row.piSessionId ? (matchCountByPiSessionId.get(row.piSessionId) ?? 0) : 0;
  contentMatches.sort((left, right) => matchCount(right) - matchCount(left));
  return [...nameMatches, ...contentMatches];
}
