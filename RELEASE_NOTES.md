# lnwjud release notes

Release highlights are listed newest first. The [README](README.md) shows the three newest versions, and each [GitHub Release](https://github.com/engasnm111/lnwjud/releases) contains its published notes and downloads.

### What's new in v5.8.1

- **Work Log and shared dropdown overlay:** remove the page-padding scroll reservation and automatic scroll-into-view on dropdown opening. Popup menus stay below the trigger and scroll internally without compressing data tables behind them.
- **What’s New version grouping:** show all installed-or-earlier patch notes within 5.8.x, newest first; switch to 5.9.x at v5.9.0, and group 6.x.x under the same major when v6 arrives. Keep notes scrollable and local.
- **Live Logs Tunnel:** hide Workspace and Session selectors and scoped-clear actions that do not filter Tunnel output. Text search, pause, clear Tab, and export remain; MCP activity and Processes keep their scoped filters.

### What's new in v5.8.0

This release is a substantial functional expansion over **v5.7.4**, whose main fixes were bounded high-risk approval/native-alert dialogs. The features below are based on the `v5.7.4..v5.8.0` changeset, not on plans alone.

- **Six bilingual, review-first task templates:** Project Check, Code Review, Release Readiness, Connection Check, Data Audit and Template Report. Inputs are validated and drafts can be copied to a connected AI; previewing does not schedule or start a Goal.
- **Persistent MCP call observability:** SQLite-backed call correlation, bounded keyset paging, tool/Goal filters and server p50/p95 where samples exist. Unmeasured Tunnel spans and transport identity remain unknown, never fabricated. Goal dropdowns omit Goals without attributable calls.
- **Task Results backed by evidence:** checkpoints, actual completed plan steps, recorded engineering checks, mutation receipts, file hashes and artifact verification. Results dropdowns omit Goals without meaningful evidence; completion does not by itself certify correctness.
- **Safe Goal mutations:** checkpoint restoration and owned-task cancellation require workspace, identity, revision/hash and explicit confirmation checks. A shared service or unknown PID is not treated as owned.
- **Resource sampling:** Windows process working-set memory and lifetime-average CPU for verified owned children, with PID/start-time checks. Desktop main-process metrics are labeled separately and not counted as Goal usage; unavailable values remain unavailable, Goal filters hide unmeasured entries, and tab-scoped refresh is bounded.
- **Context Economy totals:** recorded context bytes and ledger hits are exposed from the running MCP HTTP transport without being presented as per-Goal or per-workspace totals.
- **CSV/XLSX auditing and reports:** typed data analysis, cell comparison and new template-based reports with readback, preserving sources by default. Native advanced Office actions remain provider/host-specific.
- **Git explorer improvements:** recursive untracked-file visibility, searchable/collapsible directory tree, working tree/index/HEAD navigation, familiar Prompt-style text, and safe text/image previews with bounded binary-file metadata.
- **Cross-screen Desktop UI:** consolidate shared fields/buttons/filters, improve Settings select consistency, and anchor searchable dropdowns exclusively **below** their fields (outer scroll room plus bounded internal scroll). Restore preferred font sizing and refine Tools/Doctor spacing, empty results and loading feedback.
- **Command Prism Agent status and Workflow cards:** replace the generic circle with a faceted prism using real states: gold for ready, blue for working, red for stopped/offline, and a reserved neutral gray state with no fabricated lifecycle; add restrained workflow card icons.
- **Modal close glyphs:** override the shared action font-size cascade with a more specific selector so What's New and Tool Detail close symbols render at 25px with 44px targets; apply the same close sizing to guided Tunnel setup.
- **Work Log:** start with all workspaces and improve filtering/search feedback.
- **Persistent Secure MCP Tunnel startup:** avoid repeated connection attempts while the same managed runtime is still starting; use a bounded 45-second real elapsed-time readiness grace before recovery while retaining owner checks and backoff. Connection speed still depends on the tunnel service/network.
- **Bundled `tunnel-client` 0.0.16:** native target preparation and package verification with pinned dependency evidence.
- **Runtime dependency automation:** one managed update PR and conditional branch cleanup instead of duplicate automated updates.
- **Release safety:** behavior-based regression tests for workflow/IPC/Git/resource/tunnel paths and target-native CI across Windows/macOS/Linux. Preserve SHA-256/provenance and signer-state evidence; Windows community builds remain unsigned without a certificate.

**ภาษาไทย — สรุปความต่างจาก v5.7.4:** v5.8.0 เพิ่ม Workflow 6 แบบ, Doctor ที่กรอง Goal จากหลักฐานจริง, ประวัติ MCP/ผลลัพธ์ตาม Goal, RAM และ CPU ของโปรเซสที่ตรวจสอบเจ้าของได้, Context Economy ระดับ Transport, งาน CSV/XLSX, Git tree/preview, ปรับ UI และปุ่มปิด Modal, Work Log, ป้องกัน Tunnel reconnect ก่อนพร้อม, อัปเดต tunnel-client 0.0.16 และระบบตรวจ Release/Dependency PR ตามหลักฐานจริง ค่าไม่มีข้อมูลยังคงเป็น unknown ไม่ใช่ 0

### What's new in v5.7.4

- **High-risk approval details stay on screen across Windows, macOS, and Linux:** the complete command appears in a bounded lnwjud window with its own scrollable detail area. Cancel is focused by default, and closing the window or pressing Escape cancels the request.
- **Other native alerts resist oversized error text:** variable Update, Tunnel, and shutdown error messages are bounded before they reach native dialogs.

### What's new in v5.7.3

- **Engineering Harness verifies real release evidence:** package gates can consume fresh durable-shell artifacts, cross-platform gates bind to the exact commit, and Windows records Authenticode state. Configured production signing must be Valid, while community releases without a certificate may remain unsigned after SHA-256 and provenance checks.
- **Durable Goal continuity is more reliable:** Ponytail ULTRA preserves loaded skill activation across transport-session rotation, and `finish_goal` reports unfinished plan, acceptance, gate, or blocker conditions instead of false stale-CAS conflicts when the revision is unchanged.
- **Serena and external MCP child processes are safer:** a rejected tool call no longer forces a healthy process to respawn, and replacement waits until the previous process is verified stopped, reducing duplicate processes and resource leaks.
- **Linux AppImage startup is more resilient:** the app can start when keyring/secure storage is temporarily unavailable while encrypted secret/checkpoint operations remain fail-closed; the static AppImage runtime also avoids a FUSE2 dependency.
- **Work Log and Live Logs report severity truthfully:** RESULT event type is separated from INFO/WARN/ERROR severity, recoverable states no longer look like hard errors, filters are clearer, and Workspace/Session badges can copy full canonical IDs.
- **Secure MCP Tunnel, Portable, and Recovery are safer:** fresh installs no longer auto-enable persistent reconnect, Recovery adds a 3-day option, bundled `tunnel-client` selection works after clearing a custom override, and stale runtime ownership is cleared only after lnwjud proves no external Tunnel is running.
- **Managed-browser/native foreground coordination is hardened:** `activate_tab`, browser-scoped file upload with Active Project checks, cross-project foreground serialization, and optional postcondition evidence keep native input aligned with the intended tab and target state.

### What's new in v5.7.2

- **Git image diff previews:** the Git page can show before/after images at the real `HEAD → Index` and `Index → Working Tree` scopes, including added/deleted images. Preview payloads are bounded to 4 MB per side, with Fit/Actual Size controls and a clear fallback when Chromium cannot decode a particular image format.
- **Engineering Harness settings persist correctly:** the preload bridge now preserves Harness settings, workspace overrides, and diagnostics, so an enabled Harness no longer appears Off after restarting the app while the saved value is still enabled.
- **Engineering tools are discoverable and Goal-aware:** Engineering Harness primitives are exposed through the tool catalog and bind to the active Goal/lease correctly.
- **Safer rich-text typing:** CDP typing uses native `Input.insertText` for ProseMirror/contenteditable targets and verifies that the DOM actually changed instead of reporting a silent no-op as success.
- **Durable Goal progress stays fresh for Watcher:** lnwjud now instructs every connected worker to checkpoint immediately at step/task/blocker/commit/push/CI/package milestones and at least every 10 minutes during sustained work without a natural milestone, while stale superseded Goals should be reconciled instead of remaining active.
- **Secure MCP Tunnel avoids false Windows Error state:** a temporary PowerShell failure while inventorying local tunnel-client processes/listeners is retried as a transient runtime check instead of permanently flipping an otherwise healthy Tunnel to Error; duplicate/unverifiable process identity checks remain fail-closed.

### What's new in v5.7.1

- **Engineering Harness checkpoint fix:** `checkpoint_goal` now forwards gate updates and review findings to the Goal service. Accepted updates persist in the durable Goal instead of silently leaving the gate state unchanged.

### What's new in v5.7.0

- **Opt in to Engineering Harness:** enable it in Settings and select a preset for coding work. It defaults Off, supports project overrides, and respects existing permissions.
- **Resume substantive work:** Harness reuses durable Goals for plans, intent revisions, checkpoints, acceptance checks, and evidence. Requirement changes stale affected gates while preserving proven work.
- **Guard first-party mutations:** with Harness active, guarded changes require the current engineering task. Scope, permission, recovery, and `goalLease` checks remain in force.
- **Trust the gate status:** pending, failed, stale, or unknown evidence never passes. Local output cannot prove exact-SHA hosted CI or target-native packaging.
- **Keep authorized continuation productive:** workers address actionable failures during the same run. Checkpoints preserve resume context, while live task ownership stays separate from run idempotency.

### What's new in v5.6.6

- **Watcher Goal status is truthful:** an open Durable Goal no longer makes the runtime or orchestrator look busy without an observable in-flight operation. Completed plan steps, acceptance criteria, blockers, and tracked blocking tasks determine whether the Goal is ready for explicit `finish_goal` finalization. No Goal is silently closed just because its checklist reached 100%.
- **Richer read-only Watcher Protocol v1:** active Goal snapshots include completion readiness, phase, bounded objective, acceptance checks, task count, and timestamps. Watcher can show outstanding acceptance checks and detect a quiet open Goal without mistaking a lease heartbeat for progress.
- **Configured plugin names:** Watcher snapshots now include the user-configured MCP server names known to LNWJUD, with connection and lifecycle state. Launch commands, configuration paths, and secrets are never sent. Plugin names from unrelated hosts remain unavailable unless those hosts expose them to LNWJUD.

### What's new in v5.6.5

- **Agent Swarm visibility updates without restarting lnwjud:** enabling or disabling Codex delegation now updates the live MCP tool list. The per-tool `agent_swarm_run` switch still applies, and turning Codex delegation off immediately hides Codex and Agent Swarm tools. Active Desktop HTTP/Tunnel sessions receive the change; local STDIO detects Settings changes written by the Desktop process.
- **Actual invocation verified:** the regression exercises a connected MCP client's `tools/list` and a read-only `agent_swarm_run` list call, not just lnwjud's internal schema registry. The tool remains permission-gated for starting or cancelling a swarm.
- **Simpler setup and recovery:** Settings names both required switches and shows `agent_swarm_run` in its preview. If ChatGPT holds an older app-tool snapshot, refresh or rescan the connected app's tools after saving.
- **Additional fixes since v5.6.4:** Desktop Agent Stop status survives a refresh (#140), and concurrent startup publishes a checkpoint encryption key only after its write finishes (#141).

### What's new in v5.6.4

- **Existing Secure Tunnels recover after restart:** lnwjud updates its local MCP destination when the port changes. On Windows, it checks for an older client using the same lnwjud profile and Tunnel ID and closes it only when its identity can be verified. An unverified client is left alone and shown as an error; restarting Windows is the simple recovery path.
- **ChatGPT setup uses the same Tunnel ID:** choose Tunnel and No authentication for lnwjud's Runtime API key setup. Store the Runtime API key in lnwjud; do not enter it as an OAuth client ID or secret. Refresh an existing connection after updating lnwjud. Secure Tunnel supports private/developer-mode testing, while public plugin submission requires a public HTTPS MCP endpoint.
- **Desktop improvements:** Start/Stop buttons stay disabled while a Tunnel starts, Live Logs preserve event times, and the Git changed-files list grows into available window space.
- **Faster release checks:** CI runs the Windows workspace suite beside the remaining release gate and starts main's target-native package builds beside the test matrix. The aggregate Windows check and exact-SHA release gate still require every result to pass.

Follow the [Thai connection and recovery steps](docs/USAGE_TH.md#5-เชื่อม-lnwjud-เข้ากับ-chatgpt) if ChatGPT still reports a connection error. Remote MCP through ngrok + OAuth is a separate connection method.

### What's new in v5.6.3

v5.6.3 fixes Secure Tunnel no-auth discovery, makes Windows Codex detection resilient to stale PATH state, upgrades the bundled official OpenAI tunnel runtime to v0.0.15, and hardens Recovery storage retention and cleanup.

- **Secure Tunnel discovery contract:** protected-resource metadata candidates now return the empty 404 expected by OpenAI `tunnel-client`'s `sample_mcp_remote_no_auth` profile instead of a `text/plain Not found` body that was parsed as malformed JSON.
- **Verified tunnel-client v0.0.15:** target-native artifacts are pinned by SHA-256 and verified against Sigstore provenance during runtime preparation. The repository dependency workflow keeps checking upstream versions daily; installed clients change bundled tunnel runtime through a normal lnwjud release/update.
- **Codex install fallback on Windows:** discovery checks `%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin` after PATH so the Desktop Requirements view does not falsely report Codex missing when the process inherited a stale environment.
- **Recovery retention includes rotated DB backups:** database snapshots in `retention-archive` now follow the same configured recovery lifetime (30 days by default) instead of accumulating indefinitely.
- **Strict delete-all controls:** Recovery Settings can clear Recovery Trash, checkpoints, or database backups independently after confirmation. Each backend deletes only validated lnwjud-owned recovery artifacts or database rows and preserves unrelated files in those storage roots.
- **CI duplication removed:** process/extensions suites are no longer rerun in each Desktop shard because the same suites remain in the Windows/macOS/Linux native platform contract matrix.

### What's new in v5.6.2

v5.6.2 fixes four reliability issues across the MCP context pipeline, scheduled continuation, and Secure Tunnel UI.

- **Context Economy persists across Modern HTTP requests:** request-scoped MCP server recreation now reuses a transport-scoped Context Economy runtime, so `context_economy_stats` keeps its ledger and repeated context retrievals can produce ledger hits.
- **Binary context stays metadata-only:** `.DS_Store` is ignored by default, and Base64/binary file reads are detected from the file-reader encoding before text-context assembly, preventing long binary payloads from leaking into `workspace_context`.
- **Secure Tunnel transition lock:** Settings now receives the App-level tunnel busy state and disables Start/Stop controls while tunnel start or stop is in flight, preventing repeated-click overlap.
- **Host-safe scheduled claim binding:** Native watchdog wakes can pass their expected `goalId` and `workspaceId` with `claim_scheduled_continuation`; lnwjud validates both identities before liveness or lease mutation while legacy continuation-only callers remain compatible.

### What's new in v5.6.1

v5.6.1 tightens the Watcher integration and fixes the Settings and Git scrolling behavior reported in the Desktop UI.

- **Multi-project / multi-goal Watcher state:** one Protocol v1 snapshot now includes every Active Project, up to 50 active Durable Goals per project, per-project active-operation counts, and per-project sanitized Git state. The existing top-level `goal` and `git` fields remain the selected/primary-project compatibility view for older Watcher clients.
- **More truthful Watcher agent state:** `@lnwjud` is reported independently per active project, and delegated runtime work is tagged with its workspace. LNWJUD also marks observable in-flight tool work as running even when no Durable Goal is active; this still does not claim access to ChatGPT reasoning between tool calls.
- **Last activity age:** Watcher shows the last observed runtime activity time plus a live relative age such as “3 minutes ago” or “2 hours ago”, separate from the transport's last-sync timestamp.
- **Richer Git snapshot:** Watcher receives branch, commit, clean/dirty state, changed-file count, latest commit subject, and latest commit time for every Active Project, while the selected project remains available through the legacy top-level Git view.
- **Pairing page UI:** `http://127.0.0.1:17891/api/v1/pair` renders a local-only copy-friendly Session token page in browsers, while `?format=json` and non-HTML clients preserve the JSON contract. Watcher Web/PWA v0.3.0+ can remember that token for 60 days; packaged Watcher apps keep it in app-local device storage across restarts.
- **Git X/Y scrolling fixed at the ownership boundary:** the Git page no longer nests its content inside a second panel that clips the changed-file list and diff. The page can scroll naturally, the changed-file list owns its bounded scroll area, and Split/Unified Diff panes own real horizontal and vertical scrolling for long files.
- **Settings X/Y scrolling:** Desktop main content owns both horizontal and vertical overflow, nested settings cards no longer clip long content, and the Remote MCP/Secure Tunnel details surface is visually joined instead of behaving like competing nested cards.

### What's new in v5.6.0

v5.6.0 adds the read-only runtime side of **[LNWJUD Watcher](https://github.com/engasnm111/lnwjud-watcher)** and hardens two everyday Desktop workflows: long Git diffs and recurring durable-goal recovery. Users who want the companion Web/PWA, Android or iOS client should start with the Watcher repository for installation, pairing and remote-access setup.

- **Watcher Protocol v1:** authenticated read-only snapshots expose runtime health, the current Durable Goal, milestone states, observable agents/activity and a sanitized Git baseline to the separate Watcher Web/PWA, Android and iOS client.
- **Authenticated realtime readiness:** the Watcher WebSocket is not treated as connected until the runtime validates the token and sends a `ready` acknowledgement. Live activity also triggers a deduplicated authoritative snapshot resync so Goal, Agent and Git state stay current.
- **Pairing and secret boundary:** pairing stays on a separate loopback-only port; production Desktop protects the dedicated Watcher bearer token with purpose-bound secret storage. Watcher exposes no shell, file mutation or MCP command surface.
- **Desktop auto-start:** Watcher API startup/shutdown follows the Desktop runtime lifecycle and remains independent from the MCP gateway and remote-access provider.
- **Git diff X/Y scrolling:** changed-file lists and Split/Unified Diff views use native horizontal and vertical scrolling so long source lines stay readable without squeezing the table.
- **Recurring continuation stale recovery:** an interval `runKey` is idempotency history, not liveness proof. Same-interval retries re-check current worker/blocking-task liveness and may recover a safely stale worker after the bounded grace period while true concurrent duplicates remain fenced.
- **Operator docs:** [LNWJUD Watcher API](docs/WATCHER.md) documents pairing, remote exposure, security boundaries and troubleshooting.

### What's new in v5.5.3

v5.5.3 fixes the recurring Native ChatGPT Scheduled Task connector-binding path so a scheduled wake can reliably resolve the same connected lnwjud connector before claiming durable work.

- **Exact connector identity is carried into new recurring tasks:** when the current chat exposes an `@connector` mention, callers can pass it through `prepare_scheduled_continuation.connectorMention` and the generated task prompt is prefixed with that exact identity.
- **No connector name is assumed:** validation is generic and Unicode-aware rather than tied to `@lnwjud_tunnel_pc` or any other installation-specific name.
- **Prompt injection surface stays bounded:** connector identities must remain a single validated mention token; whitespace/newline injection is rejected.
- **Claim-before-mutation remains mandatory:** scheduled wakes still call `claim_scheduled_continuation` before user-visible prose or workspace mutation, and transport resolution failure does not terminalize the durable goal.
- **Cadence/lease semantics are unchanged:** one hourly recurring host task is still reused, with the normal 600-second worker lease and existing stale-worker recovery rules.
- **Pre-v5.5.3 host tasks keep their stored prompt:** existing Native Scheduled Tasks are not silently rewritten and must be explicitly recreated or updated to receive the new binding.

### What's new in v5.5.2

v5.5.2 fixes continuation-token lifetime at the modern Streamable HTTP transport boundary, including OpenAI Secure MCP Tunnel, without retaining request-scoped MCP server instances.

- **Cross-request continuation works:** `read_file_page_continue`, `workspace_context_continue`, and `workspace_full_scan_continue` can consume the token returned by the immediately preceding request.
- **Transport-scoped, session-keyed state:** only the small bounded continuation stores outlive a request. Raw UUID tokens remain externally opaque; internal lookup is scoped to the MCP session identity.
- **Bounded one-shot semantics remain:** the existing 10-minute TTL, bounded store capacity, and one-shot `take` behavior are unchanged.
- **Per-request teardown remains authoritative:** the modern HTTP path still destroys each request-scoped `McpServer`/`ToolRegistry`, so the earlier listener retention/RAM-growth lifecycle bug is not reintroduced.
- **Real transport regression:** the integration suite proves token creation in one modern HTTP request and continuation in the next for file paging, ranked workspace context, and full workspace scan, plus wrong-session non-consumption.

### What's new in v5.5.1

v5.5.1 is a Windows startup compatibility patch that removes the packaged Electron main process's dependency on a platform-native ZIP binding.

- **Windows 10 startup compatibility:** runtime ZIP extraction now uses pure-JavaScript `unzipper`, removing the native ZIP `.node` binding that could fail at process startup.
- **Cross-platform ZIP behavior stays guarded:** runtime-tool and tunnel-client ZIP extraction use the same implementation, while pre-extraction validation still rejects traversal, absolute paths, symlinks/special files, encrypted entries, oversized expansion, and duplicate/colliding names.
- **Scheduled wake bundle freshness:** all desktop packaging entrypoints rebuild the recursive `@lnwjud/desktop...` workspace dependency graph before Electron packaging, so `packages/application/dist` cannot silently lag source. The packaged recurring-acquisition branch keeps `currentWakeMayReturn: false` and continues work in the same wake.
- **Persistent Tunnel Runtime replacement is fail-safe:** credential-only reconnects preserve the live managed alias until health/readiness/control-plane checks confirm recovery. A running runtime attached to a different Tunnel ID is not automatically retired because the official tunnel client has no proven ready-before-retire overlap primitive; explicit Stop then Start is required and strict zero downtime is not claimed.
- **Durable mutation ownership is unambiguous:** multiple simultaneous live scheduled-continuation owners in one workspace now fail closed with an actionable conflict instead of selecting one by row ordering.
- **What's New viewport centering:** the portal-backed dialog overlay centers both axes while preserving bounded viewport height, internal scrolling, focus trap, initial focus, Escape close, ARIA semantics, and focus restoration.

### What's new in v5.5.0

v5.5.0 combines the Office Suite, in-app What's New, scheduled-continuation reliability work, connection-resilience improvements, additive Remote MCP transports, and tunnel startup continuity for previously connected users.

- **Semantic Office Suite:** Word, Excel, PowerPoint, Outlook, Calendar, Contacts and Tasks route through one provider-aware runtime. Windows COM readiness is action-level, optional/local/cloud providers fail closed when no verified implementation exists, Graph remains unavailable until real OAuth/provider acceptance exists, and legacy Office aliases remain supported.
- **Office mutation/recovery:** Active Project, dry-run, mutation classification, pre-image recovery and dangerous-action confirmation stay in force. Macro execution stays disabled/unsupported; sending mail or invitations remains confirmation-gated.
- **Real Windows Office acceptance:** `scripts/verify-office-provider.ps1` creates only synthetic `.local-artifacts`, logs every action, enforces bounded per-action timeouts, verifies Word/Excel/PowerPoint create-edit-export workflows, and checks for new orphan Word/Excel/PowerPoint processes. Outlook proceeds into bounded no-send folder/message/draft checks only when its COM status probe proves ready; otherwise the harness records degraded Outlook readiness and skips mailbox mutation. See [Office Suite v5.5.0](docs/OFFICE_SUITE.md).
- **What's New:** a separate `?` beside the version opens exact-version bundled Thai/English notes with keyboard/focus accessibility, while the existing version/update button keeps its original update behavior. See [What's New maintenance](docs/development/WHATS_NEW.md).
- **Scheduled continuation:** wake prompts bind to the connected lnwjud connector, claim before prose/mutation, recover eligible stale workers in the same recurring firing, and do not create/retime replacement recurring tasks on ordinary wakes. Managed-task liveness reads are bounded and fail closed to `unknown`, preventing a non-responsive task provider from hanging `claim_scheduled_continuation` indefinitely or permitting unsafe lease takeover.
- **Long-running connector resilience:** MCP tool calls emit best-effort progress keepalives after 8 seconds and every 8 seconds while still running, reducing idle periods through the connector path without pretending to control browser/network response-stream failures outside lnwjud.
- **Reconnect-result recovery:** after a ChatGPT page/client interruption or missing assistant summary, `session_handoff` reads the active goal or latest terminal Durable Goal and bounded recent durable-task status/output tails. Terminal work is reported from persisted receipts instead of being relaunched merely to recreate the missing summary; task observation remains workspace/session scoped.
- **Search/edit recovery:** `search_text` defaults to ripgrep fixed-string matching, with regex semantics available only through explicit `regex: true`; malformed explicit regex/glob input returns a recoverable structured error. `edit_file` remains exact-only and never fuzzy-edits automatically, but conflict responses now identify multiple/stale/not-found cases, detect CRLF/LF or whitespace drift, include bounded nearby context when available, and suggest re-read/retry.
- **Remote MCP transports:** ngrok remains the default/backward-compatible mode. Cloudflare and Custom URL use an externally managed public HTTPS reverse proxy to a stable protected loopback gateway; Local MCP starts without ngrok/public OAuth. OpenAI Secure MCP Tunnel, OAuth/API-key tunnel flows and Persistent Tunnel Runtime remain separate and supported.
- **Tunnel startup continuity:** a previously configured and started Secure MCP Tunnel starts automatically when lnwjud opens while Persistent Tunnel Runtime remains enabled. First-time setup stays manual, and an explicit Stop remains stopped across app restarts until Start Tunnel is pressed again.
- **DCR/ngrok reliability:** pending Dynamic Client Registration is persisted before registration success so restart-before-authorize does not become `invalid_client`; schema v3 preserves existing trusted clients/refresh grants, and stale ngrok cleanup is limited to processes proven lnwjud-owned.

### What's new in v5.4.3

- **Remote MCP public OAuth boundary hardened:** unauthenticated dynamic registrations and transient OAuth state are bounded, expired state is pruned, and first-use ChatGPT-compatible OAuth clients require an explicit local approval instead of treating redirect-URI shape as identity.
- **Release supply chain is immutable:** privileged third-party GitHub Actions used for release publication and cosign setup are pinned to full commit SHAs, with a repository hygiene regression preventing mutable third-party action tags from returning.
- **PDF archive extraction is containment-safe:** the vulnerable production `extract-zip@2.0.1` path is removed. Archive validation rejects path traversal, absolute paths, symlink/special-file entries, encrypted entries, and duplicate/colliding names before extraction; `pnpm audit --prod` is clean.
- **Multi-file mutations are all-or-rollback:** `apply_patch` and checkpoint restore automatically restore earlier writes when a later write or cancellation fails, and report explicit rollback failure details instead of silently leaving a mixed tree.
- **Workspace writes revalidate at publication time:** guarded writes detect symlink/junction/path swaps between initial validation and the final atomic rename, strengthening the workspace boundary against TOCTOU races.
- **Dashboard idle work is reduced:** the full dashboard snapshot no longer rebuilds every 2 seconds. A 30-second reconciliation fallback is combined with focus/visibility wakeups and immediate refresh after explicit user actions.
- **Durable checkpoints now carry reconstruction-grade resume state:** milestone checkpoints can atomically persist changed files, exact command outcomes, decisions, failed attempts, pending validation, resume prerequisites, state facts, and artifacts. `session_handoff` prefers this checkpoint resume context before Git diff or legacy trackers and surfaces acceptance/checkpoint evidence plus tracked task IDs so a new worker can continue without guessing.
- **Roadmap drafts stay out of product commits:** `docs/roadmap/` is ignored for new draft plans; historical tracked roadmap documents remain historical Git content.

### Historical: What's new in v5.4.2

- **Remote MCP follows and recovers the live Local MCP endpoint:** the Remote MCP gateway no longer captures one Local MCP URL when it starts. Every authorized `/mcp` request ensures the Desktop listener is available and then proxies to its current URL, so automatic-port restart/rebind or transient listener loss continues through the existing public OAuth/ngrok endpoint. If the local listener cannot be started, the gateway returns `503 local_mcp_unavailable`.
- **Remote MCP automatic recovery is single-flight:** unexpected owned ngrok exits schedule automatic reconnect with 2-second exponential backoff capped at 30 seconds. Explicit Stop, Desktop close, and OAuth trust reset cancel pending retries. Manual start, startup auto-start, and reconnect callbacks share one in-flight start operation, preventing overlapping gateway/ngrok creation.
- **ChatGPT-side developer-MCP failures are separated from local permissions:** the Settings connection card now documents the host boundary for “conversation does not support developer MCPs” and empty plugin/tool states when Remote MCP itself is online, avoiding a false conclusion that Windows denied local file access.
- **File-target search and ripgrep error classification:** `search_text` can target one file while keeping ripgrep's cwd at its parent directory. Access-denied/EACCES/EPERM failures are recoverable `PERMISSION_DENIED`; recognized regex/glob syntax errors remain non-recoverable `INVALID_INPUT`; unrecognized process failures remain recoverable `INTERNAL_ERROR`.
- **Persistent redacted internal diagnostics:** unexpected application exceptions still return the generic external `Operation failed` error, but the sanitized diagnostic event is now also flattened/redacted into persistent activity/audit detail so operators can diagnose faults without exposing bearer tokens or other credential text.
- **Persistent tunnel setup/runtime intent hardening:** first-run profile creation no longer gets blocked by a previously started persistent tunnel runtime, and profile configuration preserves the saved `running` / `stopped` desired state rather than implicitly starting a runtime the user had stopped.
- **Durable shell PID reuse and ownership races fixed:** reconciliation uses captured process start identity to distinguish a reused PID, waits a bounded interval for worker-owned terminal metadata, and reports unresolved probe uncertainty without overwriting an already-completing durable result. Strict process-tree identity verification remains in force for cancellation/kill operations.
- **Windows test contention hardening:** `@lnwjud/application` now runs Vitest files with file-level parallelism disabled, matching the existing policy for other filesystem/process/SQLite-heavy packages while preserving existing timeout values.
- **Issue #114 / Windows PowerShell 5.1 native-input compatibility:** `type_text` and `paste_text` enumerate `ToCharArray()` explicitly, and hotkey modifier release uses `[array]::Reverse` with `finally` cleanup rather than the PowerShell-7-only `Select-Object -Reverse` switch.
- **Release accounting:** v5.4.2 packages the post-v5.4.1 hardening above and closes Issue #114. Issue #104 remains associated with v5.4.1.

### Historical: What's new in v5.4.1

- **Issue #104 — Windows MCP localhost, reverse-proxy Host handling, and silent update path:** the loopback HTTP server was hardened for Windows localhost/IPv6 behavior; external hostnames can be explicitly allowed for reverse-proxy/tunnel scenarios instead of depending on manual Host rewriting; and the Windows installer/updater path was hardened against the silent `old-uninstaller.exe` stall reported against v5.3.1.
- **Automatic MCP port selection:** the default local MCP port is now automatic so end users are not asked to understand or manually choose a port during normal setup. lnwjud selects a free port to avoid collisions and preserves an advanced/manual fixed-port override for integrations that require one.
- **Managed browser lifecycle:** browser/CDP support is lazy-started on first use instead of launching Chrome as part of ordinary Desktop startup. Runtime readiness/Doctor state follows that lazy model, so an unused browser dependency does not block unrelated tools while navigation remains available when requested.
- **Shared browser-start cancellation isolation:** concurrent `ensureStarted` callers retain single-flight launch behavior, but each caller owns only its own wait cancellation; aborting one request no longer tears down the shared launch needed by another active request.
- **Global install/update activity coordinator:** app updates, ngrok install/update, and PDF Provider installation feed a shared install-activity coordinator with preparing/downloading/verifying/installing/finalizing phases. Desktop renders a blocking progress modal while these operations are active, preventing conflicting clicks and making long install steps visibly distinct from an application hang.
- **Application/storage seam cleanup:** automation and Agent Swarm services were moved onto domain-owned repository contracts so application code no longer imports concrete storage adapters. Packaging coverage now guards this dependency direction.
- **Release/CI dependency correctness:** Desktop CI builds the actual CLI dependency closure used by the packaged runtime, strengthening release verification against stale prebuilt workspace output.
- **Transient native package download hardening:** `package-native.mjs` retries `electron-builder` up to three attempts only when recent output matches a bounded set of transient network failures (connection reset, timeout, DNS/socket/network interruption). Deterministic packaging/configuration errors still fail on the first attempt. This directly hardens the GitHub release-asset download path that failed Linux x64 main CI during v5.4.1 release preparation.
- **Windows release-test contention fix:** the `@lnwjud/mcp-server` Vitest files are executed with file-level parallelism disabled in the package test command. The default per-test timeout remains 5 seconds; no timeout was relaxed. The two filesystem-heavy tests that timed out under Windows runner contention complete in tens/hundreds of milliseconds when the files are not competing for I/O.
- **Current-chat lnwjud routing:** MCP server instructions now state that supported coding/repository/filesystem/shell/build/test/Git/CI/browser/local-computer work should continue through the exposed lnwjud tools in the current conversation. The contract is capability-based and connector-name agnostic; a regression explicitly prevents hardcoding the local instance name `lnwjud_o`.
- **Published verification evidence:** local validation passed syntax, targeted packaging regression, lint, typecheck, the full 67-file/1050-test `mcp-server` suite, and the 23-test release gate without increasing test timeouts. PR #108 then passed push CI, required Windows authoritative release verification, and GitHub Advanced Security. Final main CI `35584627254` succeeded on commit `e8d26d45953dd13a77559ab0303ad7b7ee022653`, including macOS x64/arm64, Linux x64/arm64 native package verification and macOS 26 compatibility. Release workflow `35586799494` downloaded those exact successful-CI artifacts, re-verified every provenance bundle, aggregated update feeds/manifests, generated release notes, and published v5.4.1 successfully.
- **Issue closure accounting:** v5.4.1 closes [Issue #104](https://github.com/engasnm111/lnwjud/issues/104). Issues #100, #98, and #94 belong to earlier published release lines and are intentionally not re-counted as v5.4.1 closures.

### What's new in v5.4.0

- Native Goal automation is now durable across restart: automation plans, runs, attempts, milestone verification evidence, scheduled wake hints, and exact shell-dispatch recovery are persisted and bound to the owning Goal/workspace/lease.
- Issue #100 is fixed by replacing historical durable-shell launch scans with indexed active-task state plus bounded history reads, preventing latency from growing with months of completed background-task history.
- Automation terminal handling is crash-safe at the Goal boundary: finalize can reconcile `completing` after the root Goal has committed, cancellation linearizes root cancellation before local terminal state, and both paths have direct fault-injection coverage.
- `automation_finalize` is treated as a destructive/opaque mutation because it can stop Goal-owned in-flight requests/tasks. Paused automations no longer receive an `advance` wake hint, and Windows verbatim-argument mode is included in immutable automation dispatch identity and runtime validation.
- The release pipeline publishes only verified target-native artifacts from the exact successful main CI commit: Windows x64 Setup/Portable, macOS arm64/x64 DMG+ZIP, and Linux arm64/x64 AppImage+DEB, together with update feeds, per-target provenance, `RELEASE_MANIFEST.json`, and SHA-256 evidence.
- The Settings Factory Reset action spacing/layout cleanup is included in the published desktop package.

### Historical: What's new in v5.3.1

- Browser CDP navigation now has a dedicated `Page.navigate` decoder instead of passing the method through the `Runtime.evaluate` value reader. Successful requests return a structured acknowledgement containing the requested/complete state plus frame/loader/download fields when present; protocol errors, `errorText`, malformed responses, protected-tab authorization, and raw-error sanitization remain guarded. This resolves Issue #98 where navigation could succeed in Chrome but fail MCP output validation because `structuredContent` was missing.
- Desktop log/session history persists across application restart and is presented with human-readable timestamps. Work Log and Live Log share scope formatting, workspace filters show project name + real path, and clearing a session/workspace/all history also removes any historical entries already loaded in renderer state.
- Factory Reset is staged across restart, clears lnwjud databases/settings/keys/backups/cache/recovery state, and returns to the first-run setup flow without deleting user project directories. Tunnel cleanup now removes only lnwjud-owned artifacts from the shared tunnel-client directory and preserves unrelated profiles/files.
- The first-run and Settings connection UX now calls out ChatGPT Plugin Developer mode and provides direct entry points for ChatGPT Plugins, tunnel creation/settings, Runtime API keys, and ngrok setup. OAuth-connected states avoid redundant API-key guidance.
- Text inputs no longer lose focus after each character during dashboard refresh. Startup LogHub replay drains the bounded historical tail in one synchronization pass rather than advancing only 64 KiB every 500 ms, avoiding multi-second catch-up delays after restart.
- Activity-session summaries are loaded from persistent audit history once and then updated incrementally as new MCP activity arrives, removing the unbounded `GROUP BY` audit scan from the 2-second dashboard refresh loop.
- Shared skill routing centralizes intent-based skill selection/preflight so Serena and other skills follow one runtime path. The release also retains the v5.3.0 MCP lifecycle/RAM-leak and crash-diagnostic hardening.
- GitHub Actions checkout/setup-node runtimes were moved to their Node 24-capable major versions. The optional Dev Windows Installer workflow is now `workflow_dispatch` only; ordinary `dev` pushes never build or upload installer artifacts unless a maintainer manually dispatches that workflow.

### Historical: What's new in v5.3.0

- Issue #94's catastrophic RAM growth is fixed at the causal lifecycle boundary: every successful modern HTTP request now closes its per-request `McpServer`, and `toolAvailabilityService` subscriptions are released from both product-level and underlying protocol close paths so completed requests cannot retain `ToolRegistry`, schemas, and closures.
- Context/file pagination continuations now have bounded retention and expiry as secondary memory hardening; the direct regression repeatedly serves modern requests and requires tool-availability listener creation/closure to remain balanced.
- Desktop crash/session diagnostics persist a bounded heartbeat state across restart. A recent unclean previous session is classified only when stronger current local-tool/tunnel failure evidence is absent, so an old crash does not dominate unrelated later incidents. Local-only Crashpad metadata uses bounded dump retention and reports main/renderer/GPU/utility process memory evidence without exporting raw heap dumps. A local bounded runtime history samples once per minute and retains at most 360 samples (about six hours), including main RSS/V8 heap/external/ArrayBuffer memory, total and per-Electron-process-type working/private bytes and CPU, system free/total RAM, event-loop utilization, active Node resource-type counts, retained LogHub line/byte/dedupe counters, MCP call/error/in-flight telemetry, and the live `toolAvailabilityService` listener count.
- The Desktop source target uses Electron `45.0.0-alpha.7` for v5.3.0 so the packaged Windows runtime carries `electron_wer.dll` alongside local-only Crashpad/session diagnostics. Crash reports remain local and bounded with uploads disabled. The async clipboard integration remains covered by the Desktop typecheck/build on this runtime.

### Historical: What's new in v5.2.1

- Git status uses normal untracked reporting, so an untracked directory is represented once instead of expanding every descendant. Dashboard summaries use Git numstat only and defer bounded untracked-file reads until the user opens that file's diff.
- Backup-manifest and portable-scheduler discovery process filesystem-derived lists without unbounded concurrent reads.
- Git and automatic context discovery ignore `artifacts/` alongside existing build/cache directories, while explicit reads remain available.
- The v5.2.1 runtime contract contained **253 total MCP tool definitions**, with **241 advertised by default** and **all 253 advertised when Codex Delegation plus Agent Swarm is enabled**.

### Historical: What's new in v5.2.0

- Remote MCP no longer converts an ngrok URL observed at runtime into persistent launch configuration. A reserved Static/Custom Domain is now explicit configuration, schema-v1 learned origins migrate without pinning, and `--url` is omitted when no domain was deliberately configured.
- Incident capture now carries a bounded, sanitized tail of persisted desktop crash/lifecycle history across restarts.
- The External MCP idle sweeper no longer wedges when its first pass runs before the session deadline; a deterministic regression now proves the next pass closes the idle session, strengthening the reported main-process CPU/idle cleanup path.

### Release details

The v5.2.0 runtime contract contained **253 total MCP tool definitions**,
with **241 advertised by default** and **all 253 advertised when Codex Delegation
plus Agent Swarm is enabled**. The 12 Codex-backed delegation front doors are opt-in;
the default surface still exposes every other current first-party definition. The earlier v4/v5 tool-count snapshots remain
historical compatibility baselines rather than the current release contract.

### Historical: What's new in v5.1.1

- The MCP idle sweeper now skips a settled connection queue during close and waits only when a call is actually in flight, preventing intermittent Serena/External MCP processes from surviving their idle deadline while preserving bounded shutdown grace for active calls.

### Historical: What's new in v5.1.0

- Completed process history is capped at 32 terminal records, each completed output buffer keeps only its newest 256 KiB, and stale service/Desktop ownership entries are removed after the underlying process disappears.
- Live Logs strip terminal ANSI/VT control sequences at shared log and audit-detail boundaries before rendering, copy, or export. Every main-process source now has both an 8 KiB per-line ceiling and an 8 MiB retained-byte budget, while each renderer window has a 24 MiB serialized-payload budget.
- External MCP lifecycle is in-flight aware and reconciles settings immediately: pending connects are aborted during shutdown, POSIX stdio runs under an owned `setsid` process group, Windows uses verified `taskkill /T /F`, stale sessions are disconnected on config changes, and `mcp_list`/Doctor surface `termination_unverified` when the tree cannot be proven gone. A ten-cycle production stdio soak is included; target-native package gates remain the evidence boundary for an every-architecture claim.

### Historical: What's new in v5.0.2

- Codex Delegation OFF now makes all Codex-backed entry points system-ineligible: the six `codex_*` tools, `agent_swarm_run`, `delegate`, `delegate_status`, `delegate_cancel`, `delegate_result`, and `parallel_delegate`.
- Per-tool availability overrides cannot re-enable those tools while Codex Delegation is OFF, and Desktop readiness uses the same shared classifier as the MCP registry.
- The v5.0.2 registry remains 253 total definitions, advertises 241 by default, and advertises all 253 when Codex Delegation plus Agent Swarm is enabled.

### Historical: What's new in v5.0.1

- Tunnel incident exports move to schema v2 and preserve sanitized process-exit, restart, OAuth-refresh, transport/network, client-version, and tunnel-log evidence for real disconnect diagnosis.
- Persistent tunnel supervision records restart attempts/outcomes and last known process identity; native-managed runtimes report unavailable exit metadata explicitly instead of inventing it.
- Windows tunnel-client version inspection falls back to `--version` when executable file metadata is unavailable.
- UI/log copy and incident evidence share the Asia/Bangkok 24-hour timestamp contract, while incident JSON carries explicit timezone and offset-aware timestamps.

### Historical: What's new in v5.0.0

- Durable Goal state now exposes a user-facing plan projection, explicit acceptance criteria/evidence, and completion gates.
- `userIntentRevision` makes newer accepted user steering authoritative and retires stale non-terminal generated delivery work.
- Durable delivery receipts model reserved, attempted, ambiguous-dispatch, confirmed, completed, cancelled, and retired states without blind retry.
- Context Capsules persist bounded immutable compact/resume summaries including objective, steering, completed/remaining work, decisions, validation, changed files, artifacts, blockers, and next action; they never store private chain-of-thought.
- `session_handoff` prioritizes Durable Goal + latest Context Capsule, then Git/workspace state, with the old phase tracker only as optional fallback.
- ChatGPT continuation remains host-native: lnwjud never uses browser/DOM clicking, typing, scraping, or automatic new-chat creation as the compact/resume transport.
- Bounded iteration has explicit limits and stale-intent fencing, while context pressure is reported as an estimate unless the provider exposes exact usage.
- Settings multiline fields preserve draft newlines, and `LSP Commands — LANGUAGE=COMMAND` accepts incomplete draft text such as `typescript=` until validation/save.
- The v5 release registry has 253 definitions, 241 advertised by default, and all 253 with Codex delegation plus Agent Swarm enabled.

### Historical: What's new in v4.70.1

- Work Log and Live Logs progressively render bounded batches while scrolling, and Recovery Trash/checkpoint/backup lists use the same pattern to avoid mounting large histories at once.
- Desktop startup begins a fresh visible log session while preserving SQLite audit history and existing file-backed log history; old tunnel/MCP file bytes are no longer replayed into the new UI session.
- Work Log and Live Log exports default to `.log` with optional `.txt`, structured headers, numbered records, localized readable fields, spacing, and retained technical metadata/full target detail.
- Persistent Tunnel Runtime is grouped inside the Tunnel settings block so Remote MCP & Tunnel presents OAuth and Tunnel as the two top-level connection methods.

### Historical: What's new in v4.70.0

- Full ECC provider integration inventories and selectively loads pinned ECC agents, skills, command shims, layered rules, hooks, workflows, MCP templates, instincts, and resources while lnwjud remains the permission/security/durable-goal authority.
- ECC Memory Vault support exposes create-only unreviewed `ecc.memory.v1` save/search/read/doctor operations with bounded lexical retrieval, completeness checks, explicit user-scope opt-in, and no automatic policy promotion.
- AgentShield is bundled at the pinned runtime version and exposed through a bounded JSON-only security scan that cannot auto-fix, widen network scope, or execute imported ECC hooks/workflows.
- Native Windows/macOS/Linux packages materialize ECC and AgentShield into verified app resources with third-party notices, license evidence, and SHA-256 provenance instead of relying on ambient global installations.
- The v4.70.0 MCP contract contained 242 total tool definitions, 235 advertised by default, and all 242 with Codex delegation plus Agent Swarm enabled.

### Historical: What's new in v4.62.2

- Doctor treats Secure MCP Tunnel as not applicable when OAuth-protected Remote MCP is the active remote transport, so unused tunnel runtime/auth/health checks no longer appear as errors.
- Community macOS packages use dedicated ad-hoc Electron entitlements: hardened runtime remains enabled while `disable-library-validation` is scoped to Electron main/helper process signatures. Developer ID mode retains normal Library Validation and one Team ID.
- CI keeps macOS 15 as the package-build floor and reuses the exact produced DMG/ZIP bytes on `macos-26` (arm64) and `macos-26-intel` (x64) for provenance, signing-policy, LaunchServices, and packaged-app smoke verification.
- Ponytail FULL recognizes the canonical bundled `skills_read` response as activation evidence when it carries the active workspace/goal scope, eliminating the repeated load-then-block loop shown in Work Log.
- The previously uncommitted cross-platform capture/computer-use delta is carried forward: native window/display capture, DPI-aware coordinate mapping, Electron capture fallback, and MCP image delivery are included rather than left as a dirty local-only change.

### Historical: What's new in v4.62.1

- Preserves real External MCP child-tool errors through the SDK boundary by issuing raw `tools/call` requests instead of SDK `callTool` output validation; `isError: true` results reach lnwjud unchanged while successful structured output and the MCP result envelope remain validated, including a regression for the exact Issue #53 failure path.
- Delivers native Vision screenshots as first-class MCP image content while removing duplicate Base64 blobs from the parallel text/structured metadata representation.
- Validates Windows Vision PNG bytes before returning them, includes byte-length/SHA-256 integrity metadata, and fails closed in the MCP result mapper on malformed/truncated/dimension- or checksum-mismatched image payloads.
- Keeps Work Log and Live Logs search stable while live dashboard polling continues by freezing workspace metadata together with the row/line snapshot; background refreshes no longer retrigger full-detail search or alternate the UI between results, loading, and empty states.
- Preserves External MCP child `CallToolResult` image/text blocks through `mcp_call` so screenshot-producing Serena/custom MCP tools reach the calling model as actual image content rather than flattened JSON.
- Makes Windows `vision:capture_window` resolve natural app-name selectors to a visible non-minimized HWND when an app exposes multiple helper windows, while returning explicit window-state errors instead of generic `Operation failed` failures.
- Keeps explicit Tunnel Stop intent authoritative over Auto Reconnect: a stopped runtime no longer flips to an unrelated duplicate-start error merely because an external liveness probe is temporarily unverifiable, while a later explicit Start still refuses to launch a possible duplicate.
- Keeps expected managed-runtime warm-up retries out of the red Home error surface: the UI remains in its normal starting state until the Tunnel is ready, while real terminal/operator errors still render as alerts.
- Removes legacy manual-code consent from the ChatGPT Business custom-app path without trusting a public callback URI by itself: exact supported `chatgpt.com` OAuth callbacks are completed through DCR + Authorization Code + PKCE plus a one-time browser handoff to an ephemeral `127.0.0.1` Desktop approval listener; unsupported or spoofed redirects fail closed with `403 access_denied`.
- Simplifies Home around one **ChatGPT Connection** surface: Remote MCP OAuth is the primary path, Secure MCP Tunnel is nested as an advanced option, disruptive Desktop Agent actions move into an overflow menu, the sidebar reports `Desktop Agent · <OS>`, and the redundant `MODE / WORK` card is removed.
- Protects the Remote MCP public HTTPS origin across Desktop restarts and upgrades by using ngrok's assigned development domain, remembering the first observed origin in encrypted Remote MCP state, and reusing it through ngrok `--url` on later starts instead of silently changing the ChatGPT endpoint. A purchased/custom domain is not required; custom domains remain optional. Re-saving the ngrok authtoken deliberately clears the remembered origin so an intentional account/domain change can be learned safely.
- Hardens Secure Tunnel for simultaneous chats by explicitly setting `MCP_MAX_CONCURRENT_REQUESTS=32` instead of tunnel-client's default 10 and by exercising three real MCP sessions with a 12-request concurrent burst on the shared Desktop listener. Multiple chats on one lnwjud host share the same Tunnel normally; independently targetable Mac/Windows hosts should use distinct Tunnel IDs/ChatGPT connections because HTTP replicas sharing one Tunnel ID receive queued work from whichever replica polls first.
- Changes Recovery Trash/checkpoint automatic cleanup so users who have **never configured retention** start at 30 days, while every existing saved choice—including `Never` (`0`)—remains unchanged.
- Added ad-hoc normalization and mixed-Team-ID rejection for macOS packaging. Issue #59 later showed that v4.62.1 still failed on macOS 26 because an ad-hoc Electron process had no shared Developer Team ID for Library Validation; v4.62.2 supersedes this behavior with scoped ad-hoc entitlements plus an exact-artifact macOS 26 gate.
- Adds mapper, External MCP bridge, MCP HTTP transport, and Windows native bridge regressions for image-content delivery and window targeting.

### Historical: What's new in v4.61.0

- Freezes Work Log and every Live Logs tab to a stable snapshot while search text is active so new events cannot insert themselves into or reorder the list during inspection. Clearing search resumes the newest live feed; Live Logs Pause/Follow uses the same freeze contract instead of only suppressing auto-scroll.
- Finalizes durable shell tasks from the direct command's terminal state with bounded stdio draining, preventing detached descendants with inherited pipes from leaving completed work reported as running.
- Fences External MCP shutdown against pending child connections so a child that finishes connecting after `McpSessionManager.close()` is closed rather than registered again.
- Makes Windows Event Log runtime-contract verification deterministic and translates supported Windows working directories for WSL execution.
- Hardens secret recovery, SQLite close ownership, tunnel terminal/restart deduplication, Doctor applicability, and bounded/path-guarded Git diff behavior.
- Expands the v4.56.2 External MCP, timestamp, and responsiveness fixes into a broader Windows/macOS/Linux hardening pass.
- Adds the native Ponytail coding policy with `OFF / LITE / FULL / ULTRA` modes (default OFF), `Current Goal > Workspace > Global` resolution, exact bundled-skill activation before code mutation, matcher-independent loading, session-only suppression, and fresh bundled review enforcement for FULL/ULTRA durable coding-goal completion. Full Bypass remains an authorization mode and does not bypass this correctness gate.
- Selects bundled runtime dependencies by exact platform/architecture tuple, updates the official OpenAI `tunnel-client` to `0.0.14`, keeps ripgrep at `15.2.0`, and updates the Windows Poppler package to `26.07.0-0`, with pinned verification and fail-closed packaging.
- Hardens macOS package verification around the real DMG install boundary, LaunchServices startup, nested code signing, Team-Identifier expectations for Developer ID builds, and ad-hoc development signing semantics.
- Makes ngrok detection/runtime handling cross-platform while exposing automatic installation only where lnwjud has a verified host installer path; unsupported installer actions are hidden instead of presented as working.
- Audits MCP discovery/config naming, recovery/checkpoint/backup paths, secure-storage boundaries, tunnel profile paths, executable resolution, browser/CDP paths, and tool/provider composition for target-platform semantics.
- Extends deterministic cross-platform release scenarios beyond the original 100-case baseline to a growing 350+ scenario suite, in addition to full workspace, packaging, release-gate, and native CI validation.

### Historical: What's new in v4.56.2

- Fixes External MCP protocol compatibility by auto-negotiating child-server protocol versions instead of requiring every external server to support MCP `2026-07-28`; legacy/2025-era servers such as Serena and modern `2026-07-28` servers are both covered by real stdio regression tests.
- Keeps lnwjud's own inbound/local MCP `2026-07-28` contract unchanged. A successful External MCP connection plus `tools/list` discovery is shown as ready at the transport/catalog layer, while child-server permission, profile, cancellation, and dry-run metadata remain undeclared/unverified; `mcp_call` remains an opaque dangerous boundary under the existing approval policy.
- Standardizes user-facing timestamps across Desktop UI, copied/exported Live Logs, Work Log details, Doctor, Recovery, Settings, and related surfaces using the selected Thai/English locale while preserving raw machine timestamps internally.
- Hardens Desktop responsiveness under heavy search/log traffic: ripgrep output capture is bounded and stops after enough results are collected, while renderer log events are de-duplicated, retained within fixed limits, and flushed in batches instead of copying the full log buffer for every event.
- Adds regression coverage for high-volume search termination, bounded log buffering, timestamp formatting, real legacy/modern External MCP stdio negotiation, and a real installed-Serena smoke check during release preparation.

### What's new in v4.56.1

- Fixes Windows startup after upgrading a profile with legacy DPAPI/SecureString secrets: the native migrator now reads the checksum filename actually shipped in the installer.
- Preserves integrity verification, existing encrypted data, and migration backups. Adds native-helper and real legacy-profile startup regression tests.
- Keeps macOS/Linux on the shared release version; Windows migration remains a no-op on those platforms.
- If v4.56.0 cannot open to update itself, install v4.56.1 manually over the existing installation. Do not delete the profile or secret files. A narrowly scoped v4.56.0 recovery script is available at `scripts/repair-windows-4.56.0-startup.ps1`.

### What's new in v4.56.0

#### Target-native macOS/Linux release foundation

- Adds target-native macOS and Linux Desktop packaging for arm64/x64 where the native host, runtime tools, Secure MCP Tunnel client, launcher, permissions, and release evidence are built and verified on the target operating system.
- Keeps Windows Setup and Portable packaging in the same release contract while moving secret persistence to Electron secure storage and isolating legacy Windows migration in a native helper.
- Publishes one exact-commit release set with per-target provenance and SHA-256 evidence, Linux architecture-specific updater feeds, and a merged macOS feed that selects the correct zip for Intel or Apple silicon.
- Reports Windows-only WSL, Registry, Sandbox, Outlook/COM, and PDF provider surfaces as unsupported on macOS/Linux instead of emulating them with an unsafe fallback.

#### Remote MCP OAuth / ChatGPT DCR compatibility hotfix

- Carries forward the v4.55.1 ChatGPT OAuth Dynamic Client Registration fix in the v4.56.0 release candidate.
- Accepts ChatGPT-style client metadata, including public clients and `client_secret_post`, and validates the generated client secret at the token endpoint.
- Returns explicit OAuth 4xx metadata/redirect errors for malformed or unsupported registration requests instead of an internal-server failure, with regression coverage for Authorization Code + PKCE.

### What's new in v4.55.0

#### Comprehensive runtime hardening

- Tool contracts now use strict per-tool input schemas, structured output schemas, modern annotations, and one authoritative registry projection across MCP registration, discovery, Doctor, schema inspection, and generated documentation.
- Modern MCP Tasks extension support (`io.modelcontextprotocol/tasks`) maps eligible long-running work to stable task lifecycle semantics while keeping legacy core Tasks isolated to negotiated legacy clients.
- Batch/delegate execution now uses bounded concurrency, deterministic per-item outcomes, cancellation propagation, and partial-failure isolation instead of allowing one sibling failure to collapse unrelated successful work.
- Cache/context-economy accounting, catalog/index invalidation, per-tool telemetry, and W3C trace context are unified so runtime metrics reflect actual work rather than disconnected counters.
- External MCP/plugin/skill trust boundaries now carry collision-safe provenance, launch/catalog fingerprints and drift evidence; declared external output schemas are preserved and structured output is rejected when it violates the advertised contract.
- Routing/index freshness, browser/native/document/database/sandbox capability contracts, Desktop Tools/Doctor readiness, and Windows/macOS/Linux provider boundaries now report support and setup state truthfully instead of implying unavailable native features exist everywhere.
- Durable continuation now has explicit regression coverage for the reported ghost-worker case: an empty process/task view with no live fenced call is trustworthy inactivity, stale recurring leases recover in the same hourly tick after the bounded grace, and lease generation rotation prevents the old worker from mutating later.
- Work Log and Live Logs keep canonical UTC instants while rendering in the host's actual local timezone; regression coverage verifies multiple timezones, DST transitions, and absolute ordering when local clock labels repeat.

### What's new in v4.54.0

#### Recoverable Native Scheduled Task cleanup

- Durable-goal completion now treats the Native ChatGPT Scheduled Task cleanup as a first-class obligation. When a live watchdog exists, lnwjud requests cleanup **before** `finish_goal`; `get_goal` can also recover the exact pending cleanup locator after a turn/host-surface interruption instead of losing access to the task that must be closed.
- Terminal/cancelled goals with unresolved watchdog cleanup enter a cleanup-only wake path. That wake cannot reacquire authority to resume workspace mutations, and the goal is not reported complete until the exact native task is proven non-runnable.
- Native host deletion is preferred; a host-confirmed disable/pause is accepted only when it proves the exact task is non-runnable. If the user manually deletes the exact Scheduled Task from ChatGPT, lnwjud can record explicit **user-attested manual deletion** with real user confirmation without pretending it was host-native evidence.

#### Per-tool enable/disable with live MCP propagation

- Every first-party tool now has a persisted user exposure preference (`default`, `enabled`, or `disabled`) that is independent from runtime readiness and permission policy. Disabled tools remain visible in the Desktop Tool Catalog for recovery, but disappear from `tools/list` and are denied for new execution, including direct registry calls, `tool_batch`, and tool discovery/ranking paths.
- Long-lived MCP servers keep canonical SDK registrations and toggle the existing `RegisteredTool` handles live. MCP clients that honor `notifications/tools/list_changed` can see the new list without rebuilding the server or restarting the Desktop/stdio runtime; cross-process stdio observes the same persisted state through bounded polling.
- The Tools page exposes Enabled/Disabled controls and filtering while keeping readiness separate, but **hard Settings/runtime prerequisites always win**. A tool can be “ready but user-disabled”; however a persisted per-tool `enabled` preference cannot make a dependency-gated or family-gated tool usable. For example, `codex_*` and `agent_swarm_run` remain effectively OFF while Codex Delegation is OFF, and the UI shows a disabled **Setup first / ตั้งค่าก่อน** switch instead of pretending the tool is active.
- ChatGPT app/action synchronization is a separate host concern. lnwjud only shows ChatGPT-specific refresh guidance when a relevant trusted remote connection is active, and it does **not** claim that a normal browser F5 refresh is sufficient for an approved/frozen action snapshot. Use the ChatGPT app/action refresh or tool-scan flow exposed for that workspace; if an approved app requires recreation/republishing, follow that host flow.

### What's new in v4.53.0

#### One recurring Native ChatGPT watchdog per durable goal

- Scheduled continuation now uses exactly one **hourly recurring Native ChatGPT Scheduled Task** (`occurrence=interval`, `intervalMinutes=60`) for each active durable goal. Ordinary hourly wakes reuse the same native task ID and never create a per-wake successor.
- The 600-second durable worker lease is independent of the one-hour recurrence cadence. A recurring `dueAt` is the first scheduled firing, not a mutation handoff deadline, so healthy fenced work is not cut off merely because the next hourly tick arrives.
- A recurring wake must call `claim_scheduled_continuation` first. `recurring_acquired` continues work with a fresh lease; a genuinely live/uncertain worker returns `worker_busy_noop` without workspace or host-task mutation; duplicate delivery is idempotent; `terminal_cleanup_required` performs cleanup only and never resumes goal work. If the lease is still valid but trustworthy liveness proves no real worker or blocking job remains and its heartbeat is beyond the bounded 60-second stale-recovery grace, the same hourly tick returns `recurring_acquired`/`orphan_recovered` immediately—no lease-expiry wait, no second hourly probe, and no replacement native task.
- Scheduled workers are **work-conserving**: a durable checkpoint is state persistence, not a turn boundary. After ordinary checkpoints the current worker keeps doing useful work; transient status/log/result or safety/polling failures are retried/re-resolved in the same turn, terminal background-task results are inspected promptly, and a safely reacquirable lease expiry does not become an intentional handoff. There is no fixed 22/25-minute runtime guarantee—the worker uses as much useful host turn as the platform provides.
- The same recurring native task stays live until acceptance is complete. `finish_goal` remains `pending_native_cleanup` until the exact task is proven non-runnable by a Native ChatGPT host delete or confirmed disable receipt. A recurring run is never `consumed` cleanup proof.
- v4.52.x one-time continuation rows remain backward compatible. A live historical one-time watchdog is reused until it becomes historical; lnwjud never runs a one-time and recurring native watchdog concurrently for the same goal. `expedite_scheduled_continuation`, one-time consumed receipts, and per-wake successor creation are legacy one-time compatibility paths only.
- Native scheduling remains host-owned. lnwjud never falls back to its local scheduler, Windows Task Scheduler, `schtasks.exe`, cron, shell timers, browser/DOM automation, or undocumented scheduling APIs.

### What's new in v4.52.4

#### Native Scheduled Task host-surface recovery

- A live v4.52.3 end-to-end probe proved that the durable continuation state machine can claim a fired watchdog correctly while the ChatGPT Native Scheduled Task host can independently return `Resource not found` when the next task is created. The same host error was reproduced from a normal chat turn after host-surface discovery, so it is not treated as a scheduled-wake-only lnwjud failure.
- When the native host explicitly reports a lookup/dispatch failure such as `Resource not found` that proves the operation was not dispatched, the client now **re-resolves the current Native Scheduled Task host surface once and retries the exact same native operation once**. The retry keeps the same provider, request identity, schedule, and continuation intent; it never invents or hard-codes an internal host operation name.
- Ambiguous create results that may already have succeeded are **not retried**. They remain `create_uncertain` and require exact host reconciliation, preventing duplicate one-time tasks.
- If the bounded re-resolved retry still fails, the reservation is recorded truthfully as `create_failed`. The durable goal remains active while real work is unfinished, and no Windows Task Scheduler, lnwjud scheduler, cron, shell timer, DOM/browser automation, external scheduler, or undocumented API is used as a fallback.

### What's new in v4.52.1

#### Durable goal lease / scheduled-continuation hotfix

- Fixes a rolling-goal ownership bug where **Full Bypass could skip the scheduled-goal mutation fence**, allowing an old worker to keep mutating files, Git, or processes after its lease had expired or a successor had taken over.
- Full Bypass still skips the intended application approval, confirmation, command-policy, and Active Project scope gates, but **durable-goal ownership is now always enforced when a live rolling scheduled-goal fence exists**. Ordinary unscheduled Full Bypass remains lease-free when no rolling fence exists.
- Missing, stale, expired, generation-mismatched, or past-handoff `goalLease` proof is rejected **before the tool handler performs a workspace mutation**, preventing stale workers from racing a newer continuation.
- Lease-invalid failures now surface as a recoverable coordination conflict with explicit guidance to read the latest goal and reacquire or claim the scheduled continuation before retrying, instead of the ambiguous `Goal lease is invalid or expired` permission error.
- Adds regression coverage for Full Bypass with and without a rolling fence, plus stale-lease rejection before mutation.
- Fixes scheduled-continuation host routing so the bundled skill no longer hard-codes a private/internal ChatGPT scheduling operation name. It now uses the native Scheduled Task operation actually exposed by the current ChatGPT host, records `create_failed` immediately for unavailable/rejected/not-found host creation, and never substitutes DOM automation or Windows Task Scheduler.

### What's new in v4.52.0

> Upgrading from v4.44.0 or v4.45.0? **v4.52.0 is the single release that contains all accumulated Remote MCP/OAuth work developed after v4.45.0.** The interim 4.50.0 and 4.51.0 numbers were internal development targets and were never published, so their OAuth architecture, Remote MCP/ngrok flow, connection-UX improvements, and persistence fixes are documented together below as one v4.52.0 release.

#### Remember OAuth trust and auto-start Remote MCP

- Remote MCP remembers an authorized ChatGPT client and valid refresh grant after the supported Desktop loopback handoff, so ordinary Start or app restart does not require another authorization.
- Persists trusted Dynamic Client Registration metadata plus valid OAuth refresh grants in the host-protected Remote MCP state. Access tokens remain memory-only; saved refresh grants are rotated normally and expired grants are discarded on load.
- Adds durable Remote MCP run intent. After a successful Start, reopening lnwjud automatically starts the protected Remote MCP runtime when the trusted OAuth connection and ngrok prerequisites still exist. An explicit **Stop** disables automatic start while preserving the trusted OAuth relationship.
- **Reconnect ChatGPT** intentionally clears the saved Remote MCP trust/refresh grants and is used only when the user wants to authorize ChatGPT again, change the connected account/client, or recover a broken OAuth relationship.
- Home and Settings show `CHATGPT LINKED`, `LINKED · AUTO`, and remembered-authorization state without exposing an obsolete manual-consent path. Exact supported ChatGPT callbacks use the one-time local Desktop handoff; unsupported redirects fail closed.
- Keeps the previously introduced connection hierarchy: **Remote MCP — ngrok + OAuth** is Recommended, **OpenAI Secure MCP Tunnel** remains Alternative/Advanced, and advanced users may still run both at the same time.

#### Remote MCP OAuth + clearer connection hierarchy

- Adds **Remote MCP via ngrok + OAuth** as the recommended easy ChatGPT connection path: lnwjud keeps its local Streamable HTTP MCP on loopback (a free loopback port is selected automatically by default), runs a separate OAuth-protected loopback gateway, and lets ngrok expose only that protected gateway as a public HTTPS `/mcp` URL.
- Adds one-click **official ngrok installation through Microsoft Store/WinGet** instead of redistributing `ngrok.exe`; lnwjud verifies readiness by actually running `ngrok version`, shows a distinct READY state/path, disables redundant reinstall when healthy, and exposes repair only when the runtime is missing or unusable. Users paste their ngrok authtoken once, lnwjud stores it with Windows DPAPI, injects it only through the child-process environment, starts/stops ngrok automatically, detects the public URL, and provides Copy MCP URL controls.
- Implements MCP OAuth discovery, Dynamic Client Registration, Authorization Code + PKCE S256, bearer-token protection, refresh tokens, and a one-time random Desktop handoff on an ephemeral `127.0.0.1` listener for exact supported ChatGPT callbacks. Discovering the public ngrok URL alone is not enough to authorize access; unsupported or spoofed redirects fail closed with `403 access_denied`.
- Renames the Settings navigation to **Remote MCP & Tunnel — OAuth, ngrok, API Key, Client**, shows Remote MCP state/public URL and remembered authorization state on Home, adds an optional Doctor check, and records Remote MCP lifecycle events in Live Logs without logging OAuth/ngrok secrets.
- Preserves **OpenAI Secure MCP Tunnel** as a separate connection mode. Its Runtime API key workflow remains supported; the earlier v4.50 Secure-Tunnel OAuth provisioning capability remains fail-closed and is explicitly separated in the UI from the working Remote MCP OAuth flow.
- Clarifies the Desktop connection hierarchy for end users: **Remote MCP — ngrok + OAuth** is marked Recommended, while **OpenAI Secure MCP Tunnel** is an Alternative/Advanced collapsible section. When Remote MCP OAuth is online, Secure Tunnel controls auto-collapse to reduce clutter but remain available, and advanced users may run both connection methods at the same time. The UI also shows the number of online remote connection methods and keeps long verified ngrok executable paths in a separate wrapping READY block so status text does not collide with the path on narrower windows.
- Makes the entire Desktop presentation follow the active Tunnel authentication mode instead of hardcoded Runtime API key copy: Home/Control Center, Settings, onboarding routing, Doctor navigation, embedded Live Logs, and the standalone log viewer now distinguish **OAuth authentication** from the underlying **Secure MCP Tunnel transport**.
- Adds a centralized auth-presentation model and propagates sanitized Tunnel auth metadata into log snapshots so detached log windows render the same OAuth/API-key state as the main window without receiving tokens or credential material.
- Keeps the legacy Tunnel ID + Runtime API key wizard as the primary flow only for legacy mode; OAuth mode stays on the OAuth connection surface, while legacy Runtime API key controls remain explicitly labeled as fallback/troubleshooting.
- Adds OAuth-specific runtime log evidence (`auth=oauth` / `auth=legacy_api_key`) and extends incident-report redaction for authorization codes, PKCE/code verifiers, and OAuth callback query secrets.
- Adds regression coverage for OAuth-vs-legacy presentation while preserving the existing fail-closed provisioning capability gate and legacy compatibility behavior.

#### Secure Tunnel OAuth-ready authentication architecture

- Adds a tunnel authentication abstraction so Persistent Tunnel identity, authentication method, and runtime credential are modeled independently while preserving the existing Tunnel ID + Runtime API key workflow for every current user.
- Keeps legacy Runtime API key authentication as the default for upgrades and fresh installs; no existing user is forced to sign in or migrate, and `lnwjud.runtime.secret` remains the backward-compatible DPAPI-protected fallback.
- Adds OAuth-ready PKCE/state/loopback session infrastructure, secure DPAPI refresh-session storage, memory-only runtime credential handling, sanitized IPC status, and transactional auth-mode switching/rollback without exposing tokens to the renderer, argv, logs, incident reports, or profile files.
- Adds optional **Sign in with OAuth**, **Switch back to Runtime API key**, and **Sign out OAuth** flows in Secure Tunnel settings, but exposes OAuth provisioning as unavailable unless the configured provider explicitly supports Secure MCP Tunnel runtime-credential provisioning.
- Fails closed on account/organization/Tunnel-ID mismatch and never substitutes ChatGPT/Codex browser sessions or unrelated access tokens for the official Secure MCP Tunnel Runtime API key contract.
- Preserves the same Persistent Tunnel ID across auth-mode changes and commits a migration only after the new runtime credential is usable and the persistent runtime has reconciled successfully; failed migrations roll back to the retained legacy credential.
- Updates startup, Doctor, Control Center, onboarding, preload/IPC contracts, continuity tests, and updater/reinstall semantics to use auth-neutral `authReady` / `runtimeCredentialAvailable` status while retaining `hasApiKey` compatibility for older integrations.

> **OAuth availability in v4.52.0:** Secure Tunnel OAuth provisioning is enabled only when the configured provider can supply a supported Secure MCP Tunnel runtime credential. The existing Runtime API key path remains supported and is the compatibility fallback; lnwjud does not reuse unrelated ChatGPT/Codex browser tokens.

#### v4.45.0 — Secure Tunnel, continuation, logs, and performance hardening

- Keeps the v4.45 runtime hardening and upgrades intact, including the bundled official OpenAI Secure MCP Tunnel client `v0.0.13` for Windows x64 with pinned release evidence.
- Preserves the complete official v0.0.13 target-native tunnel-client payload inside each platform package, including its executable, license/notice inventory, SPDX metadata, and Sigstore provenance; the selected client is never replaced by an unverified system binary.
- Verifies the real v0.0.13 managed-runtime CLI/status contract while retaining v0.0.12 parser compatibility for users who deliberately select an older manual override.
- Separates **Persistent Tunnel Identity** from runtime Run/Stop intent: an explicit **Stop Tunnel** is now durable across lnwjud restarts and automatic reconnect remains paused until the user explicitly starts the tunnel again.
- Makes a saved custom `tunnel-client.exe` override authoritative instead of silently falling back to the bundled binary when that path is missing, and records the executable that actually owns the active persistent runtime so Stop/recovery uses the correct client.
- Makes client switching transactional: lnwjud stops and verifies the old persistent runtime through its recorded owner before committing a new custom/bundled selection, preventing duplicate or orphan runtimes during client changes.
- Closes the rolling-continuation chain gap without fixed host polling: omitted preparation and successful wake claims derive a fresh successor from the current lease (normally 600 seconds -> about 10 minutes), while firing collisions retire the consumed one-time task and reserve a deterministic adaptive successor with roughly 4/8/16/25-minute backoff plus lease/liveness floors. Same-task expedite is reserved only for a future task that is still pending before it fires.
- Makes goal completion two-phase when a successor is still live or host state is uncertain: `finish_goal` first returns `status=active` with `completionState=pending_native_cleanup`, and only a matching native deletion/run receipt followed by a second `finish_goal` can produce terminal `completionState=completed`.
- Extends packaged-runtime trust evidence so `PROVENANCE.json` and `SHA256SUMS.txt` cover the target-native tunnel client, runtime tools, native helper, launcher, and accompanying release metadata rather than only the outer lnwjud executables.
- Repairs the version synchronization helper so current package, runtime, UI, architecture and release-document references move together to **v4.45.0** without rewriting historical release evidence.
- Reduces Desktop hitching and background process churn by replacing overlapping one-second full-dashboard refreshes with guarded refreshes plus TTL/single-flight caching for expensive Git, Codex, WSL, and capability probes; the detached Live Logs viewer no longer triggers redundant dashboard polling.
- Preserves complete Activity Logs diagnostics end to end: full workspace/session IDs, inputs, results, errors, metadata, copy/export detail, and lazy expandable payloads are retained without lossy `(+N)` summaries; **Show more** appears only when meaningful additional detail exists.
- Verifies the packaged Windows capability bridge against the exact staged bytes, SHA-256, byte count, provenance, and packaged-artifact evidence used by Setup and Portable builds.
- Completes the remaining first-party runtime adapters: delegation, telemetry, tool-schema registration, project profiles, benchmark/regression reporting, skill import, workbook/PDF comparison, and debugger-related capabilities now execute through real providers or report a truthful dependency/setup requirement instead of fake readiness.
- Hardens Tools/Doctor readiness semantics for Browser Debug Context, Live Logs, plugin/task controls, optional External MCP, and control-plane health so stopped runtimes report start-required, optional integrations stay informational when absent, and actionable setup/remediation is shown only when it is genuinely available.
- Improves verified recovery coverage for long-running goals by keeping successor scheduling fenced to the active goal state and current worker evidence.
