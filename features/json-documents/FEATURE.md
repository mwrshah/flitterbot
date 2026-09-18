# Durable JSON documents

## Contract and scope

A durable store owns each JSON document; a local JSON file is an optional human-editable projection. Authority depends on the operation:

- `syncAndRead()`: an existing projection wins. Changed bytes are decoded, validated, and committed before returning the accepted value. Without a file, the durable store wins.
- `update(mutator)`: a dirty file blocks the operation. Otherwise the validated mutation commits to storage and, when the file exists, is exported to it.
- `exportToFile()`: the durable store wins. Explicit export creates or replaces the file without importing its contents, including dirty or invalid contents.

Deleting a file removes its projection, not its document. Reads and updates leave it absent; only explicit export creates it. Missing files are normal. Invalid files, permission errors, and unavailable storage are errors, not reasons to silently return stale data or switch backends.

The initial implementation uses local SQLite and an optional file for both installer-created configurations: `runtime-config` at `~/.flitterbot/config.json` and `whatsapp-config` at `~/.flitterbot/whatsapp/config.json`, with no new runtime dependency. The async contract accommodates D1 as the designated cloud backend without changing application callers; its adapter is outside initial scope. Host bootstrap selects storage independently of managed configuration.

There is no schema inference, ORM, universal SQL adapter, automatic cloud/local replication, timestamp arbitration, deep merge, watcher requirement, or document cache. This primitive handles small, infrequently changed JSON documents—not arbitrary relational tables, transcripts, or third-party credential stores.

## Public primitives

```ts
type JsonValue =
  | null | boolean | number | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type DocumentDefinition<T extends JsonValue> = {
  id: string;
  decode: (input: unknown) => T;
  initial?: () => T;
};

interface JsonDocument<T extends JsonValue> {
  syncAndRead(): Promise<DeepReadonly<T>>;
  update(mutator: (current: DeepReadonly<T>) => T): Promise<DeepReadonly<T>>;
}

interface FileJsonDocument<T extends JsonValue> extends JsonDocument<T> {
  exportToFile(): Promise<void>;
}

interface JsonDocuments {
  document<T extends JsonValue>(definition: DocumentDefinition<T>): JsonDocument<T>;
  close(): Promise<void>;
}

interface LocalJsonDocuments extends JsonDocuments {
  document<T extends JsonValue>(
    definition: DocumentDefinition<T> & { filePath: string },
  ): FileJsonDocument<T>;
  document<T extends JsonValue>(definition: DocumentDefinition<T>): JsonDocument<T>;
}

const documents = openLocalJsonDocuments(BLACKBOARD_PATH);
const config = documents.document({
  id: 'runtime-config',
  filePath: FLITTERBOT_CONFIG_PATH,
  decode: decodeStoredConfig,
});

const value = await config.syncAndRead();
await config.update(current => ({ ...current, defaultModel: modelId }));
await config.exportToFile();
```

`document()` binds a definition without importing, exporting, or seeding data. Local bindings persist on first operation; duplicate IDs with different paths, or two IDs claiming one path, fail. Paths are absolute and stable; relocation is explicit maintenance. A projection-bound document cannot be reopened as storage-only to bypass dirty-file checks.

Public operations are asynchronous; decoders, seed factories, and mutators remain synchronous, deterministic, and free of I/O or nested store calls. Promise-returning callbacks and reentrancy fail. Mutators run at most once per call; conflicts never trigger automatic replay. Returned snapshots are deeply frozen and callers construct new values.

Serialization rejects undefined members, non-finite numbers, bigint, cycles, functions, and non-JSON objects rather than dropping or coercing them. Null, primitive, array, and object roots are valid. Host ownership controls store lifetime; closing a store does not close an externally owned D1 binding.

## Storage boundary and Cloudflare mapping

The private backend boundary expresses document reads and atomic revision-checked writes, not arbitrary SQL or transaction callbacks:

```ts
type StoredDocument = {
  id: string;
  valueJson: string;
  revision: number;
  valueHash: string;
};

interface DocumentStorage {
  read(id: string): Promise<StoredDocument | null>;
  compareAndSet(
    id: string,
    expectedRevision: number | null,
    value: { valueJson: string; valueHash: string },
  ): Promise<StoredDocument>;
}
```

Null `expectedRevision` means insert only if absent. Other writes succeed only against the observed revision; mismatch throws `RevisionConflict`. An unchanged canonical value preserves its revision, but still checks the expected revision. Successful writes return the committed row. Reads verify payload hashes; writers validate before submission. Domain migrations and initialization use the same concurrency contract.

The local SQLite implementation additionally coordinates projection metadata and file work in private synchronous transactions. These capabilities do not leak into the portable storage interface. No SQLite transaction spans an `await`, and the portable interface requires no interactive transaction callback. Storage-only local documents exercise the same revision-checked core as the cloud contract; file-backed documents use synchronous local transactions.

Supported deployment shapes are local SQLite with or without a file, and D1 without a file. A remote-backed local file requires distributed projection coordination and is outside this contract; an adapter swap does not silently enable it.

- **D1** stores the same document rows using SQLite semantics. Conditional SQL enforces revision checks; dependent fixed statements use D1 transactional batches. Authoritative reads use the primary, not an unconstrained read replica. Public async operations remain unchanged.
- **Workers KV** is not a conforming authoritative backend: eventual consistency and lack of atomic read-modify-write violate these guarantees. Its configuration use case applies only when stale values are acceptable. There is no KV cache here.
- **Durable Objects** offer strongly consistent SQLite-backed storage and per-entity coordination, but config storage alone does not justify their execution model.
- **R2** fits exports, uploads, and backups, not this document mutation contract.

Cloudflare hosts have no persistent local projection. `syncAndRead()` reads and validates storage; `update()` performs a revision-checked mutation. A host can serialize the returned snapshot as a JSON download; it does not expose `exportToFile()` or emulate a filesystem. Authentication, D1 binding selection, and secret credentials belong to deployment bootstrap. Workers Secrets holds cloud credentials rather than ordinary config documents.

When a local process accesses a cloud deployment, an authenticated service boundary is a separate integration. D1 failure does not select a local SQLite replica. Offline writes and reconciliation are separate features, not backend portability.

## Data model and ownership

One row stores each complete JSON document:

```sql
CREATE TABLE json_documents (
  id TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  value_hash TEXT NOT NULL
);

CREATE TABLE json_document_projections (
  document_id TEXT PRIMARY KEY REFERENCES json_documents(id),
  file_path TEXT NOT NULL UNIQUE,
  synced_file_hash TEXT,
  pending_export_hash TEXT,
  pending_export_revision INTEGER,
  CHECK ((pending_export_hash IS NULL) = (pending_export_revision IS NULL))
);
```

`json_document_projections` is local SQLite state; file state does not travel with cloud documents.

- `value_json` is canonical JSON: recursively sorted object keys, unchanged array order.
- `revision` increases only when the accepted canonical value changes; the first value has revision 1.
- `value_hash` is SHA-256 of canonical JSON, detecting accidental writes that bypass metadata maintenance.
- `synced_file_hash` hashes the exact last accepted/imported or successfully exported bytes. Null means no accepted file baseline.
- Pending export fields record the exact intended file-byte hash and document revision. No ordinary mutation supersedes unresolved export debt while the file exists.

Projection state stays on its local host, outside D1 and global document metadata. The local store permits one projection per document and creates both atomically on successful initialization; failure leaves no partial binding.

JSON remains one value, not an inferred collection of SQL columns. The domain decoder defines the schema. Normal use reads the document once per operation and accesses its properties in memory. SQLite and D1 JSON functions provide targeted queries if needed; explicit generated columns or indexes require a measured query need, not an automatic schema generator.

Hashes detect accidental corruption, not malicious access. A raw SQL writer can alter both payload and hashes. Private modules, repository checks, and review enforce the supported boundary.

Local schema installation uses the blackboard migration system. The store owns a dedicated connection with WAL, foreign keys, and the existing busy timeout—not the runtime's publicly exposed connection. `BEGIN IMMEDIATE` serializes local cooperating operations, including bounded file checks and synchronous callbacks. There are no heartbeat locks or lock files.

## Operation details

### `syncAndRead()`

```text
Local SQLite, one synchronous write transaction:
  load and verify document and projection binding
  inspect a stable snapshot of the file, if configured
  if present and changed, unbaselined, or export is pending:
    decode and validate file; recheck its identity/hash before commit
    accept canonical value; record observed hash; clear export debt
  otherwise:
    decode stored value and persist domain migration if needed
    if no stored value: validate explicit seed, or throw UninitializedDocument
    if file absent: clear its baseline and export debt
  atomically commit document and local metadata
return immutable accepted snapshot

Storage-only backend:
  read and verify document
  decode stored value, or require explicit seed
  if initialization/migration changes storage: compareAndSet observed revision
  return immutable accepted snapshot
```

An unbaselined file is imported, including first use without a stored row. Deletion clears its baseline; recreation is new input. Reformatting changes the byte hash without necessarily changing revision. Reads never rewrite file formatting or export domain migrations.

Malformed JSON, validation failure, or an observed file race leaves the prior row and file unchanged. Only `ENOENT` means absent. Permission failures, directories, and other I/O errors propagate.

File authority also applies after incomplete export: `syncAndRead()` can import an old file over a committed but unexported database update. `exportToFile()` retains the database value instead. Recovery never silently retries a mutation.

### `update(mutator)`

```text
Local SQLite, one synchronous write transaction:
  load and verify document and projection binding
  inspect file without importing it
  if pending target bytes are present: acknowledge completed export
  if present and hash differs from accepted baseline: throw DirtyDocumentError
  if export debt remains and file exists: throw PendingExport
  if absent: clear baseline and export debt
  require stored value or explicit seed; decode current value
  invoke mutator once; validate result
  recheck file presence/identity/hash; observed change -> FileChanged, rollback
  commit canonical value and revision
  if file exists: atomically record export intent with the document write
after commit, finish conditional local export if required
return immutable committed snapshot

Storage-only backend:
  read and verify document; decode value or explicit seed
  invoke mutator once; validate result
  compareAndSet observed revision; conflict -> RevisionConflict, no retry
  return immutable committed snapshot
```

A present file with no baseline is dirty. `update()` never imports it; callers explicitly synchronize before retrying. Dirty-file and unresolved-export checks occur before invoking the mutator. Postcommit deletion clears projection metadata without recreating the file. Observed postcommit edits remain intact and raise a committed-but-unexported error.

### `exportToFile()`

```text
Local SQLite, one synchronous write transaction:
  load and verify document and binding, or validate explicit seed
  decode stored value; persist domain migration
  record intended export hash and revision without importing the file
commit
under a fresh synchronous SQLite write transaction:
  verify captured revision and export intent still match
  atomically replace destination from committed value
  record emitted hash; clear export debt
commit
```

Explicit export overwrites dirty or malformed contents. It is an overwrite action, not an ordinary save. A file alone does not initialize storage during export; without a stored value or seed, export throws `UninitializedDocument`.

Completion checks the captured revision and intent before touching the file. Already acknowledged identical exports succeed without rewriting. Superseded work throws `OperationSuperseded` with `committed: true`; it never exports a captured stale value over a newer operation. Operations interleave between local transactions, not within them.

## File atomicity and recovery

The private writer serializes deterministic two-space-indented JSON plus a newline, creates an exclusive sibling temporary file with mode `0600`, writes and flushes it, and closes its descriptor. For update exports it rechecks the expected destination; explicit export intentionally discards existing content. It renames on the same filesystem, flushes the parent directory where supported, then acknowledges the emitted hash in SQLite. Handled failures clean up only that operation's temporary file.

Symlink destinations are rejected. Parent directories are trusted application-owned paths. The writer neither chmods unrelated directories nor scans/deletes arbitrary temporary files.

SQLite and the filesystem share no atomic commit. Failure before document commit changes neither accepted value nor projection. Failure after commit raises `ProjectionWriteError` with `documentId`, `committed: true`, and `revision`, never secret values. Callers must not blindly replay the mutator.

Pending intent resolves by explicit operation authority:

- File equals target hash: acknowledge replacement without replaying the mutation.
- File absent: retain storage, clear projection metadata, and recreate only on explicit export.
- File differs: `syncAndRead()` chooses file; `exportToFile()` chooses storage; `update()` throws. Dirty input takes precedence over pending debt.

A crash after rename but before acknowledgement is recognized by the pending hash. A precommit crash rolls back SQLite. Pending intent alone never authorizes startup overwrite.

A lost remote response after write submission can hide a successful commit, including initialization or migration. The D1 adapter reports `CommitOutcomeUnknown`, never guarantees rollback or replays the mutator. Callers reread and reconcile explicitly; revision checks prevent blind overwrites but cannot establish authorship after an ambiguous response.

## External edit boundary

Every file-backed read and update reads and hashes actual bytes; mtime and watchers do not determine freshness. Descriptor/path identity and metadata checks bracket reads; observed concurrent changes fail. Rechecks precede import commit and conditional export. Partial or invalid saves leave the stored value intact.

An arbitrary editor does not participate in SQLite locking. A file check followed by rename is not atomic compare-and-swap: an editor can write between them. The store detects observed races, not every concurrent external write. An old editor buffer saved later is new file input and wins on the next `syncAndRead()`. Strict ordering requires cooperating writers; hashes and watchers do not remove this boundary.

## Validation and initialization

The generic layer owns JSON safety and synchronization; each pure `decode(unknown)` owns validation and explicit domain migrations. Imported, seeded, and mutated values pass it and remain decodable after export. Versioned domains keep a discriminator in their payload; scalar/array domains use distinguishable historical shapes or an explicit domain envelope. Ambiguous shapes and unsupported newer versions fail rather than guessing defaults.

Table migrations and domain migrations remain separate. The installer uses the same decoder as runtime. A migrated stored value does not recreate a missing projection, and migration never authorizes overwriting a dirty file.

Initialization imports an existing file through `syncAndRead()` or accepts an explicit seed. No file, no stored value, and no seed means `UninitializedDocument`. Invalid file input never falls back to a seed. Seeds are bootstrap input, not runtime error recovery.

## Runtime-config adoption

Production SQLite lives at `path.join(os.homedir(), '.flitterbot', 'blackboard.db')`. A shared bootstrap module defines this location independently of JSON; no production `blackboardPath` setting or alternate-path fallback remains. Tests inject temporary paths through the store factory.

A config migration removes legacy `blackboardPath` when it resolves to the canonical database. Shared installer/startup preflight rejects noncanonical legacy paths before creating or seeding a replacement database, with an actionable relocation error. Relocation requires explicit maintenance with writers stopped; the legacy field is never an ongoing locator.

Bootstrap order is fixed-path preflight → document-store open and schema initialization/migration → config import or explicit installation seed → runtime derivation. Installer initialization failures abort dependent setup rather than reporting success with uninitialized storage. Normal startup never invents default configuration after storage failure. Installer updates use the document API and do not overwrite stored configuration merely because its projection is missing; fresh installation can explicitly export for human editing.

Config adoption removes direct readers and writers together. Persisted config decoding validates values without filesystem effects; runtime derivation expands paths and creates required directories after acceptance. Entry points await loading. Runtime services share a resolved config snapshot, refreshed at HTTP/WebSocket entry, maintenance, and successful config mutation; agent creation explicitly awaits its own read. There is no hidden synchronous JSON reload. Restart-only settings remain restart-only: synchronization does not rebind listeners or reopen databases.

Hooks, scheduler, WhatsApp, task integrations, tmux harness selection, learnings scripts, launcher, and installer use a packaged module/CLI through the same boundary. The scheduler does not exit merely because `config.json` is absent, and hook authentication remains available from storage. Packaging makes access independent of discovering source code through that optional file. Minimal launcher/deployment bootstrap is not itself a managed config document.

The WhatsApp decoder validates users, JID arrays, optional nonempty strings, and positive integer timing values; it normalizes phone JIDs, fills timing defaults, and removes the installer’s legacy `recipientJid`/`allowedJids` fields. Inbound batches read config before allowlist evaluation and carry that snapshot through user resolution; invalid config rejects the batch with an error log. Invalid syntax or schema throws without changing either stored document. Missing WhatsApp configuration requires installer seeding rather than silently selecting empty users.

Secrets retain restrictive file/database permissions and never enter diagnostics. Installer config and web-env previews redact values. Cloud deployment separates credential secrets from ordinary persisted settings. Browser `user_config`, task data, session JSONL, and provider credential stores remain outside this adoption.

## Enforcement

> Application access to registered documents uses `syncAndRead()`, `update()`, or explicit local `exportToFile()`. Only private document-store modules access managed projection bytes, synchronization metadata, or document rows. Decoders are pure. Callers handle conflicts and committed/unknown-outcome failures without automatic mutator replay. Human edits are supported input, not application bypasses.

Code Decorum’s file-level `FJD001` plugin enforces managed-path, backing-table, and private-module ownership across TypeScript, JavaScript, Python, SQL, and shell (including extensionless installed launchers). It inspects syntax trees, ignores comments, and checks whole files so aliases and multiline calls do not hide forbidden imports or path references. Literal concatenations and embedded script literals are inspected. Exact ownership exceptions cover bootstrap paths, pure schema diagnostics, document definitions, storage internals, migrations, and the primitive contract test; arbitrary test filenames grant no exemption. Consumers must not reconstruct managed paths, even for diagnostics. Runtime errors already identify the projection path.

Lefthook and audit share `audit:architecture`, which runs `uvx codedecorum@latest .` and discovers `.codedecorum.toml`; CI compares against the event’s base revision. All bundled rules retain their default enabled state and default diff-based scope. Temporary negative/positive fixtures validate the plugin before removal. Dynamically constructed paths, SQL, cross-module computed values, and deliberate lint suppressions still require review; this is a source policy, not a filesystem or database sandbox.

Assertions verify hashes, metadata, bindings, JSON safety, and reentrancy; snapshots are frozen. These detect accidental misuse, not malicious access under the same account. Raw SQL setters, public storage-only mutation escape hatches for bound documents, mutable cached references, and generic filesystem writers are not public APIs.

## Pseudocode call graphs

```text
Local production
  startup / routes / services / packaged CLI
    → await domain JsonDocument operation
      → pure decoder and synchronous mutator
      → private SQLite transaction + optional file observation
      → document and local projection metadata commit
      → conditional atomic file export when required
      → immutable value or typed error

Cloud host contract
  Worker binding + authenticated application entrypoint
    → await same domain JsonDocument operation
      → pure decoder and synchronous mutator
      → D1 primary read / atomic revision-checked write
      → immutable value or conflict / storage error
  explicit download → serialize accepted snapshot, no filesystem projection

Runtime-config bootstrap
  independent canonical database path
    → existing blackboard migrations
    → local document store
    → await runtime-config.syncAndRead()
    → pure runtime derivation
    → runtime services

Tests
  node:test + temporary real SQLite database
    → production async document API, with and without projection
    → real file edits/deletions and failure injection
  separate Node processes → concurrency and interrupted-export cases
  storage contract suite → revision checks and shared domain behavior
```

## Verification contract

Eight retained tests cover the reusable document contract and schema parity. The user approved a file-scoped `CD005` exception for `src/json-documents.test.ts`; all other rules remain enabled. The uncoordinated multi-process stress test was removed; revision-conflict coverage asserts the exact error, and both recoverable-error and process-interruption tests remain because they exercise different failure contracts. Installer/consumer smoke checks and version-specific migration checks are temporary cutover validation, removed after passing rather than retained as permanent fixtures.

- All JSON roots round-trip; non-JSON values fail without partial mutation.
- First import, explicit storage-only seed, and uninitialized errors are distinct.
- Manual, same-size, and whitespace edits are detected; semantic no-ops preserve revision.
- Missing/disabled projections read durable storage; reads/updates never recreate files.
- Dirty, invalid, or unbaselined files block mutation before its callback runs.
- Invalid imports preserve prior rows and file bytes; explicit export overwrites from storage.
- Domain migrations obey operation authority and reject unknown versions.
- Snapshots are immutable; callbacks cannot return promises, reenter, or run twice on retry.
- Compare-and-set rejects competing initialization, updates, and migrations without lost writes; no-op writes still check revision.
- Local processes serialize projection operations and never export superseded revisions; explicit file-authoritative recovery can replace pending database values.
- Failures before commit, after commit, after rename, and before acknowledgement preserve the specified values, metadata, and error outcomes.
- Recovery covers dirty files, target bytes, deletion, invalid input, and repeated recovery calls.
- Observed external races preserve handmade bytes and identify whether storage committed.
- Permission errors are not absence; exports use `0600`; symlinks fail.
- Hash tampering, conflicting bindings, and storage-only bypass of a bound document fail.
- Static negative fixtures cover filesystem, SQL, and private-module bypasses.
- Installed config consumers operate with the projection deleted; reinstall preserves stored config; noncanonical legacy paths fail preflight without creating a replacement database.
- The portable core imports no Node filesystem/SQLite modules and requires no filesystem or interactive transaction callback. D1 adoption runs the shared suite against real D1-compatible storage plus deployed checks for authoritative reads, revision conflicts, and ambiguous write outcomes; a mock alone does not establish compatibility.

## Files and implementation sequence

Primitive and enforcement:

- `src/json-documents/store.ts` — create: async handle contracts, errors, JSON safety, immutable snapshots, and guarded pure callbacks.
- `src/json-documents/storage.ts` — create: portable document read/compare-and-set core, not a general SQL interface.
- `src/json-documents/sqlite.ts` — create: local connection ownership, document persistence, projection transactions, and export recovery.
- `src/json-documents/file.ts` — create: private stable file observation and atomic replacement.
- `src/json-documents.test.ts` — create: shared behavioral contract plus real local SQLite/filesystem tests; current test glob discovers this path.
- `src/blackboard/migrate.ts`, `src/contracts/blackboard.ts`, `src/blackboard/schema.sql` — modify: matching document and local projection tables with schema-version advancement.
- `src/blackboard/db.ts` — reference: existing SQLite settings and migration lifecycle.
- `src/paths.ts` — create: canonical database location without a config dependency.
- `.codedecorum.toml`, `codedecorum-rules/document_ownership.py` — create: native file-level ownership policy, with all bundled Code Decorum rules left enabled; replaces the standalone boundary script.
- `package.json` — modify: boundary audit, test coverage, and packaged exports; no new runtime dependency.
- `.github/workflows/audit.yml` — modify: run the complete audit, including boundary and shell checks.

Complete runtime-config cutover:

- `src/config/schema.ts` — extract from `load-config.ts`: pure runtime validation/migration, types, and path derivation; no document-store dependency.
- `src/config/load-config.ts` — replace with async document loading and post-validation directory setup.
- `src/config/documents.ts` — create: both document definitions, canonical-path preflight, and scoped read/update access.
- `src/whatsapp/config.ts` — modify: pure WhatsApp decoding and explicit config snapshots for JID helpers; remove direct reads.
- `src/whatsapp/load-config.ts` — create: async document loading and post-validation home setup, without circular dependencies.
- `src/whatsapp/paths.ts` — modify: remove the redundant config-path accessor; shared bootstrap paths own both projection locations.
- `src/config/persist-models.ts` — remove: direct file writer replaced by document updates.
- `src/runtime.ts`, `src/server.ts`, `src/routes/browser-models.ts`, `src/routes/message.ts` — modify: fixed database bootstrap, awaited config access, document mutations, and typed error handling.
- `src/streams/create-agent.ts`, `src/streams/pi-session-manager.ts` — modify: shared config dependency instead of raw reloads.
- `src/whatsapp/daemon.ts`, `src/whatsapp/receive.ts`, `src/whatsapp/process.ts` — modify: shared runtime-config access and fixed database location.
- `installer/install.mjs`, `installer/uninstall.mjs` — modify: packaged integration, canonical-path preflight, schema-first setup, explicit seed/update/export, and removal of legacy path settings.
- `installer/hooks/hook-post.mjs`, `installer/scripts/runtime-common.sh`, `installer/scheduler/flitterbot-checkin.sh` — modify: packaged async read boundary; remove unused config-based database helper and missing-file short circuits.
- `installer/scripts/config-access.mjs` — create: packaged module/CLI for `read` and explicit `export`; source discovery uses packaged location or the independent `source-root` marker, not managed config.
- `installer/bin/flitterbot-up` — modify: validate configuration before status/start/stop paths can suppress connection errors; shared shell helpers supply durable reads.
- `installer/whatsapp/run-entry.js` — modify: awaited packaged config access before entrypoint resolution.
- `skills/tasks/scripts/integrations.mjs`, `skills/tasks/scripts/local-provider.mjs`, `skills/tasks/scripts/tasks.mjs` — modify: awaited durable integration settings; remove alternate JSON config path injection.
- `skills/tmux/scripts/sessions.sh` — modify: harness selection through the packaged CLI.
- `skills/learnings/scripts/config_note.py` — create: shared note-path lookup through the packaged CLI.
- `skills/learnings/scripts/learnings.py`, `skills/learnings/scripts/recall.py` — modify: remove duplicate direct config readers.
- Associated callers and fixtures — modify: async propagation and removal of `blackboardPath` assumptions across the repository.

Delivery order: async primitive and schema → authority/concurrency/recovery tests → boundary checks → fixed-path bootstrap and complete config cutover. D1 adapter implementation is a separate adoption of this contract, not speculative code in the local delivery. No UI is required; local export actions use `exportToFile()`.

## References

- [Cloudflare D1 JSON support](https://developers.cloudflare.com/d1/sql-api/query-json/)
- [D1 operations, batches, and session consistency](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
