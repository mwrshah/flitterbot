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
- `cloud_commands` records idempotent requests and pending/accepted/completed/uncertain status. Previously accepted commands are not replayed after worker replacement.
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

The full job remains incomplete: model/thinking controls, compaction/fork/prune/cwd operations, worker orchestration-tool parity, downstream hooks/transcripts, source-selection/bootstrap-hook semantics, and live deployment verification need completion. The existing worktree/close instructions in the protected orchestrator prompt do not yet have matching cloud tools. This branch is not demo-ready.

## Operator prerequisites

The controller runs on an exe.dev VM with the repository, Node dependencies, Flitterbot configuration, model credentials, and memory/skill files installed. Its SSH identity must authenticate to exe.dev and its workers, with verified host keys. The controller hostname is the copy source. `pnpm cloud:controller` uses the normal configured API port; workers reserve loopback ports 3002 and 3003 for execution and the reverse API tunnel. Existing local mode is unchanged unless a cloud-controller hostname marker exists.

Validation runs with `node --experimental-strip-types --test web/tests/*.test.ts src/*.test.ts`, root and web TypeScript checks, Biome, and the web build. Unit/integration tests use real temporary SQLite files, HTTP sockets, native Git repositories, and filesystem checkpoints; the provider lifecycle uses a deterministic test provider. These tests are not evidence of a live cloud deployment.

## Files

- `src/cloud/schema.ts`, `src/blackboard/migrate.ts`, `src/contracts/blackboard.ts`, `src/blackboard/schema.sql` — schema v26 and ownership/command persistence.
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
- `src/cloud.test.ts` — ownership, recovery, checkpoint, repository, and HTTP contracts.
