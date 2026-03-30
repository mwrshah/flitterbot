# Spec: Directory Completions Backend API

## Functional Requirements

1. **FR1**: `GET /api/directory-completions` accepts `path` (partial path string) and optional `piSessionId` query params
2. **FR2**: Resolves the base CWD from the default Pi session's CWD (or the specified Pi session). Falls back to the process CWD if no Pi session is active.
3. **FR3**: Splits the `path` param into a directory prefix and a filename filter suffix. E.g., `src/ro` → dir=`src/`, filter=`ro`
4. **FR4**: Reads the resolved directory with `node:fs/promises.readdir` with `withFileTypes: true`
5. **FR5**: Filters entries by case-insensitive prefix match on the filter suffix. Excludes hidden entries (starting with `.`) and `node_modules` by default.
6. **FR6**: Returns max 15 entries, sorted: directories first (alphabetical), then files (alphabetical)
7. **FR7**: Each item in the response has `{ name: string, kind: "directory" | "file", path: string }` where `path` is relative to CWD
8. **FR8**: Response shape: `{ items: DirectoryCompletionItem[], cwd: string }`
9. **FR9**: Returns 200 with empty items array if the directory doesn't exist or can't be read (graceful degradation, not 500)
10. **FR10**: Security: the resolved path must be within the CWD (no `../` traversal above CWD). Normalize with `path.resolve` and check `startsWith(cwd)`.

## Technical Approach

- New file `src/routes/browser-directory-completions.ts` following the pattern of `browser-skills.ts`
- Register in `src/server.ts` matching pattern: `GET /api/directory-completions`
- Add endpoint to `CONTROL_SURFACE_ENDPOINTS` in `src/contracts/control-surface-api.ts`
- Add types `DirectoryCompletionItem` and `DirectoryCompletionsResponse` to contracts
- Export from `src/routes/index.ts`

## Consequential Interfaces

```typescript
interface DirectoryCompletionItem {
  name: string;
  kind: "directory" | "file";
  path: string;  // relative to CWD, e.g. "src/routes/"
}

interface DirectoryCompletionsResponse {
  items: DirectoryCompletionItem[];
  cwd: string;
}
```
