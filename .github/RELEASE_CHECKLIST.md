# lnwjud Release Checklist

**Current version:** `v4.12.0` - Windows installer `lnwjud-Setup-4.12.0.exe` and portable executable `lnwjud-Portable-4.12.0.exe`; MCP registry **223 configurable tools / 217 advertised by default**.

Run the release verification from PowerShell at the repository root. The automated gate must fail fast on any non-zero stage and `git diff --check` must pass before packaging or publishing.

For GitHub releases, the `main` CI workflow is the single authoritative build: after the full verification gate succeeds it uploads the Windows installer, portable executable, blockmap, `latest.yml`, `portable.yml`, `SHA256SUMS.txt`, and `PROVENANCE.json` as a SHA-scoped Actions artifact. A `v*` tag may publish only by reusing the successful CI artifact for that exact commit SHA; the Release workflow verifies the provenance commit/hashes and must not rerun the full verification/build/package pipeline. If production Windows signing secrets are configured, Setup and Portable must have valid Authenticode signatures. When signing secrets are absent, the release may publish unsigned artifacts only after the same provenance and SHA-256 verification, with the unsigned Authenticode status reported explicitly in the workflow log and provenance recording that signing credentials were not configured.

## Automated evidence

- Workspace traversal and junction/reparse-point tests pass without broadening the configured path boundary.
- Secret-file policy and log/incident redaction tests pass; release evidence must never contain credentials or tokens.
- MCP local HTTP and STDIO transport tests pass, including protocol-only stdout and production handshake coverage.
- OpenAI Secure Tunnel targets the Desktop loopback HTTP MCP (`sample_mcp_remote_no_auth`) rather than a separate headless stdio runtime, preserving dynamic Active Project scope and native exact-action approval.
- v4.11 persistent-tunnel acceptance preserves one saved tunnel identity across managed-runtime loss and Desktop/local-MCP rebinding; transient retry is capped but unbounded in count, while auth/operator failures do not tight-loop.
- The installed official tunnel client capability probe must show managed `runtimes connect/status/stop` plus health/readiness/control-plane-poll support. Strict zero-downtime may be claimed only if a ready-before-retire overlap primitive is actually proven; otherwise the product must display the capability limitation.
- The 2026-07-28 MCP protocol catalog is compared before/after Desktop MCP listener restart: all 217 default descriptors and their canonical SHA-256 digest must remain identical, and a production tool call must work on both sides of the restart.
- Durable task/session resilience remains independent from one tunnel request; release evidence must not kill a user's live connector merely to manufacture a continuity result.
- Durable Goal Continuation verification covers restart/session resume by stable client identity, single-winner leases with expiry takeover, revision compare-and-swap conflicts, append-only checkpoints, persisted active task IDs, terminal-state closure, corruption fail-closed behavior, and proof that raw lease tokens/sensitive checkpoint text are not persisted.
- Distribution-aware updater verification proves Installer uses `latest.yml`/Setup while Portable uses `portable.yml`/Portable, with no channel crossover. Portable replacement must wait for exit, replace the exact outer EXE path, keep rollback backup, restart after success, and restore/restart the old EXE on replacement failure.
- Multi-workspace and multi-session Desktop MCP acceptance passes with one listener, parallel A/B flows, scoped ownership, logs, and destructive boundaries.
- Project lifecycle tests verify archive/restore/remove semantics: archived projects leave the active MCP trust boundary, removal preserves project files/history, duplicate paths restore the existing registration, and machine-root workspaces remain protected.
- Tool catalog synchronization passes with 223 configurable tools and 217 advertised by default; the six `codex_*` delegation tools remain opt-in.
- Delete/replace/overwrite/reset/restore paths require typed policy classification, exact Active Project scope, explicit confirmation where applicable, and recovery evidence before mutation.
- The exact `delete_file` operation is the only mutation eligible for scoped auto-approval; protected critical paths, workspace roots, non-empty directories, unsafe patterns, outside paths, and reparse escapes remain blocked from auto-approval.
- Approval-required mutations use an independent host exact-action approval boundary. Desktop approval is cancel-first; standalone/headless runtimes without a trusted host approval provider fail closed before dispatch.
- Arbitrary approved commands and project-owned scripts are opaque execution, not an operating-system sandbox, and are not automatically recoverable through Recovery Trash.
- Recovery Center verification covers deleted items, binary pre-replacement backups, checkpoints, rollback IDs, and the displayed local Recovery Trash path.
- Process ownership, PID identity, descendant shutdown, and bounded output limit tests pass.
- Internal Windows child-process launch sites used by Desktop/process/capability flows keep console windows hidden; release review checks that no `windowsHide: false` regression is introduced.
- Windows compatibility tests cover Windows 10 build 19045 and Windows 11 build 22631/26200 classification, Windows 10 software-rendering fallback before Electron readiness, built-in Windows PowerShell plumbing, hidden internal child consoles, a 16-task durable-worker ceiling, and a 24-process managed-process ceiling so parallel chats cannot create an unbounded `conhost.exe` fan-out.
- The fake Codex integration flow runs only against a disposable fixture and leaves a reviewable Git diff.
- Packaging tests verify the Windows installer and portable executable configuration, portable shortcut behavior, required runtime assets, one canonical stdio runtime beside `lnwjud.exe`, stable installed `uninstall.exe` registry commands, and generated SHA-256/source-provenance evidence.
- The packaged-app smoke verifies both versioned Windows executables plus `latest.yml` and `portable.yml` are produced before release.

## Manual clean-machine evidence

On a clean Windows account or VM, install and launch the packaged application, confirm first-run data creation, exercise a disposable workspace and Doctor, close the application, then uninstall it. Separately launch `lnwjud-Portable-<version>.exe` without installing it and confirm the dashboard, bundled runtime assets, workspace scope, and tunnel controls initialize normally. Record only pass/fail status, OS architecture, artifact path, and relevant error codes.

For the v4.11 tunnel candidate, perform the final ChatGPT Web continuity check with the same configured tunnel and conversation: do not refresh the connector, do not create a replacement tunnel/chat, cause one real supported reconnect/restart event, and confirm the next tool call succeeds. This manual Windows artifact check is the release boundary for end-to-end ChatGPT Web continuity.

Run one low-impact real Codex discovery/delegation check only in a disposable Git fixture. Do not automate provider quota consumption and do not read Codex credential files.

If Electron cannot launch because the host is missing a runtime or its Chromium process cannot start, preserve the exact environment failure and rerun the launch/install/uninstall portion on a clean supported Windows host. Do not weaken Electron sandbox, context isolation, or web security to make the gate pass.
