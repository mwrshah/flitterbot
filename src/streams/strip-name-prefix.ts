const STREAM_NAME_PREFIXES = ["i-", "wr-", "bug-", "bs-", "fix-"] as const;

export function stripStreamNamePrefix(name: string): string {
  for (const prefix of STREAM_NAME_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return name.slice(prefix.length);
    }
  }
  return name;
}
