export const CALL_OBSERVABILITY_MIGRATION_SQL = `
CREATE INDEX IF NOT EXISTS idx_audit_calls_workspace_correlation
  ON audit_events(workspace_id, json_extract(metadata_json, '$.callId'), timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_goal_mutation_receipts
  ON audit_events(workspace_id, json_extract(metadata_json, '$.goalId'), timestamp DESC)
  WHERE result_code = 'SUCCESS' AND action LIKE 'mcp_tool:%';
`;
