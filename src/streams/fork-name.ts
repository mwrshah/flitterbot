export function nextForkName(sourceName: string): string {
  let baseName = sourceName;
  let forkCount = 0;
  let prefix = /^fork(?:(\d+))?-(.+)$/.exec(baseName);

  while (prefix) {
    forkCount += prefix[1] ? Number(prefix[1]) : 1;
    baseName = prefix[2]!;
    prefix = /^fork(?:(\d+))?-(.+)$/.exec(baseName);
  }

  forkCount++;
  return forkCount === 1 ? `fork-${baseName}` : `fork${forkCount}-${baseName}`;
}
