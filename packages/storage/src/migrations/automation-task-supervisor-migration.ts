export const AUTOMATION_TASK_SUPERVISOR_MIGRATION_SQL = `
ALTER TABLE automation_task_bindings ADD COLUMN deadline_at TEXT;
ALTER TABLE automation_task_bindings ADD COLUMN last_observed_at TEXT;
ALTER TABLE automation_task_bindings ADD COLUMN last_state TEXT;
ALTER TABLE automation_task_bindings ADD COLUMN last_detail TEXT;
ALTER TABLE automation_task_bindings ADD COLUMN terminal_at TEXT;

ALTER TABLE automation_dispatch_receipts ADD COLUMN provider TEXT;
ALTER TABLE automation_dispatch_receipts ADD COLUMN deadline_at TEXT;

CREATE INDEX IF NOT EXISTS idx_automation_task_bindings_attempt_role
  ON automation_task_bindings(attempt_id, role);

CREATE INDEX IF NOT EXISTS idx_automation_task_bindings_deadline
  ON automation_task_bindings(deadline_at)
  WHERE deadline_at IS NOT NULL;
`;
