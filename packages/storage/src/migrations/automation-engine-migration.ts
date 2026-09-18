export const AUTOMATION_ENGINE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  policy_profile TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  status TEXT NOT NULL CHECK(status IN (
    'planned','running','waiting_task','verifying','paused',
    'blocked','completing','completed','failed','cancelled'
  )),
  based_on_goal_revision INTEGER NOT NULL CHECK(based_on_goal_revision >= 0),
  based_on_user_intent_revision INTEGER NOT NULL CHECK(based_on_user_intent_revision >= 0),
  current_milestone_id TEXT,
  current_attempt_id TEXT,
  last_recovery_decision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_workspace_updated
  ON automation_runs(workspace_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS automation_milestones (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  title TEXT NOT NULL,
  depends_on_json TEXT NOT NULL,
  execution_intent TEXT NOT NULL,
  verification_requirements_json TEXT NOT NULL,
  retry_policy_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'pending','ready','running','waiting_task','verifying',
    'retry_ready','completed','blocked','failed'
  )),
  current_attempt_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES automation_runs(id) ON DELETE RESTRICT,
  PRIMARY KEY(run_id, id),
  UNIQUE(run_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_automation_milestones_run_ordinal
  ON automation_milestones(run_id, ordinal);
CREATE TABLE IF NOT EXISTS automation_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  based_on_run_revision INTEGER NOT NULL CHECK(based_on_run_revision >= 0),
  based_on_goal_revision INTEGER NOT NULL CHECK(based_on_goal_revision >= 0),
  based_on_user_intent_revision INTEGER NOT NULL CHECK(based_on_user_intent_revision >= 0),
  status TEXT NOT NULL CHECK(status IN (
    'reserved','dispatching','waiting_task','verifying',
    'dispatch_unresolved','completed','failed','cancelled'
  )),
  failure_code TEXT,
  failure_detail TEXT,
  verification_evidence_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY(run_id) REFERENCES automation_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY(run_id, milestone_id) REFERENCES automation_milestones(run_id, id) ON DELETE RESTRICT,
  UNIQUE(run_id, milestone_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_automation_attempts_run_started
  ON automation_attempts(run_id, started_at DESC);
CREATE TABLE IF NOT EXISTS automation_task_bindings (
  attempt_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('process','codex','shell')),
  task_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('blocking_job','supporting_service')),
  cancel_with_goal INTEGER NOT NULL CHECK(cancel_with_goal IN (0,1)),
  bound_at TEXT NOT NULL,
  PRIMARY KEY(attempt_id, provider, task_id),
  FOREIGN KEY(attempt_id) REFERENCES automation_attempts(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS automation_dispatch_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'reserved','dispatched_unresolved','confirmed','failed','cancelled'
  )),
  idempotency_key TEXT,
  external_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES automation_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY(run_id, milestone_id) REFERENCES automation_milestones(run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id) REFERENCES automation_attempts(id) ON DELETE RESTRICT,
  UNIQUE(attempt_id, operation_key)
);
CREATE INDEX IF NOT EXISTS idx_automation_dispatch_receipts_run_updated
  ON automation_dispatch_receipts(run_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS automation_events (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  milestone_id TEXT,
  attempt_id TEXT,
  revision_before INTEGER NOT NULL CHECK(revision_before >= 0),
  revision_after INTEGER NOT NULL CHECK(revision_after >= revision_before),
  type TEXT NOT NULL,
  reason TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES automation_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY(run_id, milestone_id) REFERENCES automation_milestones(run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id) REFERENCES automation_attempts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_automation_events_run_revision
  ON automation_events(run_id, revision_after ASC, created_at ASC);
`;
