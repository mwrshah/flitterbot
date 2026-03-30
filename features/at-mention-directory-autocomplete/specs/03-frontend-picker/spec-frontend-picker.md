# Spec: Frontend Path Picker + MessageInput Integration

## Functional Requirements

### Trigger Detection
1. **FR1**: Detect `@` trigger in `MessageInput` using the same backwards-scan pattern as `/` for skills. `@` is valid when preceded by start-of-string or whitespace.
2. **FR2**: The text between `@` and the cursor is the path partial (may contain `/` characters — unlike skill names, don't stop scanning at `/`).
3. **FR3**: Only one picker can be open at a time (skill picker XOR path picker).

### Data Fetching
4. **FR4**: Use TanStack Query with `queryKey: ['directory-completions', pathFilter]` to fetch completions from the backend.
5. **FR5**: Use `placeholderData: keepPreviousData` to avoid UI flicker during refetches.
6. **FR6**: Debounce the path filter by ~150ms before triggering a query (avoid hammering on every keystroke). Use a state variable that updates on a timeout, not imperative event listeners.

### PathPicker Component
7. **FR7**: New `PathPicker` component modeled on `SkillPicker` — uses cmdk `<Command>` for the list.
8. **FR8**: Each item shows an icon (📁/📄), the entry name, and the relative path in muted text.
9. **FR9**: Positioned with the same `caretLeft` + `bottom-full` technique as SkillPicker.
10. **FR10**: Max height with scroll, matching SkillPicker's `max-h-48`.
11. **FR11**: Show a loading state when the query is fetching (subtle spinner or "Loading..." text).

### Keyboard Navigation
12. **FR12**: ArrowUp/Down cycle through items, Enter selects, Escape dismisses — same pattern as skill picker.
13. **FR13**: When a directory is selected, insert the path (e.g., `@src/`) and keep the picker open — the trigger detection naturally re-fires with the new prefix, fetching the directory's contents.
14. **FR14**: When a file is selected, insert the full path (e.g., `@src/server.ts`) and close the picker by adding a trailing space.

### Selection Behavior
15. **FR15**: On select, replace text from the `@` position through the cursor with `@<path>` (+ space for files, no space for directories to enable drill-down).
16. **FR16**: Restore cursor position after insertion via `requestAnimationFrame`.

## Technical Approach

### New Files
- `web/src/components/path-picker.tsx` — the popover component
- `web/src/server/directory-completions.ts` — TanStack Start `createServerFn` that calls the backend API

### Modified Files
- `web/src/components/ui/message-input.tsx`:
  - Add `@` detection in `handleDraftChange` alongside existing `/` detection
  - Add `atPickerOpen`, `atPickerFilter`, `atPositionRef` state (parallel to skill picker state)
  - Render `<PathPicker>` alongside `<SkillPicker>` in the container div
  - Extend `handleKeyDown` to delegate to path picker when it's open
  - Add `handlePathSelect` callback (parallel to `handleSkillSelect`)
- `web/src/lib/api.ts` — add `getDirectoryCompletions(path: string)` method
- `web/src/lib/types.ts` — add `DirectoryCompletionItem`, `DirectoryCompletionsResponse`
- `web/src/lib/queries.ts` — add `directoryCompletionsQueryOptions(pathFilter, enabled)`

### Debounce Strategy
Use a `debouncedFilter` state that updates via `setTimeout`/`clearTimeout` in a `useEffect` keyed on `atPickerFilter`. The TanStack Query uses `debouncedFilter` as the query key, not the raw filter. This keeps everything in React state (no imperative plumbing).
