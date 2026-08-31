export const GOAL_LIVE_CONTINUATION_LEASE_QUARANTINE_MIGRATION_SQL = `
-- Early development builds of migration 010 cleared malformed active leases.
-- If a live continuation still exists, restore a fail-closed synthetic lease so
-- the scheduled wake must pass two unchanged trustworthy orphan probes.
UPDATE goals
SET lease_owner_client_id = owner_client_id,
    lease_owner_session_id = 'legacy-quarantined-live-continuation',
    lease_token_hash = '0000000000000000000000000000000000000000000000000000000000000000',
    lease_duration_seconds = 3600,
    lease_generation = lease_generation + 1,
    lease_activity_seq = lease_activity_seq + 1,
    lease_heartbeat_at = updated_at,
    lease_expires_at = '9999-12-31T23:59:59.999Z'
WHERE status = 'active'
  AND lease_owner_client_id IS NULL
  AND lease_owner_session_id IS NULL
  AND lease_token_hash IS NULL
  AND lease_duration_seconds IS NULL
  AND lease_heartbeat_at IS NULL
  AND lease_expires_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM goal_scheduled_continuations AS continuation
    WHERE continuation.goal_id = goals.id
      AND continuation.status IN (
        'prepared', 'scheduled', 'create_uncertain',
        'reschedule_required', 'reschedule_failed', 'reschedule_uncertain',
        'cancel_required', 'cancel_failed', 'cancel_uncertain'
      )
  );
`;
