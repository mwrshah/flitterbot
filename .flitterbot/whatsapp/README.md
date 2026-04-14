# Flitterbot WhatsApp runtime

Installer-owned runtime directory for the WhatsApp transport daemon.

Expected layout after install:

- `auth/` — Baileys auth state (chmod 700)
- `logs/daemon.log` — daemon logs
- `config.json` — local recipient/runtime config bootstrap
- `cli.js` — installed CLI wrapper
- `daemon.js` — installed daemon wrapper
- `~/.flitterbot/bin/flitterbot-wa` — terminal command wrapper

The control surface owns daemon lifecycle in v1.
Manual auth remains terminal-driven: `flitterbot-wa auth`.
