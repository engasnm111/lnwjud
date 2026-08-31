/** Rebuild the goal aggregate so existing SQLite databases can persist cancelled goals. */
export const GOAL_CANCELLATION_MIGRATION_SQL = `
DROP INDEX IF EXISTS idx_goals_owner_workspace_status_updated;
DROP INDEX IF EXISTS idx_goals_workspace_status_scheduled_fence;
DROP INDEX IF EXISTS idx_goal_checkpoints_goal_revision;
DROP INDEX IF EXISTS idx_goal_scheduled_continuations_one_live;
DROP INDEX IF EXISTS idx_goal_fenced_mutation_live;

ALTER TABLE goal_checkpoints RENAME TO goal_checkpoints_v013;
ALTER TABLE goal_scheduled_continuations RENAME TO goal_scheduled_continuations_v013;
ALTER TABLE goal_fenced_mutation_calls RENAME TO goal_fenced_mutation_calls_v013;
ALTER TABLE goals RENAME TO goals_v013;

CREATE TABLE goals (
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
  lease_owner_session_id TEXT,
  lease_token_hash TEXT,
  lease_duration_seconds INTEGER,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
  lease_activity_seq INTEGER NOT NULL DEFAULT 0 CHECK(lease_activity_seq >= 0),
  lease_heartbeat_at TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_summary TEXT,
  terminal_evidence_json TEXT,
  terminal_at TEXT,
  UNIQUE(workspace_id, goal_key)
);

INSERT INTO goals (
  id, workspace_id, goal_key, owner_client_id, objective, plan_json, status, revision,
  current_phase, next_action, blockers_json, active_task_ids_json,
  lease_owner_client_id, lease_owner_session_id, lease_token_hash, lease_duration_seconds,
  lease_generation, lease_activity_seq, lease_heartbeat_at, lease_expires_at,
  created_at, updated_at, terminal_summary, terminal_evidence_json, terminal_at
)
SELECT
  id, workspace_id, goal_key, owner_client_id, objective, plan_json, status, revision,
  current_phase, next_action, blockers_json, active_task_ids_json,
  lease_owner_client_id, lease_owner_session_id, lease_token_hash, lease_duration_seconds,
  lease_generation, lease_activity_seq, lease_heartbeat_at, lease_expires_at,
  created_at, updated_at, terminal_summary, terminal_evidence_json, terminal_at
FROM goals_v013;

CREATE TABLE goal_checkpoints (
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

INSERT INTO goal_checkpoints (
  id, goal_id, revision, current_phase, summary, step_updates_json,
  next_action, blockers_json, evidence_json, active_task_ids_json, created_at
)
SELECT
  id, goal_id, revision, current_phase, summary, step_updates_json,
  next_action, blockers_json, evidence_json, active_task_ids_json, created_at
FROM goal_checkpoints_v013;

CREATE TABLE goal_scheduled_continuations (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  source_goal_revision INTEGER NOT NULL CHECK(source_goal_revision >= 0),
  status TEXT NOT NULL CHECK(status IN (
    'prepared','scheduled','create_failed','create_uncertain',
    'reschedule_required','reschedule_failed','reschedule_uncertain',
    'claimed','terminal_noop','superseded',
    'cancel_required','cancelled','cancel_failed','cancel_uncertain'
  )),
  occurrence TEXT NOT NULL CHECK(occurrence = 'once'),
  destination TEXT NOT NULL CHECK(destination = 'current_chat'),
  execution_preference TEXT NOT NULL CHECK(execution_preference IN ('auto','cloud','local')),
  confirmed_runs_on TEXT CHECK(confirmed_runs_on IN ('cloud','local','unverified')),
  due_at TEXT NOT NULL,
  pending_due_at TEXT,
  native_task_id TEXT,
  request_fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 0),
  reschedule_reason TEXT CHECK(
    reschedule_reason IS NULL OR reschedule_reason IN (
      'collision',
      'expedite:host_deadline_warning',
      'expedite:host_budget_warning',
      'expedite:tool_access_degradation',
      'expedite:turn_yield_signal'
    )
  ),
  reschedule_count INTEGER NOT NULL DEFAULT 0 CHECK(reschedule_count >= 0),
  last_collision_at TEXT,
  last_rescheduled_at TEXT,
  orphan_probe_started_at TEXT,
  orphan_probe_lease_generation INTEGER CHECK(orphan_probe_lease_generation IS NULL OR orphan_probe_lease_generation >= 0),
  orphan_probe_activity_seq INTEGER CHECK(orphan_probe_activity_seq IS NULL OR orphan_probe_activity_seq >= 0),
  orphan_recovery_count INTEGER NOT NULL DEFAULT 0 CHECK(orphan_recovery_count >= 0),
  last_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claimed_at TEXT,
  terminal_at TEXT,
  FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE RESTRICT,
  UNIQUE(goal_id, generation),
  UNIQUE(goal_id, source_goal_revision, request_fingerprint),
  CHECK(
    status NOT IN ('reschedule_required','reschedule_failed','reschedule_uncertain')
    OR (native_task_id IS NOT NULL AND pending_due_at IS NOT NULL)
  )
);

INSERT INTO goal_scheduled_continuations (
  id, goal_id, source_session_id, generation, source_goal_revision, status, occurrence, destination,
  execution_preference, confirmed_runs_on, due_at, pending_due_at, native_task_id, request_fingerprint,
  version, reschedule_reason, reschedule_count, last_collision_at, last_rescheduled_at,
  orphan_probe_started_at, orphan_probe_lease_generation, orphan_probe_activity_seq, orphan_recovery_count,
  last_detail, created_at, updated_at, claimed_at, terminal_at
)
SELECT
  id, goal_id, source_session_id, generation, source_goal_revision, status, occurrence, destination,
  execution_preference, confirmed_runs_on, due_at, pending_due_at, native_task_id, request_fingerprint,
  version, reschedule_reason, reschedule_count, last_collision_at, last_rescheduled_at,
  orphan_probe_started_at, orphan_probe_lease_generation, orphan_probe_activity_seq, orphan_recovery_count,
  last_detail, created_at, updated_at, claimed_at, terminal_at
FROM goal_scheduled_continuations_v013;

CREATE TABLE goal_fenced_mutation_calls (
  call_id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  lease_generation INTEGER NOT NULL CHECK(lease_generation >= 0),
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);

INSERT INTO goal_fenced_mutation_calls (
  call_id, goal_id, lease_generation, started_at, heartbeat_at, expires_at, completed_at
)
SELECT
  call_id, goal_id, lease_generation, started_at, heartbeat_at, expires_at, completed_at
FROM goal_fenced_mutation_calls_v013;

DROP TABLE goal_fenced_mutation_calls_v013;
DROP TABLE goal_scheduled_continuations_v013;
DROP TABLE goal_checkpoints_v013;
DROP TABLE goals_v013;

CREATE INDEX idx_goals_owner_workspace_status_updated
  ON goals(owner_client_id, workspace_id, status, updated_at DESC);
CREATE INDEX idx_goal_checkpoints_goal_revision
  ON goal_checkpoints(goal_id, revision ASC);
CREATE UNIQUE INDEX idx_goal_scheduled_continuations_one_live
  ON goal_scheduled_continuations(goal_id)
  WHERE status IN (
    'prepared','scheduled','create_uncertain',
    'reschedule_required','reschedule_failed','reschedule_uncertain',
    'cancel_required','cancel_failed','cancel_uncertain'
  );
CREATE INDEX idx_goals_workspace_status_scheduled_fence
  ON goals(workspace_id, status);
CREATE INDEX idx_goal_fenced_mutation_live
  ON goal_fenced_mutation_calls(goal_id, lease_generation, expires_at)
  WHERE completed_at IS NULL;
`;
