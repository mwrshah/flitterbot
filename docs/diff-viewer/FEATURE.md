# Diff Viewer

Show a stream worktree's current git changes against its recorded base branch in the web UI on demand.

## Behavior

- The session side panel provides Info and Diff views.
- Diff is enabled only when the stream has a `worktree_path`.
- Opening Diff fetches the current worktree changes. Selecting Diff again reloads them.
- The viewer includes tracked changes and untracked files that Git does not ignore.
- When the worktree root contains `.ignore`, the viewer omits every non-comment, non-blank path listed in that file. The exclusions apply to tracked and untracked changes.
- An empty result shows that the worktree has no visible changes against its base branch.
- A result larger than 10,000 changed lines shows a stat summary instead of the full diff.

## Architecture

```text
Diff view
  → GET /api/pi-sessions/:id/diff
  → resolve the session's stream and worktree
  → find merge-base(base_branch, HEAD)
  → apply .ignore exclusions while collecting tracked and untracked changes
  → return JSON diff or summary
  → render with react-diff-view
```

### Backend

- `GET /api/pi-sessions/:id/diff` resolves `worktree_path` and `base_branch` from the stream linked to the Pi session.
- The base branch defaults to `main` only when the stream has no recorded base branch.
- Git compares the worktree with the merge base of the base branch and `HEAD`.
- The route copies the real Git index to a temporary index and intent-adds visible untracked files. This makes untracked content appear in the diff without changing the worktree's index.
- If `.ignore` exists at the worktree root, the route removes comments and blank lines, converts each remaining entry to a Git exclusion pathspec, and applies the same pathspec set to untracked-file discovery, diff stats, and the full diff.
- The route returns `{ mode: "diff", diff }` for a full unified diff.
- When insertions plus deletions exceed 10,000, it returns `{ mode: "summary", stat, files, insertions, deletions }`.
- A missing worktree or empty visible diff returns HTTP 204.

### Frontend

- TanStack Query fetches the diff only while the Diff view is open and the stream has a worktree.
- `react-diff-view` parses the unified diff and renders each file in a unified view.
- The panel shows loading, failure, empty, summary, and full-diff states.

## Rendering Library

`react-diff-view` consumes Git's unified diff output directly and provides the file, hunk, and line components used by the panel. Git remains the source of all change detection and filtering.

## Source

- https://github.com/otakustay/react-diff-view
