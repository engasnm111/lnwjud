import type { DatabaseSync } from 'node:sqlite';

export const GOAL_CONTRACT_READER_VERSION = 2;

export function configureGoalContractConnection(connection: DatabaseSync): void {
  const compatibility = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_compatibility'").get();
  if (compatibility !== undefined) {
    const floor = connection.prepare("SELECT minimum_reader FROM runtime_compatibility WHERE scope = 'goal_contract'").get();
    if (typeof floor?.minimum_reader !== 'number' || !Number.isSafeInteger(floor.minimum_reader)
      || floor.minimum_reader < 1 || floor.minimum_reader > GOAL_CONTRACT_READER_VERSION) {
      throw new Error('This profile requires a newer lnwjud. Keep the profile intact and open it with a compatible version.');
    }
  }
  connection.function('lnwjud_goal_contract_schema', { deterministic: true }, (): number => GOAL_CONTRACT_READER_VERSION);
}

export const GOAL_CONTRACT_COMPATIBILITY_MIGRATION_SQL = `
CREATE TABLE runtime_compatibility (
  scope TEXT PRIMARY KEY NOT NULL,
  minimum_reader INTEGER NOT NULL CHECK(minimum_reader >= 1)
);
INSERT INTO runtime_compatibility (scope, minimum_reader) VALUES ('goal_contract', 2);
${['INSERT', 'UPDATE', 'DELETE'].map(operation => `
CREATE TRIGGER goal_contract_reader_${operation.toLowerCase()}
BEFORE ${operation} ON goals
BEGIN
  SELECT CASE WHEN lnwjud_goal_contract_schema() < COALESCE(
    (SELECT minimum_reader FROM runtime_compatibility WHERE scope = 'goal_contract'), 2147483647
  ) THEN RAISE(ABORT, 'Goal profile requires a newer lnwjud') END;
END;
`).join('')}
`;
