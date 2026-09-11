# Repository agent instructions

## Automatic scheduled continuation

When a user-authorized repository task is still incomplete and the user has authorized scheduled continuation, load and follow [`.agents/skills/lnwjud-scheduled-continuation/SKILL.md`](.agents/skills/lnwjud-scheduled-continuation/SKILL.md) as the source of truth. Never create a schedule when the user has explicitly opted out for the current task.

For rolling continuation, the workspace skill is authoritative. Current mainline uses exactly one **hourly recurring** Native ChatGPT Scheduled Task for an active goal, in the current chat with cloud execution requested. Ordinary checkpoints and ordinary recurring wakes reuse the same native task; they do not create or retime a per-turn successor. Historical one-time watchdog rows are compatibility-only. Never use lnwjud `scheduler`, Windows Task Scheduler, `schtasks.exe`, cron, shell timers, browser/DOM automation, or undocumented scheduler APIs as a fallback. Never create or re-enable scheduled continuation when the user has explicitly disabled it for the current task.

Every rolling-mode workspace mutation must use the current `goalLease` token/generation proof. Same MCP session identity is not ownership proof. Track background work with goal-relative `trackedTasks`: `blocking_job` entries participate in liveness, while `supporting_service` entries do not; explicit `provider` routing and `cancelWithGoal` ownership prevent a shared service from being probed or stopped accidentally. Legacy `activeTaskIds` rows decode conservatively as goal-owned blocking jobs. Live or unknown liveness fails closed; stale-owner takeover must follow the bounded recovery rules in the scheduled-continuation skill. A request to disable scheduling stops only scheduled continuation and never abandons the durable goal. When the goal finishes, make the exact Native ChatGPT task non-runnable using the strongest operation actually exposed by the host (prefer true delete, otherwise host-confirmed disable), record truthful cleanup evidence, finish the goal, verify `get_goal` is terminal, and stop. Never report completion while the goal is active.

## Authoritative CI Watcher Policy

When a GitHub Actions workflow must be monitored until completion, use one authoritative long-running background/durable watcher for the exact workflow run instead of repeated ad-hoc polling.

- Resolve and record the exact GitHub Actions run ID first. Never monitor only "the latest run on a branch" after the watcher starts.
- Before starting a watcher, inspect existing authoritative shell/process tasks. If a live watcher already targets the same exact run ID, reuse its task ID and inspect/wait/result it; do not start a duplicate watcher.
- Preferred watcher command: `gh run watch <RUN_ID> -i 20 --exit-status`.
- Treat the watcher task as the authoritative task for that CI run and keep it attached to the durable goal as a `blocking_job` when goal tracking is active.
- Do not report CI success until the authoritative watcher is terminal and the GitHub workflow conclusion is confirmed.
- On failure, inspect the actual GitHub Actions job logs for that exact run before changing code. Do not guess from branch state or from a different run.
- Never merge, tag, publish, or release from a SHA whose required CI run failed or is still non-terminal.
- Multiple exact workflow run IDs may be chained inside one durable watcher process when appropriate, but preserve each workflow's exit code and fail the watcher if any required workflow fails.
- A CI watcher is process monitoring, not a ChatGPT Scheduled Task. Do not create or re-enable scheduled continuation merely to watch CI when the user has scheduling disabled.
- Windows example only:

  ```powershell
  powershell -NoProfile -NonInteractive -Command "
  Write-Host 'Watching CI run 123456...';
  gh run watch 123456 -i 20 --exit-status;
  $ciExit = $LASTEXITCODE;
  exit $ciExit
  "
  ```

- macOS/Linux must use a shell available on that platform (for example `sh`/`bash`) rather than assuming PowerShell is installed:

  ```sh
  gh run watch 123456 -i 20 --exit-status
  ```

This policy is cross-platform because the monitoring contract is shared while the wrapper shell is platform-native. Do not label a PowerShell-only implementation as cross-platform.

## Local Windows Packaging / Signing Policy

Local Windows development builds normally run **without a paid/commercial Windows code-signing certificate**. Therefore `Get-AuthenticodeSignature` may legitimately report `NotSigned`/unsigned for locally built Setup or Portable artifacts. Do **not** treat that status by itself as a local build failure.

- Separate **Windows Authenticode publisher signing** from **artifact integrity/provenance verification**. They are different mechanisms.
- For a local dev package with no Windows signing credentials configured, success is based on the package command succeeding plus the required SHA-256/provenance/release-evidence checks passing. Record the unsigned Authenticode state truthfully; do not invent or require a certificate that is not configured.
- The canonical Sigstore verifier for this repository's Windows local/CI workflow is **cosign v3.1.3**. Prefer setting `LNWJUD_COSIGN_PATH` to a trusted cosign v3.1.3 binary; on the current Windows workstation the usual cached binary is `C:\Users\ABCz\AppData\Local\lnwjud-build-tools\cosign-v3.1.3\cosign-windows-amd64.exe` when present.
- `cosign` verifies pinned Sigstore provenance/integrity (for example the bundled tunnel-client). It **does not** Authenticode-sign lnwjud and is not a substitute for a Windows publisher certificate.
- Never weaken official release/CI signing gates. If Windows signing secrets/certificates are configured for an official workflow, that workflow may require Authenticode `Valid`; missing/invalid signing in that configured context is a real failure.
- When investigating a local Windows packaging failure, first distinguish among: package/build failure, SHA/provenance/cosign verification failure, and merely `NotSigned` Authenticode status. Only the first two are automatically failures for an unsigned local dev build.

`Full Bypass` is an explicit runtime exception to application approval and scope enforcement: while a Full profile has the relevant Desktop or STDIO Full Bypass toggle enabled, permission prompts, Active Project scope, and other lnwjud approval gates may be skipped. Durable-goal ownership is different: if a workspace has a live rolling scheduled-goal mutation fence, `ToolRegistry` must still require and validate the current `goalLease` before mutation, even under Full Bypass. This prevents a stale worker from mutating after handoff. Ordinary unscheduled Full Bypass calls remain lease-free when no live rolling-goal fence exists.
