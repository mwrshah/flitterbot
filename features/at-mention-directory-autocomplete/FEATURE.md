# @-Mention Directory Autocomplete

An `@`-triggered filesystem path picker in the web chat input. It helps users reference files and directories without typing full paths from memory, supports keyboard navigation, and combines normal directory listing with repo-aware fuzzy search.

## User Behavior

Typing `@` in the composer opens a path picker.

- Directory entries insert as `@path/` and keep the picker open so the user can keep drilling down
- File entries insert as `@path ` and close the picker
- Results are capped at 15 items
- Directories are shown before files when both are present

## Two Search Modes

### 1. Plain directory completion

When the current `@` token resolves to a real directory prefix, the server lists entries from that directory and filters by the typed suffix.

Example:

- `@features/at-` lists entries inside `features/` starting with `at-`
- Hidden entries and `node_modules` are excluded
- Results are sorted with directories first, then files

This is standard filesystem autocomplete, not fuzzy search.

### 2. Repo-aware fuzzy search

When the query resolves inside a git repo, the server also runs a fuzzy file search rooted at that repo.

Example:

- `@web/src/ui`

This is interpreted as:

- repo-relative path prefix: `web/src/`
- fuzzy search term: `ui`

The file finder searches for fuzzy file hits using the repo-relative query, then the server derives extra directory suggestions from those matching file paths.

## Fuzzy Directory Matching

The fuzzy layer does not index directories directly. Instead:

1. Run fuzzy file search inside the repo
2. Look at each matched file path
3. Walk the directory segments in that path
4. Add directories whose directory name contains the fuzzy term
5. Deduplicate them
6. Return those directories before the file hits

Example:

- query: `@web/src/ui`
- fuzzy file hit: `web/src/components/ui/button.tsx`
- derived directory hit: `components/ui/`

This lets the picker show `ui/`-containing directories first, even though the underlying fuzzy search is file-based.

## Prefix Exclusion Rule

The fuzzy term should only match directories downstream of the already-selected path prefix.

Example:

- query: `@web/src/ui`
- locked prefix: `web/src/`
- fuzzy term: `ui`

The picker must not return:

- `web/`
- `src/`

even if those segments appear in matched file paths, because they are already part of the selected prefix. Only segments after that prefix are eligible for fuzzy directory matches.

This avoids noisy or redundant suggestions and preserves the user's traversal intent: once the user has already navigated to `web/src/`, the fuzzy term should refine what comes next, not re-suggest what is already implied.

## Result Ordering

The response merges two sources:

1. Normal directory-completion results from the current filesystem location
2. Repo fuzzy results

Within the fuzzy portion, derived directory hits come first, then file hits. The final merged list is deduped by path and capped at 15 items.

## Architecture

High-level flow:

```text
@ token in composer
  -> debounced request to /api/directory-completions
  -> resolve base cwd from stream or default project context
  -> list plain directory matches
  -> if query is inside a git repo, run repo-aware fuzzy file search
  -> derive matching downstream directories from fuzzy file hits
  -> merge, dedupe, cap, return
```

Key pieces:

- `web/src/components/common/message-input.tsx` opens the picker and inserts selections
- `web/src/server/directory-completions.ts` fetches server results
- `src/routes/browser-directory-completions.ts` computes directory and fuzzy matches
- `src/file-finder/manager.ts` owns shared `fff-node` repo finder instances

## Current Limitations

- Fuzzy directory matches are heuristic, not first-class. They are derived from the top fuzzy file hits rather than from a dedicated directory search index.
- Because of that, a directory may be omitted if no returned file hit passes through it.
- The result window is intentionally small to keep the picker responsive.

## TBD

- Quoted paths that contain spaces need first-class handling. Directory and file names like `"My Folder"` or `"some file.ts"` should be parsed, searched, and inserted correctly without confusing prefix parsing or fuzzy-term extraction. Defer implementation until the next pass on path-token parsing.

## Design Intent

The feature is meant to preserve the speed of normal path traversal while making partial repo path search useful.

The important behavioral rule is:

- the typed prefix narrows where we are searching
- the fuzzy term matches what comes next
- downstream matching directories should surface before files
