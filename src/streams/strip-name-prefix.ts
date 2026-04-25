/**
 * Intent-signal prefixes the default agent puts on stream names per its system
 * prompt (e.g. `i-` for investigations, `wr-` for web research, `bug-`/`fix-`
 * for bug fixes, `bs-` for repo brainstorms). They communicate intent at the
 * call site but shouldn't bloat downstream artefacts (worktree dirs, branches,
 * streams.name). Stripped once, only at the very start, only when followed by
 * more content.
 */
const STREAM_NAME_PREFIXES = ["i-", "wr-", "bug-", "bs-", "fix-"] as const;

export function stripStreamNamePrefix(name: string): string {
  for (const prefix of STREAM_NAME_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return name.slice(prefix.length);
    }
  }
  return name;
}
