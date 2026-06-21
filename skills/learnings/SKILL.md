---
name: learnings
description: Save a learning to the running learnings note, classified under a 2-char situation code
argument-hint: "<the learning to capture>"
---

# Learnings

Recording learnings in the Markdown document configured at `learningsNotePath` in `~/.flitterbot/config.json`.

When asked to synthesize a learning, understand that the idea is to encapsulate information about what the user wanted in a particular past situation or in the past context. 
- Delineate what was the situation, in which the learning is applicable.
- Write the body of the learning. When writing a body note that we want:
    - insight into what the user wanted, or a pattern the user likes/wants the AI to follow, as this information lets us learn about the user
    - the best way to capture the learning is to reword the user request as an instruction. Make it forward facing and positive, positioned as the way to do things. Tone should be positive, tight, succinct, clear, and not overly prescriptive.
 
Each item carries a 2-char *situation code* in front (e.g. `LB-`). The code is the grouping key — items sharing a code stay visually together even when the trailing situation wording drifts. The list auto-regroups after every add.

## Format

```
- {code}-{situation}: {body}
```

## Supporting Files

- [scripts/learnings.py](scripts/learnings.py) — CLI entry point for writes (subcommands: `codes`, `add`). Reads `learningsNotePath` from `~/.flitterbot/config.json`.
- [scripts/recall.py](scripts/recall.py) — read-side helper (subcommands: `list`, `show CC`) for deep-diving an existing code before deciding to add. Reads `learningsNotePath` from `~/.flitterbot/config.json`.

## Routing: read the user instruction first

- *Custom objective*: when the user asks for something other than "capture this learning" use your judgement to satisfy that objective. You are not bound to the steps below.
- *Default workflow*: when the user hands you a fresh learning to record (or gives no special instruction), follow Steps 1–5 below in sequence.

## Steps

Let `$SKILL_DIR` be the directory the skill loader's "References are relative to ..." line points at.

1. *Survey existing codes* so you can classify the new learning against what's already catalogued:
   ```bash
   python3 $SKILL_DIR/scripts/learnings.py codes
   ```
   Output groups every code with its unique situation labels — read it to spot a code that already covers this situation.

2. *Classify*. Match semantically — same situation even with different wording reuses the same code. Code by the triggering situation (e.g. "doing a PR review"), not by sub-aspect within it — setup mechanics, output discipline, and recovery patterns for the same situation all share one code. Otherwise it's a new situation.

3. *Deep-dive the matched code* (only when reusing an existing code) so you can judge uniqueness against what's already there:
   ```bash
   python3 $SKILL_DIR/scripts/recall.py show CC
   ```

4. *Escape clause*: if the candidate learning duplicates or trivially restates an existing entry under that code, skip — don't record. Report what it overlapped with and stop.

5. *Compose* the situation label + body. Keep both short and faithful to the user's intent.

6. *Append*:
   - *Reuse an existing code* — pass the explicit prefix:
     ```bash
     python3 $SKILL_DIR/scripts/learnings.py add "CC-situation: body"
     ```
   - *New situation* — pass `--new` and the script mints a fresh code internally:
     ```bash
     python3 $SKILL_DIR/scripts/learnings.py add --new "situation: body"
     ```

7. *(Conditionally) Wire up the new code in the Flitterbot agent catalog* (only when step 6 used `--new`). The script prints the freshly-minted 2-char code — it now needs a one-line registration inside the `must-fetch-user-preferences` rule of `~/.flitterbot/control-surface/agent/AGENTS.md`. Use the installed recall script path in that entry: `python3 ~/.flitterbot/skills/learnings/scripts/recall.py show CC`.

8. *Report* the line added and whether it joined an existing group or started a new one. The script prints this for the learnings note directly; if step 7 ran, also mention the catalog entry that was wired up.

---
