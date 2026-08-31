/** Add goal-relative tracked-task bindings without rewriting legacy rows. */
export const GOAL_TRACKED_TASKS_MIGRATION_SQL = `
ALTER TABLE goals ADD COLUMN tracked_tasks_json TEXT;
ALTER TABLE goal_checkpoints ADD COLUMN tracked_tasks_json TEXT;
`;
