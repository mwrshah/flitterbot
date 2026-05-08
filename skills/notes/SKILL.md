---
name: notes
description: Read and maintain local notes stored under ~/.flitterbot/notes
argument-hint: "[note request]"
disable-model-invocation: false
---

# Notes

Use the local notes folder as the default durable memory for user-authored notes and reusable context.

## Location

- Root: `~/.flitterbot/notes/`
- Create Markdown files directly under this root unless a subfolder already fits the topic.
- Prefer stable, lowercase, dash-separated filenames: `project-name.md`, `idea-name.md`, `meeting-topic.md`.

Create the notes root when needed. Keep files plain Markdown so the user can edit them directly.

## Workflow

1. Search notes before answering from memory.
2. Read matching notes fully before relying on them.
3. When adding a note, preserve existing structure and append under a clear heading.
4. When creating a note, start with a short title and a concise summary.
5. Treat notes as user-owned memory: update them when asked, and mention the changed path.

## Response Style

Give the answer first, then cite the note path when a note shaped the answer or was changed.
