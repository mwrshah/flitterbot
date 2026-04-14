# Name Migration Playbook

How to rename this project (product brand + directory names + installed home) end-to-end without losing data or breaking the 80+ active worktrees. Written from the `autonoma → flitterbot` rename on 2026-04-14.

Everywhere below, `OLD` = the old name (e.g. `autonoma`), `NEW` = the new name (e.g. `flitterbot`). Do a dry run on a backup first.

---

## 0. Inventory — know what you're touching

Before you change anything, list every surface the name appears on. Miss one and you'll chase ghosts for a week.

1. **Repo content** — `rg -i OLD` across the repo (excluding `node_modules`, `throwaway`, `.git`). Expect hits in `package.json`, `install.mjs`, `uninstall.mjs`, `src/`, `web/`, env vars (`VITE_OLD_*`), image assets (`OLD_logo_*.png`), plist/systemd unit names, docs.
2. **Repo directory names** — `.OLD/` config tree, `OLD.db` stale files at root, any `OLD-*` named files.
3. **Working dirs on the machine**
   - `~/development/OLD` (main repo)
   - `~/development/OLD-worktrees/` (80+ git worktrees)
   - `~/.OLD/` (installed home dir: `blackboard.db`, `config.json`, `whatsapp/auth`, etc.)
4. **SQLite databases** — inventory every table and JSON-ish field likely to contain paths: `sessions.cwd`, `streams.repo_path`, `pi_sessions.cwd/agent_dir/session_file`, `messages.content/metadata`, `whatsapp_messages.body`, `sessions.transcript_path`, `sessions.project/project_label`.
5. **External state** — `~/.claude/projects/-home-mas-development-OLD*` (221 dirs), `~/.claude/settings.json` hooks, GitHub remote URL, scheduler plist/systemd unit names, tmux session names, alacritty `--working-directory` args in live windows.
6. **Live processes** — `pgrep -af 'OLD|control-surface'`. Note which hold DB files open (`fuser ~/.OLD/blackboard.db`).

Write these down. You'll reference the list when verifying each phase.

---

## 1. Freeze — stop everything that writes

Nothing you rename should be held open. Anything in the migration blast radius must be stopped or explicitly left alone.

1. **Commit or abort in-flight git operations** — rebases, merges, interactive commits. A rebase-merge dir inside `.git/worktrees/*/rebase-merge/` will break when the parent repo moves.
2. **Kill long-running daemons** — control-surface, whatsapp daemons, vite dev server, esbuild workers, anything tailing logs. SIGTERM first, SIGKILL only if needed.
3. **Verify DB is released** — `fuser ~/.OLD/blackboard.db` must return nothing. `.db-wal` and `.db-shm` should auto-cleanup when sqlite checkpoints on close.
4. **Leave orphan editor sessions alone** — if `nvim` has `COMMIT_EDITMSG` open for a worktree that no longer exists, kill only when the user confirms. Never touch open editors silently.
5. **Accept collateral damage** — `tail -f ~/.OLD/logs/...` processes and alacritty terminals with stale `--working-directory` cmdlines are fine to leave; they won't block the rename, the user closes them later.

---

## 2. Back everything up

Cheap insurance. All reversible later.

```bash
cp -a ~/.OLD ~/.OLD.bak-$(date +%s)
cp ~/.OLD/blackboard.db ~/.OLD/blackboard.db.bak-$(date +%s)
cp ~/.claude/settings.json ~/.claude/settings.json.bak-OLD-cleanup
```

Do NOT back up `~/development/OLD` — too large and git already is the backup.

---

## 3. Content rebrand in the repo

Should usually be done *before* the directory rename so file contents are self-consistent when the rename lands.

1. **Branch** — `NNN-rename-OLD-to-NEW`. Use your repo's numbering convention.
2. **File-content pass** — `package.json` name, `install.mjs`/`uninstall.mjs` constants (`OLD_DIR`, `HOME/.OLD`, plist/service names), `src/` strings, `web/` env vars (`VITE_OLD_* → VITE_NEW_*`), image asset filenames, docs. For feature-docs protected by `CLAUDE.md` rules, treat a brand rename as explicit permission for the brand word only — don't rewrite prose.
3. **Directory rename in git** — `git mv .OLD .NEW` (parent-only; contents are already rebranded).
4. **Stale artifacts** — delete `OLD.db` / `blackboard.db` zero-byte leftovers in repo root (gitignored, so untracked). Remove any `__pycache__/` that snuck in, add `__pycache__/` to `.gitignore`.
5. **Commit.**

Keep this branch unpushed until the rest of the playbook succeeds.

---

## 4. Rename `~/.OLD` → `~/.NEW`

```bash
mv ~/.OLD ~/.NEW
```

Then rewrite every path reference inside `~/.NEW/`:

1. **`config.json`** — JSON-aware rewrite of `blackboardPath`, `whatsappAuthDir`, `whatsappSocketPath`, `whatsappPidPath`, `whatsappCliPath`, `whatsappDaemonPath`, `projectRoot`, `sourceRoot`, `controlSurfaceCommand`. Use python `json.loads → rewrite → json.dumps`, not sed — preserves structure and quoting.
2. **`manifest.json`** — drop the stale `~/.OLD` entry from `targets`; keep `~/.NEW`, `~/.claude/settings.json`, `web/.env`. If you skip this, the installer will treat both as managed.
3. **`bin/OLD-up`, `bin/OLD-wa`** — if still present after the rename, delete them. The new `install.mjs` will write `NEW-up`/`NEW-wa`.
4. **`source-root`** — a single-line file, update by hand.
5. **Skip `control-surface/sessions/*.jsonl`** unless it matters — see §6.

---

## 5. SQLite migration

The actual meat. Work on a closed DB (services stopped in §1).

### 5.1 Map what columns contain paths

```sql
-- columns likely to hold paths/brand refs
sessions.cwd, sessions.transcript_path, sessions.project, sessions.project_label, sessions.task_description
streams.repo_path, streams.worktree_path
pi_sessions.cwd, pi_sessions.agent_dir, pi_sessions.session_file
messages.content, messages.metadata
whatsapp_messages.body
```

### 5.2 Rewrite order matters

Always do the **longest match first** so a general rule doesn't eat part of a specific one:

1. `/home/mas/development/OLD-worktrees` → `/home/mas/development/NEW-worktrees`
2. `/home/mas/development/OLD` → `/home/mas/development/NEW`
3. `/home/mas/.OLD` → `/home/mas/.NEW`
4. `~/development/OLD-worktrees` → `~/development/NEW-worktrees` (chat text often uses `~`)
5. `~/development/OLD` → `~/development/NEW`
6. `~/.OLD` → `~/.NEW`
7. `.OLD/` → `.NEW/` (catches `.autonoma/cron/...` references in text)
8. `OLD` → `NEW` (lowercased brand, last resort — careful)
9. `Autonoma` → `Flitterbot` / `AUTONOMA` → `FLITTERBOT` (sqlite `replace()` is case-sensitive)

### 5.3 Sample transaction

```sql
BEGIN;

-- path columns (same pattern for every path column)
UPDATE sessions SET cwd = replace(cwd, '/home/mas/development/OLD-worktrees', '/home/mas/development/NEW-worktrees') WHERE cwd LIKE '%/development/OLD-worktrees%';
UPDATE sessions SET cwd = replace(cwd, '/home/mas/development/OLD', '/home/mas/development/NEW')                 WHERE cwd LIKE '%/development/OLD%';

-- free-text columns: broader sweep
UPDATE messages SET content = replace(content, 'OLD-worktrees', 'NEW-worktrees') WHERE content LIKE '%OLD-worktrees%';
UPDATE messages SET content = replace(content, '.OLD',          '.NEW')           WHERE content LIKE '%.OLD%';
UPDATE messages SET content = replace(content, 'OLD',           'NEW')            WHERE content LIKE '%OLD%';
UPDATE messages SET content = replace(content, 'Autonoma',      'Flitterbot')     WHERE content LIKE '%Autonoma%';

-- repeat for messages.metadata, whatsapp_messages.body, sessions.task_description, ...

COMMIT;
```

Wrap the whole thing in `BEGIN;` / `COMMIT;` so a typo rolls back the entire DB.

### 5.4 What to NOT rewrite

- **Stream names** — `rename-OLD-to-NEW`, `brainstorm-pretext-OLD` are historic identifiers chosen at the time. Rewriting produces nonsense like `rename-NEW-to-NEW`. Leave them.
- **Historical branch/worktree names inside `sessions.cwd` or `sessions.project`** — e.g. `001-OLD-biome-lint-fix`. The branch doesn't exist anymore; the row is a historical marker. Leave.
- **Chat transcript bodies containing historical shell output** — `github.com:owner/OLD.git` in a `git push` output, `[OLD]` tmux project labels, `AUTONOMA_HOME` env var mentions. These are frozen-in-time artifacts; rewriting tampers with chat history.
- **`schema_migrations`, `user_config`, `health_flags`, `pending_actions`, `message_id_map`** — usually don't contain paths. Verify with `.dump | grep -c OLD`; skip if zero.

### 5.5 Verify

```bash
for t in sessions streams pi_sessions messages whatsapp_messages; do
  hits=$(sqlite3 ~/.NEW/blackboard.db ".dump $t" | grep -ic 'OLD')
  echo "$t: $hits remaining"
done
sqlite3 ~/.NEW/blackboard.db "PRAGMA integrity_check"
```

Remaining hits should be only the intentional non-rewrites from §5.4. Row counts must match pre-migration counts.

---

## 6. Control-surface session JSONL files

These are append-only agent transcripts under `~/.NEW/control-surface/sessions/*.jsonl`. Two separate concerns:

### 6.1 Path rewrites inside the files

The agent may resume sessions by reading them, so live path strings must point at the new location. Do a targeted `sed -i` pass for path prefixes only — do NOT rewrite the bare word `OLD`:

```bash
cd ~/.NEW/control-surface/sessions
grep -l OLD *.jsonl > /tmp/hits.txt
while IFS= read -r f; do
  sed -i \
    -e 's|/home/mas/development/OLD-worktrees|/home/mas/development/NEW-worktrees|g' \
    -e 's|/home/mas/development/OLD|/home/mas/development/NEW|g' \
    -e 's|/home/mas/\.OLD|/home/mas/.NEW|g' \
    -e 's|~/development/OLD-worktrees|~/development/NEW-worktrees|g' \
    -e 's|~/development/OLD|~/development/NEW|g' \
    -e 's|~/\.OLD|~/.NEW|g' \
    -- "./$f"
done < /tmp/hits.txt
```

Residual matches will be historical branch names, tmux labels, and old `github.com/owner/OLD.git` strings inside transcript text — all safe to leave.

### 6.2 Reconciling rows vs files

Two classes of drift you'll find:

- **Broken DB refs** — `pi_sessions.session_file` and `sessions.transcript_path` pointing at files that no longer exist. Fix: NULL the column (preserves row metadata), don't delete the row.

  ```python
  # per row: if not os.path.isfile(path): UPDATE … SET col = NULL
  ```

- **Orphan files on disk** — JSONL files with no DB row. Move to a trash dir, don't `rm`:

  ```bash
  mkdir -p ~/.NEW/control-surface/sessions-orphan-trash-$(date +%s)
  # move every *.jsonl whose basename isn't in (SELECT basename(session_file) FROM pi_sessions)
  ```

After both passes, the sessions dir file count should equal `SELECT COUNT(*) FROM pi_sessions WHERE session_file IS NOT NULL`.

---

## 7. Rename the development directories

Order matters: worktrees before main, so `git worktree repair` can find both halves.

```bash
mv ~/development/OLD-worktrees ~/development/NEW-worktrees
mv ~/development/OLD            ~/development/NEW
cd ~/development/NEW
git worktree repair ~/development/NEW-worktrees/*
git worktree list    # expect 0 "prunable"
```

`git worktree repair` fixes both halves of the link: the `.git/worktrees/<name>/gitdir` files in the main repo AND the `.git` symlink files in each worktree directory.

**Claude Code project folders** at `~/.claude/projects/-home-mas-development-OLD*` — 221 dirs to rename. Use `mv -- "./$old" "./$new"` (the `--` is mandatory: the dir names start with `-home-...` which `mv` otherwise parses as options). Expect collisions if Claude Code already created a new-path dir on the side — merge with `rsync -a OLD/ NEW/ && rm -rf OLD`.

---

## 8. GitHub remote

The user renames the GitHub repo (`gh repo rename NEW`, or via web UI). Then:

```bash
git -C ~/development/NEW remote set-url origin git@github.com:<owner>/NEW.git
```

All 80+ worktrees share the main repo's config, so this one command fixes all of them. The old GitHub URL keeps redirecting for a while, but fix the remote immediately to avoid confusion.

---

## 9. Re-run install.mjs

```bash
node ~/development/NEW/.NEW/install.mjs
# answer y to each diff prompt
```

Two gotchas:

1. **Hook duplication in `~/.claude/settings.json`** — the installer appends new hook groups but doesn't know about the old `~/.OLD/hooks/...` entries. You'll end up with both. Strip the old entries with a JSON-aware pass:

   ```python
   # drop any hook group whose command contains '.OLD/'
   ```

2. **`yes |` trick is fragile** — the installer has multiple prompts across phases. If `yes` closes early, some prompts get skipped. Either answer interactively or pipe `printf 'y\ny\ny\ny\n'` with enough lines.

---

## 10. Verify end state

```bash
# dirs
ls -ld ~/development/NEW ~/development/NEW-worktrees ~/.NEW

# git
git -C ~/development/NEW remote -v              # origin points at NEW
git -C ~/development/NEW worktree list | wc -l  # matches pre-rename count
git -C ~/development/NEW worktree list | grep -c prunable  # 0

# sqlite
sqlite3 ~/.NEW/blackboard.db "PRAGMA integrity_check"
sqlite3 ~/.NEW/blackboard.db "SELECT COUNT(*) FROM sessions, streams, messages, pi_sessions, whatsapp_messages"

# config
grep -c OLD       ~/.claude/settings.json  # 0
grep -c NEW       ~/.claude/settings.json  # matches hook count

# leftover refs in repo tree
rg -i OLD ~/development/NEW --glob '!node_modules' --glob '!throwaway'

# orphan claude project dirs
ls ~/.claude/projects/ | grep -c OLD   # 0
```

**Don't auto-push.** Let the user review commits and push when ready.

---

## 11. What breaks for the user after

Tell them explicitly, otherwise they'll hit these silently:

- **Open terminals** still report `~/development/OLD` as cwd. They need `cd ~/development/NEW` or to reopen.
- **tmux sessions** named after the old project show stale paths in their prompt.
- **`tail -f` on old log path** is now following a deleted file — Ctrl-C it.
- **Any running `.NEW-up` / `.NEW-wa` binaries** need to be restarted by the user; the installer installs them but doesn't start them.
- **The old `~/.OLD.bak-*` backup** is disposable once you've confirmed the new state works (probably a day or two).
- **Backup tables / trash dirs** (`_rename_backup_session_file_fix`, `sessions-orphan-trash-*`) can be dropped once stable.

---

## Appendix A: Ordered command cheat-sheet

Minimal version, no prose. Copy/paste ready after setting `OLD`/`NEW`.

```bash
OLD=autonoma
NEW=flitterbot

# 1. Freeze
pgrep -af "$OLD|control-surface"
kill <pids>
fuser ~/.$OLD/blackboard.db   # must be empty

# 2. Backup
cp -a ~/.$OLD ~/.$OLD.bak-$(date +%s)
cp ~/.$OLD/blackboard.db ~/.$OLD/blackboard.db.bak-$(date +%s)
cp ~/.claude/settings.json ~/.claude/settings.json.bak-$OLD-cleanup

# 3. Content rebrand in repo (branch NNN-rename-$OLD-to-$NEW)
git mv ".$OLD" ".$NEW"
# update docs, commit

# 4. Home dir
mv ~/.$OLD ~/.$NEW
# rewrite config.json & manifest.json paths, drop stale bin/$OLD-*

# 5. SQLite (see §5.3 for full transaction)
sqlite3 ~/.$NEW/blackboard.db < rewrite.sql

# 6. Session JSONLs
cd ~/.$NEW/control-surface/sessions && grep -l $OLD *.jsonl | xargs sed -i -e 's|.../$OLD|.../$NEW|g' ...
# NULL broken refs, trash orphan files

# 7. Dev dirs
mv ~/development/$OLD-worktrees ~/development/$NEW-worktrees
mv ~/development/$OLD            ~/development/$NEW
cd ~/development/$NEW && git worktree repair ~/development/$NEW-worktrees/*

# ~/.claude/projects/
cd ~/.claude/projects && for d in *$OLD*; do mv -- "./$d" "./${d//$OLD/$NEW}"; done

# 8. GH remote
git remote set-url origin git@github.com:<owner>/$NEW.git

# 9. Re-install
node ~/development/$NEW/.$NEW/install.mjs
# strip old $OLD hook entries from ~/.claude/settings.json

# 10. Verify (see §10 block)
```
