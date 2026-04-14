# Flitterbot Web App

TanStack Start thin client for the Flitterbot control surface.

## Base starter

This app is based on the official TanStack example pattern from:
- `TanStack/router`
- example: `examples/react/start-basic-react-query`

## Features

- TanStack Start document + route shell
- React Query for HTTP-backed UI state
- WebSocket chat stream to `/ws`
- Session list/detail pages
- Paginated transcript preview
- Direct Claude session messaging
- WhatsApp runtime controls
- Stub fallback when the control surface is unavailable

## Run

```bash
pnpm install
pnpm --dir web dev
```

Open `http://127.0.0.1:3188`.

## Notes

- Configure the control-surface base URL and bearer token in the UI header.
- GET routes work against localhost without browser auth state.
- Mutating calls use the configured bearer token.
- Stub mode remains available while backend routes are still landing.
