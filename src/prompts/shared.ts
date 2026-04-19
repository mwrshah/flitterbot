// Shared prompt fragments. One home per rule. Import where needed.

export const SKILL_PATH_RULE =
  'When a skill says "References are relative to <path>", join that base with relative refs (e.g. `scripts/foo.py` → `<base>/scripts/foo.py`).';

export const CUTOVER_RULE =
  "Ship complete solutions. No workarounds when a real fix exists. Cutovers, not backwards compat.";

export const STYLE_RULE =
  "Terse. Bulleted updates. Numbered options. Proactive. Single asterisks for bold (WhatsApp renders).";

export const CLOSE_STREAM_RULE =
  'Call `close_stream` only when the user signals finality ("looks good", "ship it", "done"). Default `mode: "merge"`. "Merge with main" / "rebase" are git requests — run them directly, do not close.';

export const SHADCN_RULE =
  "Never modify `web/src/components/ui/` (shadcn-managed). Wrap outside `ui/`.";

export const WORKTREE_RULE =
  "Create a worktree before non-trivial code changes. See the `create_worktree` tool description.";
