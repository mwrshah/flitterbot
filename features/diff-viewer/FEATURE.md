# Diff Viewer

Show the git diff of a stream's worktree against main, rendered in the web UI on demand.

## Behavior

- Site banner already shows the active worktree and stream status (top-right, `justify-between gap-1`)
- Add a depressable "Diff" button next to the stream status
- Button is *enabled* only when the stream has a `worktree_path` set
- On click: fetch `git diff main` from the worktree directory, render it in an expandable panel (overlay/drawer below the banner)
- On second click (or close): collapse the panel

## Architecture

```
[Click "Diff"] → GET /api/streams/:id/diff → backend runs `git diff main` in worktree_path → returns unified diff string → frontend renders with diff2html
```

### Backend
- New endpoint: `GET /api/streams/:id/diff`
- Reads `worktree_path` from the stream record
- Runs `git diff main` (or `git diff main...HEAD`) in that directory
- Returns raw unified diff text (plain text response, not JSON)
- If no worktree or empty diff, return 204

### Frontend
- diff2html renders the raw string to HTML in one call
- No client-side diffing — git does all the work
- Inject the HTML into a collapsible panel

```ts
import { html } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';

const rendered = html(diffString, {
  outputFormat: 'side-by-side',
  drawFileList: true,
  matching: 'lines',
  highlight: true,
  colorScheme: 'dark',
});
```

## Library Choice: diff2html

We use `git diff` output directly — no client-side diffing needed. diff2html is purpose-built for rendering unified diff format to HTML.

- ~30kb gzipped (base bundle)
- One function call: `parse` + `html`
- Side-by-side + unified + synchronized scroll
- Syntax highlighting via highlight.js (pluggable, can use slim/base bundle)
- 3.3k ⭐, 7k dependents, 87 releases, last release Jan 2026

### Why not the others
- **@git-diff-view/react** (672 ⭐) — more powerful but builds internal DiffFile data structures client-side. Overkill when we already have the diff string.
- **react-diff-viewer-continued** (354k/wk npm) — computes diffs client-side from two strings. Wrong tool — we already have the diff.
- **Monaco** — 2MB bundle. No.

## Sources

- https://github.com/rtfpessoa/diff2html
- https://github.com/MrWangJustToDo/git-diff-view
- https://www.npmjs.com/package/react-diff-viewer-continued
