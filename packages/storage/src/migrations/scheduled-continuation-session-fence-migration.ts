export const SCHEDULED_CONTINUATION_SESSION_FENCE_MIGRATION_SQL = `
ALTER TABLE goals ADD COLUMN lease_owner_session_id TEXT;
ALTER TABLE goal_scheduled_continuations
  ADD COLUMN source_session_id TEXT NOT NULL DEFAULT 'legacy-pre-session-fence';

CREATE INDEX IF NOT EXISTS idx_goals_workspace_status_scheduled_fence
  ON goals(workspace_id, status);
`;
