export const SCHEDULED_CONTINUATION_RESCHEDULE_MIGRATION_SQL = `
ALTER TABLE goals ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0);
ALTER TABLE goals ADD COLUMN lease_activity_seq INTEGER NOT NULL DEFAULT 0 CHECK(lease_activity_seq >= 0);

UPDATE goals
SET lease_generation = CASE
  WHEN status = 'active' AND lease_token_hash IS NOT NULL THEN 1
  ELSE 0
END;

CREATE TABLE goal_scheduled_continuations_v009 (
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

INSERT INTO goal_scheduled_continuations_v009 (
  id, goal_id, source_session_id, generation, source_goal_revision, status, occurrence, destination,
  execution_preference, confirmed_runs_on, due_at, pending_due_at, native_task_id, request_fingerprint,
  version, reschedule_reason, reschedule_count, last_collision_at, last_rescheduled_at,
  orphan_probe_started_at, orphan_probe_lease_generation, orphan_probe_activity_seq, orphan_recovery_count,
  last_detail, created_at, updated_at, claimed_at, terminal_at
)
SELECT
  id, goal_id, source_session_id, generation, source_goal_revision, status, occurrence, destination,
  execution_preference, confirmed_runs_on, due_at, NULL, native_task_id, request_fingerprint,
  version, NULL, 0, NULL, NULL,
  NULL, NULL, NULL, 0,
  last_detail, created_at, updated_at, claimed_at, terminal_at
FROM goal_scheduled_continuations;

DROP INDEX IF EXISTS idx_goal_scheduled_continuations_one_live;
DROP TABLE goal_scheduled_continuations;
ALTER TABLE goal_scheduled_continuations_v009 RENAME TO goal_scheduled_continuations;

CREATE UNIQUE INDEX idx_goal_scheduled_continuations_one_live
  ON goal_scheduled_continuations(goal_id)
  WHERE status IN (
    'prepared','scheduled','create_uncertain',
    'reschedule_required','reschedule_failed','reschedule_uncertain',
    'cancel_required','cancel_failed','cancel_uncertain'
  );

CREATE INDEX IF NOT EXISTS idx_goals_workspace_status_scheduled_fence
  ON goals(workspace_id, status);

CREATE TABLE goal_fenced_mutation_calls (
  call_id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  lease_generation INTEGER NOT NULL CHECK(lease_generation >= 0),
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_goal_fenced_mutation_live
  ON goal_fenced_mutation_calls(goal_id, lease_generation, expires_at)
  WHERE completed_at IS NULL;
`;
