# Agent Resources and Provider Authentication

## Problem

Flitterbot operates as a standalone product while using the Pi SDK as a library. Users configure model providers in Flitterbot without installing or launching the Pi CLI/TUI, and all product-owned model state stays under `~/.flitterbot`.

## Architecture

- `~/.agents` is the agent resource root passed to the Pi SDK. It contains global instructions, append-system content, skills, extensions, prompts, and themes.
- `~/.flitterbot/control-surface/agent` has `0700` permissions; its `auth.json` stores provider API keys and OAuth credentials through locked `0600` SDK storage.
- `~/.flitterbot/control-surface/agent/models.json` stores custom provider and model definitions.
- `~/.flitterbot/control-surface/agent/models-store.json` caches dynamically refreshed provider catalogs for offline use.
- `~/.flitterbot/data/MEMORY.md` is Flitterbot's required, always-loaded recall index. The installer seeds it without overwriting user edits.
- `learningsNotePath` independently identifies the complete lazy-loaded learnings document.
- The web settings UI drives the SDK's provider-owned API-key and OAuth login flows through bearer-authenticated control-surface routes.
- Auth prompts and provider events contain no stored secrets. Secret responses travel once to the backend and are removed from browser state after submission.

## Pseudocode Contracts and Call Graph

```ts
type FlitterbotConfig = {
  piAgentDir: "~/.agents";
  controlSurfaceAgentDir: "~/.flitterbot/control-surface/agent";
  memoryPath: "~/.flitterbot/data/MEMORY.md";
  learningsNotePath: string;
};

type AuthProvider = {
  id: string;
  name: string;
  methods: Array<{ type: "oauth" | "api_key"; name: string; loginLabel?: string }>;
  credentialType?: "oauth" | "api_key";
};

type AuthFlowSnapshot = {
  id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  providerId: string;
  authType: "oauth" | "api_key";
  events: AuthEvent[];
  prompt?: AuthPrompt;
  error?: string;
};

createPiModelRuntime(controlSurfaceAgentDir) = ModelRuntime.create({
  authPath: `${controlSurfaceAgentDir}/auth.json`,
  modelsPath: `${controlSurfaceAgentDir}/models.json`,
  modelsStorePath: `${controlSurfaceAgentDir}/models-store.json`,
});
```

Production authentication:

```text
Settings → Accounts & Model providers
  → GET /api/auth/providers
    → ProviderAuthManager.listProviders
      → ModelRuntime providers + non-secret credential metadata
  → POST /api/auth/login
    → ProviderAuthManager.startLogin
      → ModelRuntime.login(provider, method, AuthInteraction)
        → provider-owned OAuth/API-key implementation
        → auth prompt/event snapshots exposed through /api/auth/flows/:id
        → SDK locked write to auth.json
  → DELETE /api/auth/providers/:provider
    → ModelRuntime.logout
      → SDK locked credential removal
```

Production sessions and catalogs:

```text
ControlSurfaceRuntime.start
  → ModelRuntime.create(allowModelNetwork = true)
    → restore models-store.json
    → refresh stale dynamic provider catalogs

PiSessionManager
  → createFlitterbotAgent
    → createAgentSessionServices(agentDir = ~/.agents, modelRuntime)
      → agent resource discovery
      → credentials and models from control-surface/agent
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

## Component Tree

```text
<SettingsDrawer>
  └── <AuthProvidersSection>
      ├── provider query and login/logout mutations
      ├── <ProviderRow>
      │   ├── stored credential status
      │   ├── OAuth/API-key actions
      │   └── logout confirmation
      └── <AuthFlowDialog>
          ├── short-lived flow polling while running
          ├── OAuth URL, device code, info, and progress events
          ├── text/secret/manual-code prompt form
          └── select prompt actions
```

## Files

- `src/config/load-config.ts` — defines and creates the agent resource, model state, and memory directories.
- `src/pi-auth.ts` — constructs the SDK model runtime against Flitterbot-owned files.
- `src/auth/provider-auth.ts` — owns active login interactions and non-secret flow snapshots.
- `src/routes/provider-auth.ts` — exposes bearer-authenticated provider login/logout routes.
- `src/server.ts` — routes provider authentication requests.
- `src/streams/create-agent.ts` — composes prompt resources and model runtime into sessions.
- `src/routes/browser-models.ts` — reads the Flitterbot-owned model catalog and auth status.
- `web/src/components/auth-providers-section.tsx` — renders provider accounts and interactive login flows.
- `web/src/components/settings-drawer.tsx` — hosts provider account settings.
- `web/src/lib/api.ts` — calls provider authentication routes.
- `installer/data/MEMORY.md` — seeds the editable memory index.
