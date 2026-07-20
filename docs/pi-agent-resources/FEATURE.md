# Pi Agent Resources

## Problem

Flitterbot uses Pi's shared `~/.agents` directory as the canonical agent resource root while keeping its always-loaded memory index separate from user and project instructions.

## Architecture

- `~/.agents` is Pi's `agentDir`. Pi natively discovers global instructions, append-system content, skills, extensions, prompts, and themes there.
- `~/.pi/agent/auth.json` and `~/.pi/agent/models.json` are the only credential and custom-model paths.
- `~/.flitterbot/data/MEMORY.md` is Flitterbot's required, always-loaded recall index. The installer seeds it without overwriting user edits.
- `learningsNotePath` independently identifies the complete lazy-loaded learnings document.
- The inline Flitterbot extension registers custom tools and contributes non-native skill paths.

## Pseudocode Contracts and Call Graph

```ts
type FlitterbotConfig = {
  piAgentDir: "~/.agents";
  memoryPath: "~/.flitterbot/data/MEMORY.md";
  learningsNotePath: string;
};

appendSystemPromptOverride(baseAppendSystemPrompts) = [
  rolePrompt,
  memory,
  ...baseAppendSystemPrompts,
];
```

Prompt order:

```text
Pi base or ~/.agents/SYSTEM.md
  → role prompt
  → ~/.flitterbot/data/MEMORY.md
  → ~/.agents/APPEND_SYSTEM.md
  → global and project AGENTS.md/CLAUDE.md context
  → skills
  → date and cwd
```

Production:

```text
PiSessionManager
  → createFlitterbotAgent
    → createAgentSessionRuntime
      → runtime factory
        → read MEMORY.md
        → createAgentSessionServices(agentDir = ~/.agents)
          → Pi resource discovery
          → inline Flitterbot extension
            → register custom tools
            → contribute additional skill paths
        → createAgentSessionFromServices
    → bind extensions
```

Session replacement:

```text
AgentSessionRuntime.newSession/switchSession
  → runtime factory
    → reread MEMORY.md
    → recreate session and resources
  → runtime rebind callback
    → bind extensions
```

## Files

- `src/config/load-config.ts` — defines the Pi agent directory and memory path.
- `src/pi-auth.ts` — uses the canonical Pi auth and model paths.
- `src/streams/create-agent.ts` — composes prompt resources and owns session lifecycle infrastructure.
- `src/streams/flitterbot-extension.ts` — registers Flitterbot tools and extra skill paths.
- `src/streams/pi-session-manager.ts` — records the active Pi agent directory.
- `src/runtime.ts` — passes canonical Pi tool definitions.
- `installer/data/MEMORY.md` — seeds the editable memory index.
- `installer/install.mjs` — installs memory without overwriting it.
- `skills/learnings/SKILL.md` — directs new recall-code catalog entries to memory.
