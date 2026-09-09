export const GOAL_PONYTAIL_MODE_MIGRATION_SQL = `
ALTER TABLE goals ADD COLUMN ponytail_mode TEXT
  CHECK(ponytail_mode IS NULL OR ponytail_mode IN ('off','lite','full','ultra'));
`;
