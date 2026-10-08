/** Additive: existing Goal rows and checkpoints remain intact. */
export const WORKFLOW_METADATA_MIGRATION_SQL = `ALTER TABLE goals ADD COLUMN workflow_json TEXT;`;
