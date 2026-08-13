# Session File Search

## Problem

Sidebar name search cannot find a swimlane from terms inside its raw Pi session. The resident session corpus also retains superseded default sessions, which makes any direct content search slower and weakens the one-default-per-user invariant.

## Goals

- Search raw resident Pi session JSONL files with FFF.
- Keep `archived-sessions/` outside the search corpus.
- Keep one current non-stream default session per user in `sessions/`.
- Archive prior defaults when their replacement is created.
- Preserve the sidebar picker, keyboard behavior, sections, pins, and recency ordering.
- Rank stream-name matches before content-related matches within each sidebar section.
- Rank content-related sessions by up to 20 matched lines, then preserve existing order for ties.
- Maintain no transcript projection or materialized search index.

## Architecture

FFF indexes `controlSurfaceSessionsDir` directly. The shared FileFinder manager permits files up to 32 MiB for every indexed root. The route awaits FFF's lazy initial scan, then normalizes the query into unique whitespace-delimited patterns of at least two characters. It logs those exact patterns and skips content search when none remain. The search calls `multiGrep()` with the patterns separate from its `*.jsonl` constraint and up to 20 matches per file, follows every FFF cursor page, and resolves the complete matched path set to `pi_sessions` rows through the blackboard.

The session lifecycle keeps open streams, pinned closed streams, and the current default in `sessions/`. Existing stream placement policy remains unchanged. Default-session creation records `session_user`, ends every prior live non-stream default for that user in one transaction, leaves Pi in sole control of the new session file, and moves only predecessors still recorded in `sessions/` to `archived-sessions/`.

The sidebar sends one normalized query after the existing 150 ms picker debounce. Name filtering remains immediate, including when content search skips a query with no pattern of at least two characters. One completed paginated FFF search adds related sessions after name matches and ranks them by matched-line count. Search failures leave name matching usable.

## Pseudocode Contracts and Call Graph

```ts
interface SessionSearchResponse {
  matches: Array<{ piSessionId: string; matchCount: number }>;
}

GET /api/session-search?query=...
  normalize unique whitespace-delimited patterns with length >= 2
  log the exact patterns
  return no content matches when patterns is empty

searchSessionFiles(blackboard, finder, sessionsDir, patterns): SessionFileSearchResult
  cursor = null
  do
    multiGrep({
      patterns,
      constraints: "*.jsonl",
      maxMatchesPerFile: 20,
      cursor,
    })
    accumulate matched lines by resident file
    cursor = nextCursor
  while cursor
  resolve exact resident file paths through pi_sessions
  return related IDs and match counts

replaceDefaultPiSession(input & { sessionUser }): previousPiSessionIds
  BEGIN IMMEDIATE
  select same-user non-stream default predecessors
  end live predecessors
  upsert current default with owner
  COMMIT
```

Production:

```text
GET /api/session-search?query=...
  → await shared FileFinder for controlSurfaceSessionsDir
    → FFF literal multi-grep over resident *.jsonl files
      → blackboard path-to-Pi-session resolution
        → SessionSearchResponse

ControlSurfaceRuntime.start / PiSessionManager.resetDefault
  → replaceDefaultPiSession
    → reconcilePiSessionFile(predecessors, archived)

SidebarSwimlanes
  → 150 ms debounced TanStack query
    → session-search API
      → projectSidebarRows(open rows)
      → projectSidebarRows(recently closed rows)
```

## Component Tree

```text
<SidebarSwimlanes>
│ State: query, debouncedSearchQuery
│ Server data: statusQuery, sessionSearchQuery
│ Existing picker state: PickerCursor refs and selection handlers
│ Derived data: match-count map, projected open rows, projected closed rows
│
├── <input>
│   Events: existing focus, blur, keyboard, and immediate name-selection behavior
│
└── <SwimlaneRows>
    ├── projected open rows
    └── projected recently closed rows
```

## Files

- `src/file-finder/manager.ts` — modify: accept non-Git FFF roots and a shared 32 MiB file cap.
- `src/session-file-search.ts` — create: search FFF's first multi-grep page and resolve resident session paths.
- `src/routes/browser-session-search.ts` — create: expose resident session relationships.
- `src/server.ts` — modify: route session search.
- `src/contracts/control-surface-api.ts` — modify: define the search response and endpoint.
- `src/blackboard/pi-sessions.ts` — modify: replace same-user defaults atomically and return persisted cleanup debt.
- `src/blackboard/write-pi-sessions.ts` — modify: persist explicit default ownership and update files by Pi session identity.
- `src/blackboard/migrate.ts` — modify: index default-owner placement lookup.
- `src/blackboard/schema.sql` — modify: declare the placement index for schema parity.
- `src/contracts/blackboard.ts` — modify: bump the schema and declare the placement index.
- `src/streams/session-file-placement.ts` — modify: place stream and non-stream Pi session files through one primitive.
- `src/streams/pi-session-manager.ts` — modify: place current and prior defaults at creation and reset.
- `src/runtime.ts` — modify: assign configured ownership to legacy and new defaults.
- `web/src/lib/api.ts` — modify: call session search.
- `web/src/lib/queries.ts` — modify: define the debounced search query behavior.
- `web/src/lib/sidebar-search.ts` — create: apply ordinal name/content ranking.
- `web/src/components/sidebar.tsx` — modify: merge FFF relationships into the existing picker.
