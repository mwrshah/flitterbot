# Cloud swimlanes

## Contract

The default VM owns the browser connection, the authoritative SQLite blackboard, global session search, and published checkpoints. Each work stream owns a VM with an independent repository and native Pi session file. A fork inherits historical files as a snapshot; siblings do not synchronize with one another. Workers publish their own state to main at settlement. Database operations use authenticated controller requests, not a mounted SQLite file.

## Execution boundaries

```text
Browser → main control surface → stream execution target
                                  ├─ local default agent
                                  └─ exe.dev worker → local Pi / Git / filesystem
Worker → authenticated main API → local SQLite transaction
Worker settlement → local publication backlog → main immutable checkpoint
Open stream → serialized ensure → provider inventory → existing worker or fork
Close → freeze work → final checkpoint acknowledgement → delete VM → archive
```

The browser stays connected to main. Sidebar search runs on main. Input file search, directory completion, active history, and repository inspection run on the stream's execution host. Archived history uses the last acknowledged checkpoint. A replacement restores the stream checkpoint after cloning the current main environment.

## Persistence contracts

- `cloud_workers` records stream ownership, generation, reserved VM name, credential hash, phase, latest checkpoint, and acknowledged final checkpoint.
- `cloud_commands` records pending/accepted/completed/uncertain/canceled requests at main-side admission, before provisioning or transport. Queue snapshots and cancellation use this authoritative state. Previously accepted commands become uncertain after worker replacement or process restart; they are not automatically replayed.
- `cloud_start_options` pins workspace/head/base selection. `cloud_hook_receipts` deduplicates downstream lifecycle delivery by stream, generation, and sequence.
- Worker tokens derive from the controller secret, stream ID, and generation. A superseded generation cannot query, accept commands, or publish files.
- Native session JSONL is preserved without reconstructing messages. Published checkpoint directories are immutable. A monotonic database pointer selects the current checkpoint; retries with conflicting content fail.
- Repository checkpoints contain Git history as a bundle, a staged binary patch, and current tracked/untracked non-ignored files. Restores create a new independent repository, never replace an existing checkout. Submodules and symlinks escaping the workspace fail explicitly. A 128 MiB checkpoint limit bounds this proof of concept.
- A local publication backlog survives worker process restarts. Files leave the backlog only after controller acknowledgement.

## Failure policy

An unavailable inventory or unreachable existing VM is not evidence of absence. A failed copy reserves its name: reconciliation adopts that VM if it appears, rather than issuing another copy. An absent reserved VM after an ambiguous copy requires operator reconciliation. Confirmed loss of a ready VM advances its generation and marks accepted commands uncertain.

Close retains the VM if final publication fails. A persisted final-checkpoint marker allows retry after a lost deletion response without asking a deleted worker to checkpoint again. Replacement may lose unpublished state. Repository capture rejects concurrent HEAD/index changes but does not promise a point-in-time snapshot of background filesystem writes.

## Implementation status

The branch contains tested ownership, provider, checkpoint, publication backlog, repository capture/restore, and authenticated central API primitives. The API is installed in `src/server.ts`. Read-only blackboard SQL uses SQLite's authorizer. Pi event subscription and the query tool accept callbacks, separating local event handling from persistence without changing the SDK.

`pnpm cloud:controller` enables the cloud execution target. A persistent hostname marker prevents cloned VMs from starting the inherited main runtime. The worker entry point reuses the existing agent factory, lifecycle event translator, native history reader, and directory search. It authenticates with main before opening Pi, retrieves the current checkpoint version, and publishes lifecycle updates asynchronously.

Creation materializes a dormant native Pi session on main without starting a local agent. Prompt delivery, active history, input directory search, diffs, and interruption route to the worker. Sidebar search remains local. Workers publish session files into main's normal active/archived directories and restore independent repository mirrors. Context-menu close waits for the final checkpoint before VM deletion. Replacement restores the published session and repository. The main WebSocket relays worker events; recovery invalidates browser history.

An SSH connection carries both directions: a local forward reaches the worker, and a reverse forward gives the worker a loopback URL for main's API. The SQLite database stays local to main, and neither endpoint needs a public exe.dev proxy. Ready workers use their recorded route; transport failures trigger provider reconciliation rather than putting inventory queries on every directory-search request.

Model/thinking changes, compaction, pruning, cwd changes, and fork snapshots execute against the worker's native SDK session. Main creates fork identities from acknowledged native history and starts a separate VM. Catalog model-change entries retain the selected gateway model ID even when provider replies report a different upstream ID. User guidance and hook messages enter native SDK steering at turn boundaries, not token callbacks.

`set_up_worktree` inspects or prepares the existing VM-isolated repository. `close_swimlane` previews a merge, requires a new user message after that preview, commits worker changes, and asks main to merge the acknowledged checkpoint. Main serializes merges, refuses dirty canonical repositories, and aborts conflicts without deleting the worker. Neither this tool nor context-menu close pushes. Context-menu close preserves an archive without merging.

Worker-local Claude/Codex hooks enter a durable upload queue. Main owns session registration and stop handling; immutable native transcript copies remain readable after the worker disappears. Direct downstream messages execute on the owning worker. Final publication stops registered tmux processes before collecting their final transcripts.

Creation accepts `startFrom: workspace | head | base` and optional `baseRef`. Workspace mode preserves the inherited dirty checkout; head/base modes create an independent checkout at the pinned commit. Configured `flitterbot.copypath` files and `flitterbot.postcreate` commands hydrate new/restored checkouts. Recovery preserves the native session ID, branch, index, working files, and relative cwd. Main flushes already-written disk data before requesting a VM copy; this does not make concurrent application writes atomic.

## Operator prerequisites

The controller runs on an exe.dev VM with the repository, Node dependencies, Flitterbot configuration, model credentials, and memory/skill files installed. Its SSH identity must authenticate to exe.dev and its workers, with verified host keys. The controller hostname is the copy source. `pnpm cloud:controller` uses the normal configured API port; workers reserve loopback ports 3002 and 3003 for execution and the reverse API tunnel. Existing local mode is unchanged unless a cloud-controller hostname marker exists.

Validation runs with `node --experimental-strip-types --test web/tests/*.test.ts src/*.test.ts`, root and web TypeScript checks, Biome, and the web build. Unit/integration tests use real temporary SQLite files, HTTP sockets, native Git repositories, and filesystem checkpoints; the provider lifecycle uses a deterministic test provider. The cloud suite contains three durable pipelines: lifecycle/command safety, native Git/session publication and merge safety, and authenticated HTTP/SQLite/outbox delivery. Live validation uses the operator scripts below rather than treating those pipelines as deployment proof.

## Live demo and validation

The dedicated controller is `fb-cloud-demo-main`; the private surface is [the cloud demo](https://fb-cloud-demo-main.exe.xyz). WorkOS AuthKit requires a Google, Apple, or email/password session before loading Flitterbot, and the controller installer requires its API key, client ID, cookie password, and exact callback URI through the process environment. Existing `flitterbot-base` and `flue-*` VMs are outside this demo. The controller/web systemd units use `ConditionHost` so copies do not start inherited controller services.

Run these commands on the demo controller from its Flitterbot checkout:

```bash
node installer/cloud/demo.mjs inspect
node installer/cloud/demo.mjs recover
node installer/cloud/verify-controls.mjs
node installer/cloud/verify-tools.mjs
```

`recover` deliberately deletes only the recorded disposable worker after a fresh acknowledged checkpoint, then verifies replacement and native identity. `verify-controls` forks a disposable stream, checks model/thinking/cwd changes, supplies sufficient synthetic context for real compaction, prunes a branch, and verifies final archival. `verify-tools` checks the actual orchestration tools, a real Claude CLI's hooks/transcript, the preview/confirmation boundary, canonical merge, and worker deletion. Each run retains its manifest on failure; `--resume` is an explicit operator decision, not an automatic retry. Archive completed test manifests before starting another run.

Validation on 2026-09-15 covers those live flows and a headless-browser send/reply/reload against the controller. WorkOS protection was added and validated on 2026-09-23: an unauthenticated application request starts AuthKit, the configured callback is accepted, and the hosted page offers Google and email/password. The browser script uses an isolated test profile, requires Playwright storage state from a completed WorkOS login, and disables stub fallback; it does not change the user's browser. Run:

```bash
uv run --with playwright installer/cloud/verify-browser.py \
  --url https://fb-cloud-demo-main.exe.xyz \
  --api-url https://fb-cloud-demo-main.exe.xyz \
  --storage-state <authenticated-storage-state.json> \
  --session-id <demo-pi-session-id> --hostname <current-worker-name> \
  --model-label 'opus 5' --screenshot /tmp/cloud-demo.png
```

Provide `--executable` when using an existing test-browser installation. `install-controller.mjs` builds the private frontend and installs the hostname-guarded services; configuration, model/CLI credentials, dependencies, and verified SSH access are prerequisites.

## Proof-of-concept limits

Main remains a single point of failure. AuthKit protects the TanStack application routes; the exe.dev private proxy and Flitterbot bearer token remain separate defense layers for the demo's proxied HTTP and WebSocket surfaces. Workers inherit the controller environment, including credentials and historical files: these VMs are not a security boundary for untrusted tenants. Generation tokens fence the normal protocol, not a privileged actor with inherited account credentials. Only acknowledged native sessions, downstream transcripts, and repository checkpoints publish back; arbitrary environment/configuration edits and sibling histories do not synchronize. There is no automatic replay of uncertain work, distributed SQLite, shared writable filesystem, or claim of application-consistent live VM copying. Submodules, oversized checkpoints, and ambiguous provider failures stop explicitly and retain recoverable state.

## Files

- `src/cloud/schema.ts`, `src/blackboard/migrate.ts`, `src/contracts/blackboard.ts`, `src/blackboard/schema.sql` — schema v27 and ownership/command/start-option/hook persistence.
- `src/cloud/store.ts` — generation authentication and command/checkpoint state transitions.
- `src/cloud/coordinator.ts` — serialized provisioning, reconciliation, and checkpoint-gated close.
- `src/cloud/exe.ts` — bounded SSH calls to exe.dev; inventory errors never imply absence.
- `src/cloud/checkpoints.ts` — ownership validation and immutable filesystem publication.
- `src/cloud/repository.ts` — repository capture and independent restore.
- `src/cloud/publisher.ts` — durable local upload backlog and retries.
- `src/cloud/api.ts`, `src/cloud/client.ts`, `src/server.ts` — authenticated worker/controller HTTP protocol.
- `src/cloud/worker-agent.ts`, `src/cloud/worker-server.ts` — single-session execution without a local blackboard or global services.
- `src/cloud/ssh-worker.ts` — worker bootstrap and bidirectional SSH forwarding; bootstrap secrets travel through stdin, not command arguments.
- `src/cloud/control.ts` — main runtime integration, hostname guard, routing, recovery, and WebSocket relay.
- `src/cloud/projection.ts` — serialized checkpoint projection into normal session directories and independent repository mirrors.
- `src/routes/browser-pi-session-diff.ts` — shared Git diff implementation for main and worker execution.
- `src/contracts/websocket.ts` — recovery history-invalidation reason.
- `package.json` — controller and worker entry-point commands.
- `src/routes/browser-directory-completions.ts` — shared filesystem completion implementation for local and worker execution.
- `src/blackboard/tool-query-blackboard.ts`, `src/runtime.ts` — query execution callback with local default implementation.
- `src/streams/pi-subscribe.ts`, `src/streams/pi-session-manager.ts` — persistence callback at lifecycle boundaries, not token deltas.
- `src/cloud.test.ts` — three durable lifecycle, repository, and authenticated HTTP pipelines.
- `src/cloud/workspace.ts`, `src/git.ts` — pinned source selection, bootstrap hydration, independent branch preservation, and Git subprocess isolation from inherited hook variables.
- `src/cloud/tools.ts`, `src/cloud/merge.ts` — native worker tools, user-confirmed close, and serialized main-side merges.
- `src/cloud/hooks.ts`, `src/cloud/hook-receiver.ts` — durable downstream events and native transcript publication.
- `src/streams/session-file-cwd.ts` — atomic native header cwd changes.
- `installer/cloud/` — controller installation and live browser/API/CLI validation.
