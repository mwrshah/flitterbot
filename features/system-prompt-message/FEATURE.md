# System Prompt Message

## Problem

The chat panel shows session turns but hides the system prompt that defines the active agent.

## Goals

- Show the active session system prompt at the top of the chat history once the oldest page is loaded.
- Render it with the existing user-message presentation.
- Keep it outside the persisted and editable session timeline.
- Preserve the reader's position when the prompt arrives through upward pagination.

## Architecture

The oldest streams history response includes the active Pi session's current system prompt. A short conversation includes it in the initial page; a longer conversation returns it only after upward pagination reaches the beginning. The web chat adapter prepends a display-only user message before it converts timeline rows for the Pi Web UI. The virtual list performs initial bottom positioning once, then uses stable row keys to anchor later prepends.

## Pseudocode Contracts and Call Graph

```ts
interface StreamsHistoryResponse {
  systemPrompt?: string
  items: ChatTimelineItem[]
}

GET /api/streams/history
  → managed Pi session
    → runtime.session.systemPrompt
      → StreamsHistoryResponse
        → useStreamsChat
          → ChatPanel
            → useAgentMessages
              → display-only user message + timeline messages
```

A page with older rows omits `systemPrompt`. A session without an active runtime also omits it. The chat history continues to render without a synthetic message.

## Component Tree

```text
<PiSessionRoute>                         [owns streams history query result]
└── <ChatPanel systemPrompt timeline>    [passes display data to adapter]
    └── <StreamsMessageList messages>    [renders the prompt as the first user-message row]
```

The prompt message has a stable row key and no session entry ID, so users can copy it but cannot prune or fork from it.

## Files

- `src/contracts/control-surface-api.ts` — modify: expose the optional system prompt in history responses.
- `src/routes/browser-streams.ts` — modify: read the prompt from the active Pi runtime.
- `web/src/hooks/use-streams-chat.ts` — modify: derive the prompt from paginated history data.
- `web/src/routes/streams.$piSessionId.tsx` — modify: pass the prompt into the chat panel.
- `web/src/components/chat-panel.tsx` — modify: include the prompt in message adaptation.
- `web/src/hooks/use-agent-messages.ts` — modify: memoize prompt-aware conversion.
- `web/src/lib/pi-web-ui-bridge.ts` — modify: prepend the display-only user-style message.
- `web/src/components/streams-message-list.tsx` — modify: complete initial bottom positioning once before enabling upward pagination.
