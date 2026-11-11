# Recover held Windows writer reservations

Use this procedure with the matching lnwjud 5.9.1 all-users installation. It covers native-bound reservations whose original attempt can be authenticated. Old unbound reservations remain held when their termination cannot be proved.

## Check the installation and inspect the hold

1. Check the running version in the application. Install the matching official all-users Setup if the application and protected containment service are from different versions. Preserve the existing application data.
2. Check service availability in PowerShell.

   ```powershell
   Get-Service -Name LnwjudContainment | Select-Object Name, Status
   ```

   A `Running` status confirms availability only. The application also verifies the service process, protected image, LocalSystem identity, and its exact packaged helper digest. `SERVICE_ENDPOINT_NOT_INSTALLED` or `SERVICE_ENDPOINT_PACKAGE_MISMATCH` requires repairing the matching all-users installation. Per-user and Portable packages do not install this service from their writable directories.
3. From the owning MCP client, call these tools with the registered workspace ID.

   ```text
   task_list({"workspaceId":"<workspace-id>"})
   recovery_status({"workspaceId":"<workspace-id>"})
   self_heal_plan({"workspaceId":"<workspace-id>"})
   workspace_writer_lease_status({"workspaceId":"<workspace-id>"})
   ```

   Keep the aggregate reservation counts and symbolic failure codes. The shared index covers all workspaces. Zero visible tasks or process handles does not establish that a held reservation is terminal. These diagnostic calls do not reclaim reservations.

## Reconcile an authenticated native attempt

Use the following acquisition only when you intend to take the workspace's exclusive writer lease. Stop or finish ordinary work through its supported owner controls first. An active or unknown writer must remain blocked.

1. If the original service attempt is missing after an upgrade or interrupted installation, save work and perform an ordinary Windows restart when the machine is ready. Restarting only lnwjud or its service does not satisfy the newer-boot requirement.
2. Reconnect the owning client to the matching installed application. Request the lease through MCP.

   ```text
   workspace_writer_lease_acquire({
     "workspaceId":"<workspace-id>",
     "ttlSeconds":600,
     "recoverAbandoned":true,
     "userConfirmed":true
   })
   ```

   The acquisition runs the existing exclusive-admission probe. For each native-bound hold, it asks the authenticated service about the exact task, reservation, attempt, generation, original owner, workspace, and request digest. A missing attempt can be reconciled only when the original marker predates the current OS boot and the service independently observes that the attempt's named Job is absent. Existing nonterminal ledger entries, active Jobs, inaccessible Jobs, and conflicting identities remain held.

   The service persists an `interrupted` terminal result with exit code `125`. This records an interrupted operation, not successful command completion. A verified never-dispatched attempt instead receives the service's abort-before-launch receipt. The index removes a marker only after its full record still matches the observed record.
3. Keep the returned lease proof private and use it only in the owning client session. Release the acquired lease with `workspace_writer_lease_release`, supplying the returned `writerLease` fields. Do not publish or copy the lease token into a support report.
4. Read `task_list`, `recovery_status`, and `workspace_writer_lease_status` again. Compare the admission counts and the specific task outcome where that task is visible. A failed acquisition may still have reconciled independently verified terminal holds before encountering another blocker. Inspect the new state before another action.

This procedure does not relaunch interrupted commands. Review their outputs and side effects before deciding whether any new operation is needed. A lost `write_file` response has its own durable operation ID. Query `write_file_status` with that same ID before considering a retry.

## Retain legacy or unverifiable holds

For `legacy_unbound`, `v2_unbound`, unreadable records, or an attempt without independent terminal proof, stop the recovery attempt and keep the hold. Upgrading a v1 marker to v2 preserves its legacy status. A v2 format alone does not establish native ownership.

Send support only the application version, service availability, aggregate counts, `marker_origin`, `owner_binding`, `terminal_proof`, `recovery_requirement`, and symbolic failure codes. Support must establish historical termination and descendant evidence for the exact affected attempt or retain the reservation. There is no supported force-unlock, marker deletion, quarantine, concurrency-limit increase, or PID-only recovery procedure for these records.

The post-reboot route uses the owner's original marker timestamp. It does not authenticate that timestamp against a malicious same-user editor. Keep the original state intact. The protected native ledger and its refusal outcomes remain authoritative.

For the diagnostic fields and migration limits, see [shared reservation diagnostics](2026-10-30-v5.9.1-writer-reservation-diagnostics.md). For service enrollment and native identity checks, see [Windows containment service](../../native/windows-containment-helper/README.md).
