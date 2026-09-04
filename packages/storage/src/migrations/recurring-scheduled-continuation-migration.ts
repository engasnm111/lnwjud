export const RECURRING_SCHEDULED_CONTINUATION_MIGRATION_SQL = `
ALTER TABLE goal_scheduled_continuations RENAME TO goal_scheduled_continuations_v015;

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
  occurrence TEXT NOT NULL CHECK(occurrence IN ('once','interval')),
  interval_minutes INTEGER CHECK(
    (occurrence = 'once' AND interval_minutes IS NULL)
    OR (occurrence = 'interval' AND interval_minutes = 60)
  ),
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
  id, goal_id, source_session_id, generation, source_goal_revision, status,
  occurrence, interval_minutes, destination, execution_preference, confirmed_runs_on,
  due_at, pending_due_at, native_task_id, request_fingerprint, version,
  reschedule_reason, reschedule_count, last_collision_at, last_rescheduled_at,
  orphan_probe_started_at, orphan_probe_lease_generation, orphan_probe_activity_seq,
  orphan_recovery_count, last_detail, created_at, updated_at, claimed_at, terminal_at
)
SELECT
  id, goal_id, source_session_id, generation, source_goal_revision, status,
  occurrence, NULL, destination, execution_preference, confirmed_runs_on,
  due_at, pending_due_at, native_task_id, request_fingerprint, version,
  reschedule_reason, reschedule_count, last_collision_at, last_rescheduled_at,
  orphan_probe_started_at, orphan_probe_lease_generation, orphan_probe_activity_seq,
  orphan_recovery_count, last_detail, created_at, updated_at, claimed_at, terminal_at
FROM goal_scheduled_continuations_v015;

DROP TABLE goal_scheduled_continuations_v015;

CREATE UNIQUE INDEX idx_goal_scheduled_continuations_one_live
  ON goal_scheduled_continuations(goal_id)
  WHERE status IN (
    'prepared','scheduled','create_uncertain',
    'reschedule_required','reschedule_failed','reschedule_uncertain',
    'cancel_required','cancel_failed','cancel_uncertain'
  );

CREATE TABLE goal_scheduled_continuation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  continuation_id TEXT NOT NULL REFERENCES goal_scheduled_continuations(id) ON DELETE CASCADE,
  run_key TEXT NOT NULL,
  native_task_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN (
    'observed','acquired','orphan_recovered','worker_busy_noop','orphan_probe_noop',
    'receipt_reconcile_required','terminal_cleanup_required','terminal_noop'
  )),
  lease_generation INTEGER CHECK(lease_generation IS NULL OR lease_generation >= 0),
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(continuation_id, run_key)
);

CREATE INDEX idx_goal_scheduled_continuation_runs_continuation
  ON goal_scheduled_continuation_runs(continuation_id, observed_at DESC);
`;
