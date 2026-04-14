# Blackboard

A shared SQLite database (`~/.flitterbot/blackboard.db`) providing a real-time, queryable view of all Flitterbot state — sessions, task assignments, pending messages, and user decisions. It serves as the single source of truth consumed by the orchestrator, cron, WhatsApp daemon, web app, and hooks, replacing duplicated per-consumer tmux/transcript parsing.
