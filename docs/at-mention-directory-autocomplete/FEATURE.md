# @-Mention Directory Autocomplete

## Purpose

The web message input provides an `@`-triggered filesystem picker. It combines direct directory completion with repository-aware fuzzy file search, supports keyboard navigation, and inserts selected paths into the draft.

## User Behavior

An `@` token opens the path picker when `@` is at the start of the draft or follows whitespace. The active query is the text between `@` and the caret. Scanning stops at whitespace, so typing whitespace after the token closes the picker.

Examples:

- `@foo` opens the picker with query `foo`.
- `hello @foo` opens the picker.
- `hello@foo` does not open the picker.
- Pasting a valid `@` token opens the picker because token detection examines the resulting draft value.

Special path controls:

- `@~` expands to `@~/`.
- `@..` and a token ending in `/..` expand with a trailing `/`.
- Typing a slash after an automatic expansion removes the resulting duplicate slash.
- An active `@` token takes precedence over the `/` skill picker.
- Escape closes the picker and refocuses the message input. Escape without an active picker removes focus from the input.
- Arrow Up/Down, Home, End, Enter, and Tab control the picker. Tab acts as Enter.
- A directory selection inserts `@path/` and keeps the picker open for continued traversal.
- A file selection inserts `@path ` and closes the picker.
- Selection replaces the complete active `@` token, including token text after the caret.

## Search Modes

### Direct directory completion

Every request first resolves the current directory prefix and reads that directory.

For `@features/at-`:

- `features/` is the target directory;
- `at-` is the case-insensitive filter;
- prefix matches appear before substring matches;
- directories appear before files;
- results are capped at 15.

The direct layer supports relative, absolute, and `~` paths. Explicit `../` traversal can move above the base cwd but must remain under the user home directory. Unreadable and nonexistent directories return no direct candidates.

Names beginning with `.env` and exact `.git` or `.github` path segments are excluded. Other hidden entries and `node_modules` are not explicitly excluded by this application layer.

### Repository fuzzy search

The route adds fuzzy results when all conditions are true:

- `directoriesOnly` is false;
- the query does not end in `/`;
- the resolved path is inside a directory tree with a `.git` root;
- the repository-relative search term is non-empty.

A nested query such as `web/src/ui` becomes a finder term equivalent to:

```text
web/src/ ui
```

The path prefix narrows the repository area while the final segment acts as the fuzzy term.

The FileFinder searches files, not directories. The route asks for the first 15 file hits, filters excluded paths, and derives directory candidates from matching downstream path segments in those file hits.

For example:

```text
query:      web/src/ui
file hit:   web/src/components/ui/button.tsx
derived dir web/src/components/ui/
```

Directory derivation starts after the already-selected path prefix. For `web/src/ui`, the route does not re-suggest `web/` or `web/src/`.

### Merge order

The route merges candidates in this order:

1. direct directory candidates;
2. direct file candidates;
3. fuzzy derived directories whose segment starts with the term;
4. fuzzy derived directories whose segment contains the term;
5. fuzzy file hits.

It deduplicates by formatted path and caps the final response at 15 items.

## Pseudocode Contracts and Call Graph

### Contracts

```ts
type DirectoryCompletionsRequest = {
  query: string;
  directoriesOnly?: boolean;
};

type DirectoryCompletionItem = {
  name: string;
  kind: "directory" | "file";
  path: string;
  insertText: string;
};

type DirectoryCompletionsResponse = {
  items: DirectoryCompletionItem[];
  cwd: string;
  query: string;
};
```

### Frontend pseudocode

```ts
MessageInput.handleDraftChange(value, inputEvent)
  save draft
  find active @ token before caret

  if no active @ token:
    close path picker
    return

  normalize ~/ and ../ expansions
  atPickerFilter = token text after @
  atPickerOpen = true
  close skill picker

150 ms debounce
  debouncedAtFilter = atPickerFilter

useQuery(directoryCompletionsQueryOptions(
  debouncedAtFilter,
  atPickerOpen,
  { currentContext },
))

pathPickerItems = response.items
pathPickerVisible = atPickerOpen && pathPickerItems.length > 0

PathPicker.onSelect(item)
  replace complete active @ token
  if item.kind === "directory":
    insert @<path>/
    recalculate query and keep picker open
  else:
    insert @<path><space>
    close picker
```

### Backend pseudocode

```ts
handleBrowserDirectoryCompletionsRoute(request)
  rawQuery = request.query ?? ""
  directoriesOnly = request.directoriesOnly === "true"
  baseCwd = resolveBaseCwd(request context)

  directItems = listDirectoryCompletionItems(
    baseCwd,
    rawQuery,
    directoriesOnly,
  )

  repoSearch = resolveRepoSearch(baseCwd, rawQuery)

  if directoriesOnly or repoSearch is unavailable:
    return directItems

  finder = fileFinderManager.getOrCreate(repoSearch.repoRoot)
  fuzzyResult = finder.fileSearch(repoSearch.searchTerm, { pageSize: 15 })

  if fuzzyResult fails:
    return directItems

  searchableFiles = removeExcludedPaths(fuzzyResult.items)
  derivedDirectories = deriveMatchingDownstreamDirectories(searchableFiles)
  fuzzyItems = derivedDirectories + searchableFiles

  return mergeAndCap(directItems, fuzzyItems, 15)
```

### Production call graph

```text
<MessageInput>
  -> handleDraftChange
    -> active @ token + normalized filter
      -> 150 ms debounce
        -> directoryCompletionsQueryOptions
          -> fetchDirectoryCompletions TanStack server function
            -> GET /api/directory-completions
              -> handleBrowserDirectoryCompletionsRoute
                -> resolveBaseCwd
                -> listDirectoryCompletionItems
                -> resolveRepoSearch
                  -> fileFinderManager.getOrCreate(repoRoot)
                    -> FileFinder.create({ basePath, aiMode: true })
                    -> background initial scan
                  -> finder.fileSearch(searchTerm, { pageSize: 15 })
                -> derive fuzzy directories
                -> merge, dedupe, cap
              <- DirectoryCompletionsResponse
        -> <PathPicker>
          -> handlePathSelect
            -> replace token and continue or close
```

## Component Tree

```text
<MessageInput>
│ State: draft, atPickerOpen, atPickerFilter,
│        debouncedAtFilter, caretLeft
│ Refs: textarea, @ position, expansion guards, path command
│ Effect: 150 ms debounce with timer cleanup
│ Query: directory completions keyed by query and context
│
├── <PathPicker>
│   Props: open, items, caretLeft, onSelect, onEscape
│   State: selectedValue
│   └── <Command>
│       └── <CommandList>
│           └── <CommandItem> per directory or file
│
└── <textarea>
    Events: change, keydown, paste
```

`MessageInput` owns token and request state. `PathPicker` owns only the selected result. Server ordering remains authoritative because `Command` disables client-side filtering.

## Query and Cache Behavior

The frontend query key is:

```text
["directory-completions", query, currentContext, directoriesOnly]
```

Behavior:

- The query runs only while the `@` picker is logically open.
- The filter debounce is 150 ms and cancels its preceding timer after each change.
- A `MessageInput` mount prefetches the empty query for its current context.
- Empty-query prefetch performs direct directory listing only; it does not create a FileFinder because no fuzzy term exists.
- Cached results remain fresh for five seconds.
- `keepPreviousData` retains prior items while a changed query loads.
- Changing the message-input context changes the cache key and prefetch context.

The active flow calls the TanStack server function in `web/src/server/directory-completions.ts`. The older `apiClient.getDirectoryCompletions` method is not part of this flow.

## FileFinder Lifecycle

### Creation

`src/file-finder/manager.ts` stores shared instances in a module-level map keyed by normalized absolute repository root.

No finder exists because the server starts, the web input mounts, the empty query prefetches, or the picker opens. The first eligible non-empty fuzzy request creates one.

`getOrCreate(repoRoot)`:

1. normalizes the root with `path.resolve`;
2. reuses a live cached finder and refreshes its insertion order;
3. requires `<repoRoot>/.git`;
4. calls `FileFinder.create({ basePath: repoRoot, aiMode: true })`;
5. caches the finder;
6. evicts the least-recently-used finder when the cache exceeds eight instances;
7. starts `waitForScan(5000)` without awaiting or inspecting its result;
8. returns the finder immediately.

### Readiness

Creation and full indexing are separate states. The route calls `fileSearch()` immediately after `getOrCreate()` returns. The application does not wait for the initial scan, expose scan progress, retry after readiness, or mark partial results. An early query can observe the index while scanning continues.

### Lifetime

A finder is server-global and survives requests, picker closure, message-input unmount, and browser disconnection. The manager refreshes cache order on each reuse.

A finder is destroyed when:

- creating a ninth cached finder evicts the least-recently-used instance; or
- `ControlSurfaceRuntime.stop()` calls `destroyAll()`.

Destroying releases native resources and the background filesystem watcher.

## Loading, Empty, and Error States

The current browser UI has no visible loading or error state for path search.

- On first-load pending with no cached items, the picker remains hidden.
- While a changed query loads, previous items can remain visible without a stale marker.
- An empty response hides the picker.
- `PathPicker` defines “No matching paths,” but `MessageInput` renders it only when items exist, so this empty state is unreachable in this flow.
- The TanStack server function aborts after eight seconds and converts HTTP, network, parsing, and timeout failures to an empty response after server-side logging.
- A FileFinder creation exception or search failure returns direct directory candidates with HTTP 200.
- A direct `readdir` failure returns no direct candidates.
- The browser cannot distinguish loading, no match, partial indexing, finder failure, filesystem failure, or transport failure.

## Current Limitations

- Fuzzy directories are derived only from the first 15 fuzzy file hits. A directory can be absent when no returned file hit passes through it.
- Excluded fuzzy results are removed after the finder selects its first 15 hits, so excluded entries can reduce the valid result window.
- Initial fuzzy requests can use a partial index.
- Loading, empty, and error conditions are not visible to the user.
- Paths containing spaces do not have a complete quoted-token parsing and insertion contract.

## Files

- `web/src/components/common/message-input.tsx` — owns `@` token recognition, debounce, picker state, keyboard controls, and insertion.
- `web/src/components/path-picker.tsx` — renders server-ordered path results and owns result selection.
- `web/src/lib/queries.ts` — defines query keys, caching, enablement, and previous-data behavior.
- `web/src/server/directory-completions.ts` — proxies requests to the control-surface API and converts transport failures to empty responses.
- `src/contracts/control-surface-api.ts` — defines endpoint and response contracts.
- `src/server.ts` — dispatches `GET /api/directory-completions`.
- `src/routes/browser-directory-completions.ts` — resolves cwd, computes direct and fuzzy candidates, and merges results.
- `src/file-finder/manager.ts` — creates, caches, evicts, and destroys shared repository finders.
- `src/runtime.ts` — destroys all finders during runtime shutdown.
