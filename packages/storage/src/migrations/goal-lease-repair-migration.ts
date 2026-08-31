export const GOAL_LEASE_REPAIR_MIGRATION_SQL = `
-- Migration 008 introduced lease_owner_session_id after durable goals already existed.
-- Preserve a complete pre-session-fence lease by assigning an explicit legacy owner
-- marker; this keeps old leases readable until normal expiry/takeover.
UPDATE goals
SET lease_owner_session_id = 'legacy-pre-session-fence'
WHERE status = 'active'
  AND lease_owner_session_id IS NULL
  AND lease_owner_client_id IS NOT NULL
  AND lease_token_hash IS NOT NULL
  AND lease_duration_seconds IS NOT NULL
  AND lease_heartbeat_at IS NOT NULL
  AND lease_expires_at IS NOT NULL;

-- Fail closed on any other malformed partial active lease. Replace untrusted
-- ownership fields with a synthetic quarantine lease that no old worker can
-- prove. A live scheduled continuation can recover it through the normal
-- two-unchanged-probe orphan path; run_goal cannot take it immediately.
UPDATE goals
SET lease_owner_client_id = owner_client_id,
    lease_owner_session_id = 'legacy-quarantined-lease',
    lease_token_hash = '0000000000000000000000000000000000000000000000000000000000000000',
    lease_duration_seconds = 3600,
    lease_generation = lease_generation + 1,
    lease_heartbeat_at = updated_at,
    lease_expires_at = '9999-12-31T23:59:59.999Z',
    lease_activity_seq = lease_activity_seq + 1
WHERE status = 'active'
  AND NOT (
    (lease_owner_client_id IS NULL AND lease_owner_session_id IS NULL AND lease_token_hash IS NULL
      AND lease_duration_seconds IS NULL AND lease_heartbeat_at IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_owner_client_id IS NOT NULL AND lease_owner_session_id IS NOT NULL AND lease_token_hash IS NOT NULL
      AND lease_duration_seconds IS NOT NULL AND lease_heartbeat_at IS NOT NULL AND lease_expires_at IS NOT NULL)
  );

-- Terminal goals must never retain a lease. Repair legacy rows defensively.
UPDATE goals
SET lease_owner_client_id = NULL,
    lease_owner_session_id = NULL,
    lease_token_hash = NULL,
    lease_duration_seconds = NULL,
    lease_heartbeat_at = NULL,
    lease_expires_at = NULL,
    lease_activity_seq = 0
WHERE status <> 'active'
  AND (
    lease_owner_client_id IS NOT NULL OR lease_owner_session_id IS NOT NULL OR lease_token_hash IS NOT NULL
    OR lease_duration_seconds IS NOT NULL OR lease_heartbeat_at IS NOT NULL OR lease_expires_at IS NOT NULL
  );
`;
