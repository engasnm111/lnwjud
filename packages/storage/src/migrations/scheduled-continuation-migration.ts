export const SCHEDULED_CONTINUATION_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS goal_scheduled_continuations (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  source_goal_revision INTEGER NOT NULL CHECK(source_goal_revision >= 0),
  status TEXT NOT NULL CHECK(status IN (
    'prepared','scheduled','create_failed','create_uncertain',
    'claimed','terminal_noop','superseded',
    'cancel_required','cancelled','cancel_failed','cancel_uncertain'
  )),
  occurrence TEXT NOT NULL CHECK(occurrence = 'once'),
  destination TEXT NOT NULL CHECK(destination = 'current_chat'),
  execution_preference TEXT NOT NULL CHECK(execution_preference IN ('auto','cloud','local')),
  confirmed_runs_on TEXT CHECK(confirmed_runs_on IN ('cloud','local','unverified')),
  due_at TEXT NOT NULL,
  native_task_id TEXT,
  request_fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 0),
  last_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claimed_at TEXT,
  terminal_at TEXT,
  FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE RESTRICT,
  UNIQUE(goal_id, generation),
  UNIQUE(goal_id, source_goal_revision, request_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_goals_workspace_status_scheduled_fence
  ON goals(workspace_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_scheduled_continuations_one_live
  ON goal_scheduled_continuations(goal_id)
  WHERE status IN (
    'prepared','scheduled','create_uncertain',
    'cancel_required','cancel_failed','cancel_uncertain'
  );
`;
