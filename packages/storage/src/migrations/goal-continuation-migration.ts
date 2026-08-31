export const GOAL_CONTINUATION_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  goal_key TEXT NOT NULL,
  owner_client_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','completed','failed','blocked','cancelled')),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  current_phase TEXT NOT NULL,
  next_action TEXT NOT NULL,
  blockers_json TEXT NOT NULL,
  active_task_ids_json TEXT NOT NULL,
  lease_owner_client_id TEXT,
  lease_token_hash TEXT,
  lease_duration_seconds INTEGER,
  lease_heartbeat_at TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_summary TEXT,
  terminal_evidence_json TEXT,
  terminal_at TEXT,
  UNIQUE(workspace_id, goal_key)
);

CREATE TABLE IF NOT EXISTS goal_checkpoints (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  current_phase TEXT NOT NULL,
  summary TEXT NOT NULL,
  step_updates_json TEXT NOT NULL,
  next_action TEXT NOT NULL,
  blockers_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  active_task_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE RESTRICT,
  UNIQUE(goal_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_goals_owner_workspace_status_updated
  ON goals(owner_client_id, workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_goal_checkpoints_goal_revision
  ON goal_checkpoints(goal_id, revision ASC);
`;
