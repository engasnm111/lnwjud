export const GOAL_EVENTS_MIGRATION_SQL = `
CREATE TABLE goal_commit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  payload_json TEXT NOT NULL,
  UNIQUE(goal_id, revision),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE RESTRICT
);
CREATE INDEX goal_commit_events_workspace_sequence ON goal_commit_events(workspace_id, sequence);
CREATE TABLE goal_event_subscribers (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  companion_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  pairing_nonce_hash TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  start_cursor INTEGER NOT NULL CHECK(start_cursor >= 0),
  ack_cursor INTEGER NOT NULL CHECK(ack_cursor >= 0),
  delivered_cursor INTEGER NOT NULL CHECK(delivered_cursor >= ack_cursor),
  enrolled_key_id TEXT NOT NULL,
  authorized_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(workspace_id, pairing_nonce_hash),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX goal_event_subscribers_workspace_active ON goal_event_subscribers(workspace_id, revoked_at);
CREATE TABLE goal_event_signing_keys (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  certificate_json TEXT NOT NULL,
  previous_signature TEXT
);
UPDATE runtime_compatibility SET minimum_reader = 3 WHERE scope = 'goal_contract';
`;
