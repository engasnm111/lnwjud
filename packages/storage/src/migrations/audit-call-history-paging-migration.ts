/** Preserve keyset order for cross-session call history without a full workspace sort. */
export const AUDIT_CALL_HISTORY_PAGING_MIGRATION_SQL = `
CREATE INDEX IF NOT EXISTS idx_audit_calls_workspace_page
  ON audit_events(workspace_id, timestamp DESC, id DESC);
`;
