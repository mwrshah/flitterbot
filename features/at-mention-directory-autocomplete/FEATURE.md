# @-mention Directory Autocomplete

## Problem
Users need to reference files and directories from the machine's filesystem when chatting with Pi via the web interface. Currently there's no way to browse or autocomplete paths — users must type full paths from memory.

## Goals
- Type `@` in the chat input to trigger a filesystem path autocomplete popover
- Show top 15 matching entries from the current working directory
- Keyboard-navigable (arrow keys, Enter to select, Escape to dismiss)
- Progressive directory traversal (selecting a directory drills into it)
- Reuse the existing slash-command popover patterns (cmdk, mirror-div positioning, same keyboard handling)

## Architecture

### Backend
- New `GET /api/directory-completions?path=<partial>&piSessionId=<id>` endpoint
- Resolves CWD from the Pi session, reads directory entries via `node:fs`
- Returns `{ items: [{ name, kind, path }], cwd }` — max 15 entries, directories first

### Frontend
- New `PathPicker` component (mirrors `SkillPicker` structure using cmdk)
- `@` trigger detection in `MessageInput` (same pattern as `/` for skills)
- TanStack Query for fetching completions (debounced, with `placeholderData: keepPreviousData`)
- On directory select: insert path and keep picker open for drill-down
- On file select: insert path and close picker

## Files Touched
- `src/routes/browser-directory-completions.ts` (new)
- `src/server.ts` (register route)
- `src/contracts/control-surface-api.ts` (add endpoint)
- `web/src/components/path-picker.tsx` (new)
- `web/src/components/ui/message-input.tsx` (add @ trigger)
- `web/src/lib/api.ts` (add client method)
- `web/src/lib/types.ts` (add types)
- `web/src/lib/queries.ts` (add query options)
- `web/src/server/directory-completions.ts` (new TanStack Start server fn)

## Specs
- `specs/01-investigation/` — this investigation (done)
- `specs/02-backend-api/` — directory completions endpoint
- `specs/03-frontend-picker/` — PathPicker component + MessageInput integration
