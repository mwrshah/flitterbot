export const CLOUD_SCHEMA = `
CREATE TABLE IF NOT EXISTS cloud_workers (
  stream_id TEXT PRIMARY KEY REFERENCES streams(id),
  generation INTEGER NOT NULL CHECK (generation > 0),
  vm_name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('provisioning','ready','closing','absent')),
  checkpoint_version INTEGER NOT NULL DEFAULT 0,
  checkpoint_path TEXT,
  final_checkpoint_version INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_commands (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES streams(id),
  generation INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','completed','uncertain','canceled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cloud_commands_stream ON cloud_commands(stream_id, status);
`;
