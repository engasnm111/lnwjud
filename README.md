<p align="center">
  <img src="assets/logo/logo-256x256.png" width="160" alt="lnwjud logo" />
</p>

<h1 align="center">lnwjud</h1>

<p align="center">
  <strong>Windows-first local AI-agent runtime and MCP gateway</strong><br />
  <em>231 total tool definitions for local files, Git, processes, Windows automation, WSL, browser control, durable goal continuation, indexing, observability, and extensibility; 224 are advertised by default and all 231 when Codex delegation plus Agent Swarm is enabled.</em>

  <em>อ่านที่เหลือใน Readme ได้เลยครับ ติดปัญหาทักมาได้ใน FB: Adisorn NM ได้ตลอดครับ / กำลังพัฒนาให้เรื่อยๆครับ ท่านที่ถามหาช่องสนับสนุนค่ากาแฟ แปะลิงค์ ไว้ให้แล้วครับ ขอบคุณครับ</em>
 https://easydonate.app/abcz
</p>

<p align="center">
  <a href="https://github.com/engasnm111/lnwjud/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/engasnm111/lnwjud" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20x64-0078D4" />
  <img alt="Node" src="https://img.shields.io/badge/Node.js-24.x-339933" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-231%20tools-6f42c1" />
</p>

---

## What is lnwjud?

lnwjud is a Windows-first local development gateway that exposes trusted local
capabilities through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).
It is designed for AI-assisted software development where the agent needs more
than a text-only chat: it may need to inspect a repository, search code, edit
files, review Git state, run project commands, manage owned processes, inspect
Windows UI state, automate a managed browser, work with WSL, or call an
additional local MCP server.

The runtime stays on the Windows machine. Local filesystem paths, processes,
SQLite state, credentials, and capability backends are owned by lnwjud on that
machine. Remote AI clients only receive the MCP requests and results that travel
through the connection mode you choose.

For ChatGPT web and other supported OpenAI surfaces, lnwjud supports the official
[OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
The tunnel is outbound-only: `tunnel-client` runs beside lnwjud, reaches OpenAI
over outbound HTTPS, forwards MCP work to lnwjud's Desktop loopback HTTP MCP,
and returns the response without opening a public inbound port on the Windows
machine.

## Current version: v4.52.1

The v4.52.1 release target and runtime contract contain **231 total MCP tool definitions**,
with **224 advertised by default** and **all 231 advertised when the six `codex_*`
delegation tools plus the bounded read-only `agent_swarm_run` tool are enabled**. The seven Codex/Agent Swarm definitions are opt-in;
the default surface still exposes every other current first-party definition. The earlier 184-tool snapshot remains
only as the compatibility baseline used by the v4 architecture; new v4 gateway
capabilities are additive.

### What's new in v4.52.1

#### Durable goal lease / scheduled-continuation hotfix

- Fixes a rolling-goal ownership bug where **Full Bypass could skip the scheduled-goal mutation fence**, allowing an old worker to keep mutating files, Git, or processes after its lease had expired or a successor had taken over.
- Full Bypass still skips the intended application approval, confirmation, command-policy, and Active Project scope gates, but **durable-goal ownership is now always enforced when a live rolling scheduled-goal fence exists**. Ordinary unscheduled Full Bypass remains lease-free when no rolling fence exists.
- Missing, stale, expired, generation-mismatched, or past-handoff `goalLease` proof is rejected **before the tool handler performs a workspace mutation**, preventing stale workers from racing a newer continuation.
- Lease-invalid failures now surface as a recoverable coordination conflict with explicit guidance to read the latest goal and reacquire or claim the scheduled continuation before retrying, instead of the ambiguous `Goal lease is invalid or expired` permission error.
- Adds regression coverage for Full Bypass with and without a rolling fence, plus stale-lease rejection before mutation.

### What's new in v4.52.0

> Upgrading from v4.44.0 or v4.45.0? **v4.52.0 is the single release that contains all accumulated Remote MCP/OAuth work developed after v4.45.0.** The interim 4.50.0 and 4.51.0 numbers were internal development targets and were never published, so their OAuth architecture, Remote MCP/ngrok flow, connection-UX improvements, and persistence fixes are documented together below as one v4.52.0 release.

#### Pair once, remember OAuth, auto-start Remote MCP

- Changes Remote MCP OAuth to a **pair-once trust model**. The first ChatGPT authorization still uses the short-lived 6-digit pairing code so knowing the public ngrok URL is not enough to authorize a client, but after approval lnwjud remembers that registered ChatGPT client and does not ask for pairing again on ordinary Start or app restart.
- Persists trusted Dynamic Client Registration metadata plus valid OAuth refresh grants in a **Windows DPAPI-encrypted Remote MCP state file**. Access tokens remain memory-only; saved refresh grants are rotated normally and expired grants are discarded on load.
- Adds durable Remote MCP run intent. After a successful Start, reopening lnwjud automatically starts the protected Remote MCP runtime when the trusted OAuth connection and ngrok prerequisites still exist. An explicit **Stop** disables automatic start while preserving the trusted OAuth relationship, so starting later does not force re-pairing.
- Replaces the routine “New pairing code” action with **Reconnect ChatGPT**. That action is intentionally destructive to the saved Remote MCP trust/refresh grants and is used only when the user wants to authorize ChatGPT again, change the connected account/client, or recover a broken OAuth relationship.
- Updates Home and Settings to show `CHATGPT LINKED`, `LINKED · AUTO`, first-time pairing, and remembered-authorization state instead of presenting pairing as a recurring requirement. When first-time pairing is required, the 6-digit PIN is rendered as a dedicated larger monospace value with a contrasting high-visibility color so it is easy to distinguish from the surrounding instruction text. The Remote MCP cards also receive larger vertical gaps, separated status banners, and wrapping path/status layout for clearer scanning on normal Windows 10/11 window sizes.
- Keeps the previously introduced connection hierarchy: **Remote MCP — ngrok + OAuth** is Recommended, **OpenAI Secure MCP Tunnel** remains Alternative/Advanced, and advanced users may still run both at the same time.

#### Remote MCP OAuth + clearer connection hierarchy

- Adds **Remote MCP via ngrok + OAuth** as the recommended easy ChatGPT connection path: lnwjud keeps its local Streamable HTTP MCP on loopback (normally `http://127.0.0.1:18765/mcp`), runs a separate OAuth-protected loopback gateway, and lets ngrok expose only that protected gateway as a public HTTPS `/mcp` URL.
- Adds one-click **official ngrok installation through Microsoft Store/WinGet** instead of redistributing `ngrok.exe`; lnwjud verifies readiness by actually running `ngrok version`, shows a distinct READY state/path, disables redundant reinstall when healthy, and exposes repair only when the runtime is missing or unusable. Users paste their ngrok authtoken once, lnwjud stores it with Windows DPAPI, injects it only through the child-process environment, starts/stops ngrok automatically, detects the public URL, and provides Copy MCP URL controls.
- Implements MCP OAuth discovery, Dynamic Client Registration, Authorization Code + PKCE S256, bearer-token protection, refresh tokens, and a short-lived **6-digit pairing code** shown by lnwjud during authorization so discovering the public ngrok URL alone is not enough to authorize access. The pairing consent surface uses a themed lnwjud page and a redirect-aware CSP so successful authorization can return to the validated ChatGPT OAuth callback instead of being blocked by `form-action`.
- Renames the Settings navigation to **Remote MCP & Tunnel — OAuth, ngrok, API Key, Client**, shows Remote MCP state/public URL/pairing code on Home, adds an optional Doctor check, and records Remote MCP lifecycle events in Live Logs without logging OAuth/ngrok secrets.
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
- Preserves the complete official v0.0.13 adjacent runtime set inside Setup and Portable, including `tunnel-client.exe`, pinned `cloudflared.exe`, its manifest, license/notice inventory and SPDX metadata; the Cloudflared companion is packaged but is not enabled automatically by lnwjud.
- Verifies the real v0.0.13 managed-runtime CLI/status contract while retaining v0.0.12 parser compatibility for users who deliberately select an older manual override.
- Separates **Persistent Tunnel Identity** from runtime Run/Stop intent: an explicit **Stop Tunnel** is now durable across lnwjud restarts and automatic reconnect remains paused until the user explicitly starts the tunnel again.
- Makes a saved custom `tunnel-client.exe` override authoritative instead of silently falling back to the bundled binary when that path is missing, and records the executable that actually owns the active persistent runtime so Stop/recovery uses the correct client.
- Makes client switching transactional: lnwjud stops and verifies the old persistent runtime through its recorded owner before committing a new custom/bundled selection, preventing duplicate or orphan runtimes during client changes.
- Closes the rolling-continuation chain gap without fixed host polling: omitted preparation and successful wake claims derive a fresh successor from the current lease (normally 600 seconds -> about 10 minutes), while firing collisions retire the consumed one-time task and reserve a deterministic adaptive successor with roughly 4/8/16/25-minute backoff plus lease/liveness floors. Same-task expedite is reserved only for a future task that is still pending before it fires.
- Makes goal completion two-phase when a successor is still live or host state is uncertain: `finish_goal` first returns `status=active` with `completionState=pending_native_cleanup`, and only a matching native deletion/run receipt followed by a second `finish_goal` can produce terminal `completionState=completed`.
- Extends packaged-runtime trust evidence so `PROVENANCE.json` and `SHA256SUMS.txt` cover the tunnel client, Cloudflared companion, manifest and accompanying release metadata rather than only the outer lnwjud executables.
- Repairs the version synchronization helper so current package, runtime, UI, architecture and release-document references move together to **v4.45.0** without rewriting historical release evidence.
- Reduces Desktop hitching and background process churn by replacing overlapping one-second full-dashboard refreshes with guarded refreshes plus TTL/single-flight caching for expensive Git, Codex, WSL, and capability probes; the detached Live Logs viewer no longer triggers redundant dashboard polling.
- Preserves complete Activity Logs diagnostics end to end: full workspace/session IDs, inputs, results, errors, metadata, copy/export detail, and lazy expandable payloads are retained without lossy `(+N)` summaries; **Show more** appears only when meaningful additional detail exists.
- Verifies the packaged Windows capability bridge against the exact staged bytes, SHA-256, byte count, provenance, and packaged-artifact evidence used by Setup and Portable builds.
- Completes the remaining first-party runtime adapters: delegation, telemetry, tool-schema registration, project profiles, benchmark/regression reporting, skill import, workbook/PDF comparison, and debugger-related capabilities now execute through real providers or report a truthful dependency/setup requirement instead of fake readiness.
- Hardens Tools/Doctor readiness semantics for Browser Debug Context, Live Logs, plugin/task controls, optional External MCP, and control-plane health so stopped runtimes report start-required, optional integrations stay informational when absent, and actionable setup/remediation is shown only when it is genuinely available.
- Improves verified recovery coverage for long-running goals by keeping successor scheduling fenced to the active goal state and current worker evidence.


Current v4 highlights include:

- Workspace registration, bounded project snapshots, file reads/writes, paging,
  full scans, persistent indexing, and continuation tokens.
- Git status/diff/log plus policy-checked Git execution.
- Foreground/background command tasks with ownership, timeout, cancellation,
  bounded output, logs, and result retrieval.
- Project-aware development, test, lint, typecheck, and build commands.
- Local Codex discovery and optional delegation without reading Codex credential
  files.
- Native Windows capabilities for shell execution, windows, accessibility,
  input, screen capture, notifications, clipboard, file dialogs, audio, screen
  recording, Office automation, and scheduler integration.
- Managed Chrome / CDP automation and Set-of-Marks annotated observations with
  expiring observation hashes and approval-gated target actions.
- Scoped WSL execution and Windows/WSL path translation for registered
  workspaces.
- Complete local skill discovery across bundled, Codex/plugin, Agents, Cursor,
  Claude, GitHub workspace, and configured skill roots, plus child MCP
  discovery/description/call contracts.
- Compound and parallel workflows, deterministic semantic tool routing, and
  Context Economy telemetry.
- Trace-correlated activity, NDJSON/SQLite audit metadata, Work Log, Live Logs,
  Doctor checks, health surfaces, and background tray operation.
- OpenAI Secure MCP Tunnel management with Windows DPAPI-encrypted runtime-key
  storage and reconnect handling.

Authoritative in-repository references:

- [Tool contract](docs/architecture/TOOL_CONTRACT.md) — core primitive schemas,
  policy classes, and compatibility rules; the 231-definition complete index below comes from the live runtime registry.
- [Upgrade architecture](docs/architecture/UPGRADE_ARCHITECTURE.md) — v4 runtime
  architecture and additive gateway design.
- [Release process](docs/development/RELEASE_PROCESS.md) — canonical `dev -> PR -> main CI -> tag -> Release -> dev sync` sequence, exact-SHA artifact rule, and failure handling.
- [Roadmap phase status](docs/architecture/ROADMAP_PHASE_STATUS.md) — completed
  implementation phases.

## Security model you should understand before using it

lnwjud is intentionally powerful. It is intended for a machine and workspace you
trust, not as a sandbox for unknown code.

- **Unrestricted mode is enabled by default for read/discovery compatibility, but it never scans or registers drive letters automatically.** It permits explicitly requested absolute paths. With Full Bypass OFF, Unrestricted does not widen the host-selected Active Project mutation boundary or bypass command/approval policy. Full Bypass is a separate explicit control.
- Desktop MCP applies the selected permission profile (`safe`, `balanced`,
  `full`, or `custom`) to tool calls.
- The packaged standalone/headless STDIO runtime supports selectable `safe`,
  `balanced`, `full`, or `custom` profiles. For backward compatibility the
  default remains **full**, but a project must be passed explicitly or already be
  registered; no drive root is inferred. Secure Tunnel does not use this headless profile; it uses the
  running Desktop MCP permission profile and the Desktop-selected Active Project.
- **Strict Roots** is opt-in and limits standalone/headless STDIO workspace
  visibility to explicitly allowed roots. It is a filesystem/capability boundary,
  not an operating-system sandbox. Secure Tunnel remains constrained by the
  Desktop Active Project mutation boundary and native exact-action approval.
- Explicit file reads can include sensitive files such as `.env` when the active
  policy permits them. Do not register or expose a machine to an AI client you
  do not trust.
- Destructive and opaque operations are centrally classified. With Full Bypass OFF, approval-required mutations need explicit chat confirmation and an independent trusted host exact-action approval before backend dispatch. The Desktop native dialog is cancel-first; standalone/headless runtimes without a trusted host approval provider fail closed instead of silently approving.
- The exact `delete_file` operation is the only mutation eligible for scoped auto-approval, and only after the target is proven recoverable inside the Active Project. Protected critical paths, workspace roots, non-empty directories, unsafe/broad patterns, outside paths, and reparse/junction escapes are never auto-approved.
- Recovery Center derives and displays the local Recovery Trash path from the configured Desktop data root (`<dataRoot>/recovery-trash`). Replacement backups and supported deletes are recorded there or in encrypted checkpoints before the authoritative mutation where the operation is recoverable.
- Arbitrary approved commands, package scripts, project-owned scripts, Codex instructions, child MCP calls, and remote mutations are opaque execution. They are not an operating-system sandbox and are not automatically recoverable through Recovery Trash.
- With Full Bypass OFF, disk formatting and machine shutdown/reboot remain hard-blocked by lnwjud command policy. Full Bypass skips that application policy, but Windows/UAC/tool availability can still reject or fail the operation.
- The local Streamable HTTP MCP endpoint binds to loopback. Do not publish that
  loopback endpoint through a generic reverse proxy. For a private remote
  connection, use Secure MCP Tunnel.
- Runtime tunnel API keys saved from the desktop UI are encrypted with Windows
  DPAPI for the current Windows user. Never commit a runtime key, `.env`, tunnel
  profile containing a plaintext secret, private key, or credential file.

The Context Economy Engine reduces automatic discovery cost without acting as a
security deny list. Automatic search/index/watch flows skip vendor, build,
cache, binary, generated-bundle, and source-map noise, while explicit reads or
full scans can still inspect paths allowed by the active workspace/policy.

## Connection modes

| Client / use case | Connection | What must run on Windows | Notes |
| --- | --- | --- | --- |
| ChatGPT web developer-mode app | Remote MCP via ngrok + OAuth | lnwjud Desktop + ngrok | Recommended easy path: public HTTPS `/mcp` terminates at a separate OAuth-protected loopback gateway; 6-digit pairing is required only for the first authorization or an explicit Reconnect ChatGPT |
| ChatGPT web developer-mode app | OpenAI Secure MCP Tunnel | `tunnel-client` + lnwjud Desktop | Private outbound-only path to the Desktop loopback HTTP MCP; no public MCP port |
| Codex CLI or another local MCP host | Local stdio MCP | `lnwjud-mcp-stdio.cmd` | Lowest-overhead local MCP path |
| Local MCP client / dashboard diagnostics | Loopback Streamable HTTP | lnwjud Desktop | Defaults to `http://127.0.0.1:18765/mcp`; actual URL is shown in the UI |
| Supported OpenAI API/Codex surface | Secure MCP Tunnel | `tunnel-client` + local MCP target | Tunnel association and Platform permissions apply |

For most ChatGPT web users, choose **one primary remote connection method**: Remote MCP via ngrok + OAuth is the recommended path, while OpenAI Secure MCP Tunnel is the alternative/advanced path. They are independent transports/authentication surfaces, so enabling one does not remove the other; power users can deliberately keep both online. In Desktop Settings, each method is grouped in its own collapsible section with independent ONLINE/READY/SETUP state, and Secure Tunnel auto-collapses while Remote MCP OAuth is online to keep the normal setup path focused.

The desktop HTTP server starts automatically; adding a project is required before workspace-scoped work, but Doctor and Projects remain available when no project is registered yet.
If the preferred port `18765` is busy, the server can fall back to an ephemeral
loopback port; always use the endpoint shown in the dashboard. The **Start
Connection** button is useful after a manual stop, while **Stop Connection**
stops the current local HTTP listener.

## Quick start: install the Windows release

### 1. Install lnwjud Desktop

1. Download the latest published installer from
   [GitHub Releases](https://github.com/engasnm111/lnwjud/releases/latest).
   Current Windows 10/11 x64 artifacts are `lnwjud-Setup-4.52.1.exe` (recommended installer) and `lnwjud-Portable-4.52.1.exe` (no installation required).
2. Run the NSIS installer and launch **lnwjud Agent Control Center**.
3. Add or select the project/workspace you want lnwjud to operate on.
4. Review **Settings** before attaching an AI client, especially Permission
   Profile and Unrestricted Mode.

If you prefer not to install the app, run `lnwjud-Portable-4.52.1.exe` directly.
Portable mode uses the same per-user lnwjud data/settings location as the installer;
it is a portable executable, not a keep-all-data-next-to-the-EXE mode.
Automatic updates preserve the distribution you chose. Installer users read
`latest.yml` and receive the next `lnwjud-Setup-<version>.exe`. Portable users
read `portable.yml` and receive the next `lnwjud-Portable-<version>.exe`, which
is verified by the updater and then replaces the same Portable EXE path with a
backup/rollback/restart flow after the running process exits. The updater never
converts a Portable install into an Installer install or the reverse.


The graphical desktop app and the packaged **local STDIO** launcher are
self-contained. Both Windows packages ship Electron for the dashboard and a private
Node.js 24 runtime for `lnwjud-mcp-stdio.cmd`, so end users do **not** need a
separate system Node.js installation. Secure Tunnel uses the running Desktop HTTP
MCP plus the bundled official `tunnel-client.exe`; it does not
spawn the packaged STDIO launcher.

### Windows vision / Set-of-Marks requirements

For normal Windows 10/11 x64 desktop use, **no extra Windows Settings toggle or separate
accessibility package is required** for `vision.capture_*`, `accessibility.observe`,
or `vision_annotated_capture`. The compatibility contract covers Windows 10 x64 from
build 10240 onward and Windows 11 x64 from build 22000 onward, including normal Home,
Pro, Enterprise, Education, and LTSC-style installations. lnwjud uses built-in Windows
screen-capture APIs, Microsoft UI Automation, and Windows PowerShell 5.x/.NET APIs
already present on the machine; PowerShell 7 is not required.

A few operating-system boundaries still apply:

- lnwjud must run in the same interactive Windows session as the UI being observed.
  The Windows lock screen, sign-in screen, and UAC secure desktop are intentionally
  outside normal desktop capture/automation.
- If the target application is running **as Administrator** while lnwjud is not,
  Windows integrity isolation can limit semantic UI Automation access. Prefer
  running both at the same privilege level; only elevate lnwjud when the target
  genuinely requires it.
- Set-of-Marks labels come from controls exposed through Microsoft UI Automation.
  Apps that draw their whole interface on a custom canvas may return few or no
  semantic marks even though ordinary `vision.capture_display`, `capture_window`,
  and `capture_region` screenshots still work.
- A minimized, locked, or disconnected target may not have capturable pixels.
  Restore the target window and keep the desktop session active when validating a
  visual workflow.

### 2. Connect ChatGPT with Remote MCP + OAuth (recommended)

For most ChatGPT web users, **start here**. Remote MCP via **ngrok + OAuth** is the primary setup path in v4.52.1. It does **not** require an OpenAI Tunnel ID or Runtime API key. lnwjud keeps its real MCP server on loopback, places an OAuth-protected gateway in front of it, and exposes only that protected gateway through ngrok as an HTTPS URL ending in `/mcp`.

1. Open **lnwjud → Settings → Remote MCP & Tunnel**.
2. Check the ngrok status. If lnwjud shows **READY**, keep the detected installation. If it is not ready, use **Install ngrok automatically**; lnwjud uses the official Microsoft Store/WinGet path rather than bundling an unofficial binary.
3. Save your ngrok authtoken once, then click **Start Remote MCP**. lnwjud starts the OAuth gateway and ngrok, detects the public HTTPS MCP URL, and shows a **Copy MCP URL** action.
4. In ChatGPT, enable Developer mode when your plan/workspace allows it, add a custom MCP connection, paste the copied public `https://.../mcp` URL, and choose **OAuth** authentication.
5. On the **first authorization only**, the browser opens the lnwjud approval page. Enter the short-lived **6-digit OAuth Pairing Code** shown in lnwjud and authorize ChatGPT. The browser then redirects back to ChatGPT.
6. After that first approval, lnwjud remembers the trusted registered ChatGPT client and valid refresh grant in Windows DPAPI-protected state. Ordinary app restarts or **Start Remote MCP** do not require pairing again. An explicit **Stop** disables auto-start but preserves the trusted OAuth relationship; use **Reconnect ChatGPT** only when you intentionally want to re-authorize or replace that relationship.
7. Confirm the connection discovers **224 tools by default** (or **231** when Codex delegation plus Agent Swarm is explicitly enabled), then run a read-only smoke test before writes.

The public ngrok URL is not the raw loopback MCP endpoint: requests must pass OAuth and bearer-token validation at the separate gateway. Do not publish `http://127.0.0.1:<port>/mcp` directly through a generic reverse proxy.

### 3. Alternative: OpenAI Secure MCP Tunnel (Tunnel ID + Runtime API key)

Use this path only when you specifically prefer the official outbound-only Secure MCP Tunnel transport or your organization requires it. **Tunnel ID + Runtime API key is an alternative/advanced setup, not the default Quick Start path.**

The Secure MCP Tunnel flow requires a Platform tunnel ID and a runtime API key. The published Windows x64 installer and portable executable already contain the official OpenAI `tunnel-client v0.0.13`, so release users do **not** download or extract a separate tunnel-client package. The official Windows x64 bundle is kept intact beside the client, including pinned `cloudflared.exe` v2026.8.2, its manifest, license/notice files, license inventory, and SPDX SBOM. lnwjud does **not** enable Cloudflared mode merely because that companion is packaged. Creating or editing a tunnel requires **Tunnels Read + Manage**; the runtime key needs **Tunnels Read + Use**.

1. Open [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
2. Create a tunnel named `lnwjud` and associate it with the Platform organization and ChatGPT workspace that should use it.
3. Create a restricted runtime API key with **Tunnels Read + Use**.
4. Open **lnwjud → Settings → Remote MCP & Tunnel → OpenAI Secure MCP Tunnel**. Save the runtime API key, leave the bundled-client override empty, paste the tunnel ID, and click **Configure Tunnel**.
5. The wizard selects the bundled client, starts or reuses lnwjud's Desktop loopback HTTP MCP, creates or repairs `%APPDATA%/tunnel-client/lnwjud.yaml`, and runs the required diagnostics.
6. In ChatGPT, add a **Tunnel** connection and select the associated `lnwjud` tunnel or enter its `tunnel_id`.

The tunnel-client path field is an **override/troubleshooting** control only. Clear it and choose **Use bundled** to return to the package-supplied client. Secure Tunnel forwards to the running Desktop MCP and does not spawn a separate headless lnwjud MCP runtime, so Desktop-selected Active Projects and native exact-action approval remain authoritative.

If you intentionally need to initialize the Secure Tunnel profile by hand, keep lnwjud running and copy the **Local MCP endpoint** shown by lnwjud (it is loopback-only and ends in `/mcp`):

```powershell
$env:CONTROL_PLANE_API_KEY = '<runtime-key-for-this-session>'
$tc = 'C:/path/to/tunnel-client.exe'
$profileDir = Join-Path $env:APPDATA 'tunnel-client'
$mcpEndpoint = 'http://127.0.0.1:<port>/mcp' # copy the actual endpoint shown by lnwjud

& $tc init `
  --force `
  --sample sample_mcp_remote_no_auth `
  --profile lnwjud `
  --profile-dir $profileDir `
  --tunnel-id 'tunnel_0123456789abcdef0123456789abcdef' `
  --control-plane-api-key-ref 'env:CONTROL_PLANE_API_KEY' `
  --health-listen-addr '127.0.0.1:0' `
  --mcp-server-url $mcpEndpoint

& $tc doctor --profile lnwjud --profile-dir $profileDir --explain
Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
```

For Secure Tunnel troubleshooting, open **Live Logs** or run **Doctor**. The desktop tunnel controller repairs stale stdio profiles into Desktop HTTP profiles before Doctor/Start and keeps literal runtime keys out of the generated YAML by using `env:CONTROL_PLANE_API_KEY`.

Example smoke test:

```text
Use lnwjud to list registered workspaces, report Git status for the selected project, and summarize the top-level project tree. Do not modify anything.
```

## Quick start: install the Windows release (ภาษาไทย)

ส่วนนี้สำหรับผู้ใช้ Windows ที่ต้องการติดตั้ง lnwjud แล้วเชื่อมกับ ChatGPT แบบง่ายที่สุด โดย **วิธีหลักที่แนะนำใน v4.52.1 คือ Remote MCP ผ่าน ngrok + OAuth** ไม่ต้องมี OpenAI Tunnel ID และไม่ต้องสร้าง Runtime API key สำหรับขั้นตอนหลักนี้ ส่วน **Tunnel ID + Runtime API key** ยังคงรองรับ แต่เป็นทางเลือก/โหมดขั้นสูงสำหรับผู้ที่ต้องการ OpenAI Secure MCP Tunnel โดยเฉพาะ

### 1. ติดตั้ง lnwjud หรือใช้ Portable

1. แบบแนะนำ: ดาวน์โหลด `lnwjud-Setup-4.52.1.exe` แล้วติดตั้งตามปกติ
2. ถ้าไม่ต้องการติดตั้ง: ดาวน์โหลด `lnwjud-Portable-4.52.1.exe` แล้วเปิดได้ทันที
3. เปิด **lnwjud Agent Control Center**
4. เพิ่มหรือเลือก Project/Workspace ที่ต้องการให้ ChatGPT ทำงานด้วย

Portable ใช้ Settings/ข้อมูลต่อผู้ใช้ Windows ชุดเดียวกับตัวติดตั้ง ไม่ได้เก็บ database/settings ทุกอย่างไว้ข้าง EXE และตัว release มี private Node runtime สำหรับ local stdio มาให้แล้ว

### 2. เชื่อม ChatGPT ด้วย Remote MCP + OAuth (แนะนำ)

สำหรับผู้ใช้ ChatGPT เว็บทั่วไป **ให้เริ่มจากวิธีนี้ก่อน**:

1. เปิด **Settings → Remote MCP & Tunnel**
2. ดูสถานะ ngrok ก่อน ถ้าขึ้น **READY** ให้ใช้ตัวที่ตรวจพบได้เลย; ถ้ายังไม่พร้อมให้กด **ติดตั้ง ngrok อัตโนมัติ** ซึ่ง lnwjud ใช้ช่องทาง Microsoft Store/WinGet ทางการ
3. ใส่ ngrok authtoken หนึ่งครั้ง แล้วกด **Start Remote MCP**
4. รอให้ lnwjud เปิด OAuth-protected gateway, รัน ngrok และแสดง public HTTPS MCP URL ที่ลงท้าย `/mcp` จากนั้นกด **Copy MCP URL**
5. ใน ChatGPT เปิด Developer mode หากบัญชี/Workspace รองรับ แล้วเพิ่ม custom MCP connection โดยวาง URL ที่คัดลอกมาและเลือก **OAuth**
6. **เฉพาะการอนุมัติครั้งแรก** browser จะเปิดหน้า lnwjud ให้กรอก **OAuth Pairing Code 6 หลัก** ที่แสดงในแอป แล้วกดอนุมัติ เมื่อสำเร็จจะ redirect กลับ ChatGPT
7. หลังอนุมัติครั้งแรก lnwjud จะจำ trusted ChatGPT client และ refresh grant แบบเข้ารหัสด้วย Windows DPAPI การเปิดโปรแกรมใหม่หรือกด Start ตามปกติจึงไม่ต้อง pairing ซ้ำ. การกด **Stop** จะหยุด auto-start แต่ยังจำความสัมพันธ์ OAuth เดิมไว้; ใช้ **Reconnect ChatGPT** เฉพาะเมื่อต้องการล้าง/อนุมัติความสัมพันธ์ใหม่จริง ๆ
8. ตรวจว่า ChatGPT เห็น tools ของ lnwjud — ปกติ **224 tools**, หรือ **231** เมื่อเปิด Codex delegation + Agent Swarm — แล้วค่อยเริ่มจากงาน read-only

public ngrok URL นี้ชี้เข้า OAuth gateway แยกต่างหาก ไม่ใช่การเปิด `http://127.0.0.1:<port>/mcp` ตรง ๆ ออกอินเทอร์เน็ต และ request ต้องผ่าน OAuth/bearer-token validation ก่อนถึง Local MCP

### 3. ทางเลือก: OpenAI Secure MCP Tunnel (Tunnel ID + Runtime API key)

ใช้วิธีนี้เมื่อคุณต้องการ transport แบบ outbound-only ของ OpenAI Secure MCP Tunnel โดยเฉพาะ หรือองค์กรกำหนดให้ใช้วิธีนี้. **Tunnel ID + Runtime API key เป็นทางเลือก/Advanced ไม่ใช่ Quick Start หลัก**

1. เข้า [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
2. สร้าง Tunnel ใหม่และจดค่า `tunnel_id`
3. สร้าง Runtime API key ที่มีสิทธิ์ **Tunnels Read + Use** และเก็บเป็นความลับ
4. เปิด **Settings → Remote MCP & Tunnel → OpenAI Secure MCP Tunnel**
5. ใส่ Runtime API key, ปล่อย tunnel-client override ว่างไว้, ใส่ Tunnel ID แล้วกด **Configure Tunnel**
6. รอ Configure/Doctor ผ่าน แล้วกด **Start Tunnel**
7. ใน ChatGPT เพิ่ม Connection แบบ **Tunnel** แล้วเลือก tunnel ที่สร้างไว้หรือใส่ `tunnel_id`

`lnwjud-Setup-4.52.1.exe` และ `lnwjud-Portable-4.52.1.exe` รวม official OpenAI `tunnel-client v0.0.13` มาให้แล้ว จึง **ไม่ต้องดาวน์โหลด `tunnel-client.exe` เอง** ช่อง path เป็น override สำหรับ troubleshooting เท่านั้น; หากต้องการกลับไปใช้ตัว bundled ให้ล้าง override แล้วเลือก **Use bundled** อย่างชัดเจน

`Persistent Tunnel Identity` จำ Tunnel ID แยกจาก Run/Stop intent. เมื่อผู้ใช้กด **Stop Tunnel** lnwjud จะคงสถานะ stopped ข้ามการ restart และจะไม่ auto-reconnect จนกด Start อีกครั้ง. หากเปลี่ยน custom/bundled client ขณะ runtime ทำงาน ระบบจะหยุดและยืนยัน owner เดิมก่อน commit path ใหม่เพื่อไม่ให้มี runtime ซ้อน

ตรงนี้ **ไม่ต้องพิมพ์ path ของ `lnwjud-mcp-stdio.cmd` เอง** Secure Tunnel ใช้ Desktop loopback HTTP MCP และ lnwjud จะสร้าง/ซ่อม `%APPDATA%\tunnel-client\lnwjud.yaml` ให้ `mcp.server_urls` ชี้ไป `http://127.0.0.1:<port>/mcp` พร้อมเก็บ `control_plane.api_key` เป็น `env:CONTROL_PLANE_API_KEY` แทน key จริง

### 4. ทดสอบแบบ Read-only ก่อน

ไม่ว่าจะเชื่อมด้วย OAuth หรือ Secure Tunnel ให้ลองงานที่ไม่แก้ไฟล์ก่อน เช่น:

```text
Use lnwjud to list registered workspaces, show Git status for the selected project, and summarize the top-level project tree. Do not modify anything.
```

ถ้าคำสั่งนี้ทำงานได้ แปลว่า ChatGPT เชื่อมถึง lnwjud Desktop MCP ผ่านวิธีที่เลือกครบแล้ว จากนั้นจึงค่อยลองงานเขียนไฟล์หรือคำสั่งที่ต้องมี native approval ใน Desktop

## Quick start: build from source

Requirements for source development:

- Windows x64.
- Node.js `>=24.0.0 <25`.
- Git.
- Corepack with the repository-pinned `pnpm@10.15.0`.
- PowerShell 7 recommended; Windows PowerShell 5.1 is sufficient for most helper
  scripts.
- `rg` (ripgrep) recommended.

```powershell
git clone https://github.com/engasnm111/lnwjud.git
Set-Location .\lnwjud
corepack enable
corepack pnpm@10.15.0 install --frozen-lockfile
Copy-Item .env.example .env

# Build all packages and the desktop app
corepack pnpm@10.15.0 build

# Launch the development desktop runtime
corepack pnpm@10.15.0 desktop
```

Optional Windows installer build:

```powershell
corepack pnpm@10.15.0 package:windows
```

The generated x64 NSIS installer is written under
`apps/desktop/dist/installers/`.

## Run in the Windows system tray

Closing the main lnwjud window hides it instead of shutting down the desktop
runtime. The MCP listener, Live Logs, tunnel controller, and background services
continue running and the lnwjud icon remains in the Windows notification area.
Use the tray menu to reopen the dashboard, check for updates, or quit the process
completely.

## The packaged stdio launcher

`lnwjud.exe` is the graphical desktop entrypoint. **Direct local STDIO clients**
such as Codex CLI should use the generated launcher below. Secure MCP Tunnel does
not use this launcher; it forwards to the Desktop loopback HTTP MCP:

```text
lnwjud-mcp-stdio.cmd --workspace D:\projects\my-app
```

The build generates `lnwjud-mcp-stdio.cjs`, `lnwjud-mcp-stdio.cmd`, and a
private `lnwjud-node.exe` copied from the pinned Node.js 24 build runtime.
These generated runtime files are intentionally ignored by Git. The Windows
package copies them next to the installed application and into its resources
directory, and the launcher uses only this bundled runtime rather than a system
Node installation or `PATH`.

### Bundled autonomous continuation skill (Setup and Portable)

Both `lnwjud-Setup-*.exe` and `lnwjud-Portable-*.exe` ship the same
`lnwjud-scheduled-continuation` skill under the packaged resources directory.
No repository checkout is required. `skills_list` returns this bundled skill
together with every discovered machine-global and active-workspace skill; it
does not replace the user's Cursor, Claude, Agents, Codex, Codex-plugin, GitHub
workspace, or configured extra roots.

When the client exposes skill names directly, a user on either distribution can
start the full autonomous chain with a prompt such as:

```text
Use $lnwjud-scheduled-continuation in workspace D:\projects\my-app. Create or resume goalKey release-audit, do the requested work autonomously until get_goal is terminal, then cancel the exact remaining successor and report once.
```

For clients that do not expose `$skill-name` syntax, ask the agent to call
`skills_list`, choose the source-qualified `lnwjud-scheduled-continuation`
result, call `skills_read`, and follow that skill. The first run creates or
resumes the durable goal, arms one adaptive one-time cloud watchdog, and keeps
working. A request to stop future scheduling cancels only that watchdog; the
current run must still inspect background task results and call `finish_goal`
before it reports completion. If `finish_goal` returns `status=active` with
`completionState=pending_native_cleanup`, follow the exact
`scheduledTaskCancellation` instruction through the native ChatGPT Scheduled
Task host, record the matching deletion or run receipt, then call `finish_goal`
again. Report completion only when the second call returns
`completionState=completed` and `get_goal` is terminal.

When that one-time task wakes, `claim_scheduled_continuation` is the mandatory
first action. An acquired claim and the next `prepared` reservation commit in
one transaction; the result already contains the successor and its
`scheduleRequest`, so the worker creates and records that exact native task and
does not call `prepare_scheduled_continuation` again. A repeated interrupted
claim returns `successor_required` with the same reservation. When that result
includes a `scheduleRequest` (a fresh reservation or a truthfully failed create
without a native task ID), reuse that exact request; when it includes
`native_task_receipt_missing`, `native_task_creation_uncertain`, or
`native_task_id_already_recorded`, reconcile the exact host metadata first and
never create blindly. A stale `create_failed` reservation may be refreshed to a
new lease-aligned adaptive due time only after the failure is truthful. A
one-time task that has already fired is consumed transport identity: collision,
early-fire recovery, and blocking-worker recovery retire/supersede that firing
ticket and reserve one fresh deterministic adaptive successor instead of trying
to update a host task that may already be gone. Same-task updates are reserved
for a still-pending future task through `expedite_scheduled_continuation`.
Durable reservation is machine-enforced, while actual cloud task creation
remains host-owned and is trusted only after its receipt is recorded.
In v4.52.1, Full Bypass cannot bypass this rolling-goal ownership fence: a stale
or missing `goalLease` is rejected before file, Git, process, delegated, or UI
mutation dispatch, so an older worker cannot keep writing after a successor has
taken ownership.

### STDIO permission profiles and strict roots

The packaged stdio launcher keeps `full` as its backward-compatible permission profile, but it no longer discovers or registers drive letters. Pass `--workspace` on first use; later launches may reuse an already registered project. You can opt into a narrower policy per launch:

```text
lnwjud-mcp-stdio.cmd --workspace D:\\projects\\my-app --profile safe --strict-roots --allowed-root D:\\projects\\my-app
```

Supported direct-stdio profiles are `safe`, `balanced`, `full`, and `custom`. Equivalent environment variables are `LNWJUD_STDIO_PROFILE`, `LNWJUD_STRICT_ROOTS`, and semicolon-separated `LNWJUD_ALLOWED_ROOTS`. OpenAI Secure MCP Tunnel does not use the headless stdio policy; it uses the running Desktop MCP permission profile, Active Project, and native host approval. No mode performs automatic whole-drive registration. With STDIO Full Bypass OFF, strict-root mode rejects absolute paths outside explicitly allowed canonical roots. STDIO Full Bypass ON intentionally overrides that lnwjud application boundary for explicit absolute paths. Strict roots are not an OS sandbox: spawned programs still run under the Windows user token.

### Full Access and Full Bypass

Selecting **Full** does not by itself enable unrestricted authorization. The separate **Desktop Full Bypass** and **STDIO Full Bypass** controls live under **Full Access (Unrestricted)**, default to OFF, and require an explicit acknowledgement when enabled. Desktop Full Bypass applies to Desktop HTTP and Secure Tunnel; direct STDIO uses its own independent flag.

While enabled, every call is marked `FULL BYPASS ON` and audited as `authorizationMode: full_bypass`. lnwjud skips the intended application authorization gates: always-confirm prompts for supported tools, chat confirmation, native host approval, profile and command policy, Active Project and allowed/Strict Roots, and protected-path policy. **It does not bypass durable rolling-goal ownership.** When a live scheduled-continuation fence exists for the workspace, mutating calls still require the current `goalLease`; missing, stale, expired, generation-mismatched, or past-handoff proof fails before the mutation handler runs. Explicit absolute paths/cwds outside a registered or active project can dispatch without asking only when no live rolling-goal fence requires ownership proof; relative traversal remains invalid. The trusted authorization travels out-of-band and lnwjud does not forge `userConfirmed: true`.

Full Bypass cannot override input/schema validation, file/process existence, task ownership, Windows ACL/UAC, antivirus/EDR, locks, missing runtimes, API credentials, remote-service or child-MCP policy, network errors, or operating-system limitations. Outside-project changes may be permanent because Recovery Trash/checkpoint pre-images are unavailable there.

With Full Bypass OFF, the **AI Destructive Actions** setting is deliberately narrow. Only the exact `delete_file` operation can be scoped auto-approved, and only when its saved policy is enabled, the target matches the host-selected Active Project, Recovery Trash is available, and the target is not a protected critical path, workspace root, non-empty directory, unsafe/broad pattern, outside path, or reparse escape. Other approval-required actions need explicit chat confirmation plus independent trusted host exact-action approval. Full Bypass ON supersedes these lnwjud approval/scope switches for its transport. Recovery Center derives the local Recovery Trash path from `<dataRoot>/recovery-trash`; arbitrary commands and outside-project changes are not promised Recovery Trash coverage.

## Requirements and optional integrations

### Core requirements

- Windows x64.
- Node.js 24.x for source development/builds. Installed releases bundle their own private Node 24 runtime for direct local STDIO; Secure Tunnel uses the Desktop HTTP MCP and official tunnel-client.
- Git/Corepack/pnpm for source development.

### Optional dependencies

- Codex CLI for `codex_*` delegation tools.
- `rg` for fast code search; lnwjud has bounded fallbacks where supported.
- Chrome/Chromium for managed CDP/browser capabilities.
- WSL for `wsl_exec` and `wsl_fs`.
- Microsoft Office applications for Office automation actions that require the
  native Office stack.
- FFmpeg and other media helpers for capabilities that report them as available.

### OpenAI / ChatGPT requirements for Secure MCP Tunnel

- An OpenAI Platform organization with tunnel access.
- A tunnel associated with the intended Platform organization and ChatGPT
  workspace.
- **Tunnels Read + Manage** to create/edit a tunnel.
- **Tunnels Read + Use** to run `tunnel-client` or select a tunnel in the ChatGPT
  app flow.
- ChatGPT Developer mode access according to the target plan/workspace policy.
- Outbound HTTPS from the Windows host to `api.openai.com:443` (or the documented
  mTLS control-plane host when configured).
- No inbound firewall rule or public lnwjud MCP port is required for Secure MCP
  Tunnel.

## Install from source

### Clone and install dependencies

```powershell
git clone https://github.com/engasnm111/lnwjud.git
Set-Location .\lnwjud
corepack pnpm@10.15.0 install --frozen-lockfile
```

Do not silently upgrade the package manager: the lockfile is pinned to
pnpm@10.15.0.

### Configure Environment

```powershell
Copy-Item .env.example .env
```

### Build and run the desktop dashboard

One command from the repository root:

```powershell
Set-Location .\lnwjud
corepack pnpm@10.15.0 desktop
```

This builds the desktop app and opens the Agent Control Center. MCP HTTP
auto-starts on launch (no Start Connection click required). The dashboard owns
the SQLite state, workspace registry, permission profile, work-log audit
records, loopback MCP lifecycle, and Secure Tunnel controls.

Optional environment:

```powershell
$env:LNWJUD_DATA_PATH = "$env:LOCALAPPDATA\lnwjud"
$env:LNWJUD_WORKSPACE = "D:\projects\my-app"
corepack pnpm@10.15.0 desktop
```

Use the same `LNWJUD_DATA_PATH` for desktop UI and the packaged stdio launcher
so ChatGPT tool activity appears in the Work Log. The launcher is the same
direct MCP entrypoint used by the Codex/tunnel integration.

### Build Windows installer + portable executable

```powershell
Set-Location .\lnwjud
corepack pnpm@10.15.0 package:windows
```

The Windows 10/11 x64 artifacts are written to:

```text
apps/desktop/dist/installers/lnwjud-Setup-4.52.1.exe
apps/desktop/dist/installers/lnwjud-Portable-4.52.1.exe
```

The installer is per-user by default. The portable executable needs no installation but uses the same per-user lnwjud data/settings location. A common installed executable path is:

```text
C:/Users/<WindowsUser>/AppData/Local/Programs/lnwjud/lnwjud.exe
```

Always use the path shown by the installed shortcut or Get-Command.

## Configure the local desktop application

### Add a workspace

1. Start lnwjud (`pnpm desktop` or the installed app).
2. On Home or Projects, add the project directory path.
3. The selected project is persisted; switching projects restarts MCP automatically.
4. Desktop MCP uses the selected Permission profile; stdio/tunnel MCP uses its separately configured STDIO profile (backward-compatible default: `full`) and optional Strict Roots.
5. Run Doctor from the sidebar if a dependency is reported missing.

### Tool readiness and Doctor

The Desktop **Tools** page is generated from the live first-party `ToolRegistry` plus separately discovered External MCP servers. It does not maintain a hand-written tool count. Each tool shows its declared permission, the active profile decision, dependency requirements, and one of six readiness states: `ready`, `needs_setup`, `blocked`, `disabled`, `unsupported`, or `unknown`. `unknown` means lnwjud could not safely prove readiness; it is never treated as success.

Readiness probes are read-only/owned status checks with bounded timeouts and caching. They never prove readiness by invoking the tool, creating project files, controlling user input, opening an Office document, or running a project command. Changing language reuses the same cached requirement snapshot rather than reprobeing the machine.

**Doctor** uses the same requirement/remediation snapshot as Tools. Failed, unknown, and warning checks are shown before passed checks, affected tool names are listed, and selected **Recheck** refreshes both Doctor and Tools together. Required `fail` or `unknown` startup checks do not count as a successful startup gate; optional failures remain visible without blocking onboarding. Remediation actions are typed and allowlisted: they can navigate to the exact app setting, open Windows Optional Features, open an official URL, copy an allowlisted command, start lnwjud's managed browser, enable only the explicit Codex opt-in, or recheck selected requirements. Disabled/planned tools that are not actually enable-able say so instead of pointing at an unrelated setting; renderer/server text cannot inject an arbitrary URL or command.

External MCP tools stay in their own origin/tab. When lnwjud cannot verify a child server's internal permission, cancellation, dry-run, or readiness semantics, those fields remain `UNKNOWN` instead of inheriting first-party claims.

Every file operation resolves the supplied path against a registered workspace,
canonicalizes existing parents/targets, rejects traversal and reparse-point
escapes, and applies the secret policy after resolution.

### Permission profiles

| Profile | READ | WRITE | EXECUTE | DANGEROUS | Intended use |
| --- | --- | --- | --- | --- | --- |
| safe | allow | ask | ask | deny | Read and approve changes carefully |
| balanced | allow | allow | allow | ask | Normal development |
| full | allow | allow | allow | allow | Explicitly trusted local automation |
| custom | configured | configured | configured | configured | Host-defined policy |

Desktop MCP honors the selected profile for every MCP tool, including local
capabilities. The packaged stdio/tunnel runtime keeps **full** as the
backward-compatible default, but accepts `safe`, `balanced`, `full`, or `custom`
through the launcher/environment/Desktop STDIO policy settings; optional Strict
Roots can further constrain visible roots. This policy is stored separately from
the Desktop MCP profile. Unrestricted mode remains the compatibility default for
explicit absolute-path read/discovery when Strict Roots is not enabled, but it
does not enumerate or register drives. With Full Bypass OFF it does not broaden the host Active Project mutation boundary; Full Bypass ON is the explicit exception.
The exact recoverable `delete_file` is the only mutation that can use scoped
auto-approval. Destructive Git forms that would rewrite/discard/delete state are
blocked when policy cannot prove a safe supported mutation; any allowed opaque
mutation still requires explicit chat confirmation and independent host
exact-action approval when Full Bypass is OFF. When Full Bypass is ON, lnwjud skips those application checks; operating-system and external-service failures remain possible.

### Optional local capability roots

The local desktop capability layer can receive additional roots through the
semicolon-separated environment variable LNWJUD_CAPABILITY_ROOTS:

```powershell
$env:LNWJUD_CAPABILITY_ROOTS = 'E:/work;E:/projects'
```

Local capabilities use registered projects and explicitly configured roots; they
never add A:–Z: automatically. `LNWJUD_CAPABILITY_ROOTS` is optional extra
configuration. With Full Bypass OFF, core file
tools still require a registered workspace and mutation-capable tools use the exact
Active Project plus normal confirmation/host-approval boundaries. Full Bypass ON
permits explicit absolute outside targets while retaining schema, existence, and OS checks.

### Local Streamable HTTP connection

The desktop runtime auto-starts the loopback MCP server after resolving the
selected workspace. In the dashboard:

1. Select a registered workspace.
2. Copy the displayed endpoint, normally `http://127.0.0.1:18765/mcp`.
3. Add it to a compatible local Streamable HTTP MCP client.
4. Use **Stop Connection** when you intentionally want to stop the listener.
5. Use **Start Connection** to start it again after a manual stop.

The endpoint binds to 127.0.0.1, validates origin/host, and uses the same
application services and permission checks as the dashboard. Do not expose the
loopback URL through a generic port forward.

If dom_cdp is available, the dashboard can launch managed Chrome. Browser
automation remains loopback-bound and separate from the file guard.

For every page-targeted browser operation, use this fail-closed targeting flow:

1. Call `dom_cdp` with `action: "list_tabs"`.
2. Match the intended existing tab using its returned exact ID together with the inspected URL/title.
3. If there is no safe match, call `dom_cdp` with `action: "new_tab"` and retain that returned ID.
4. Pass the same top-level `tab_id` to every target-scoped call or `steps` batch.
5. If that target disappears, stop and list tabs again; never substitute the first or OS-active tab.
6. Never navigate a web page by focusing or typing into the browser address bar as a fallback.

Mutating a ChatGPT tab has an additional hard boundary: the request must include
`allow_protected_tab_action: true` and real `userConfirmed: true`. Full Bypass
does not satisfy or manufacture that explicit-user confirmation.

## Connect a local Codex client

Local Codex clients can use stdio directly; they do not need Secure MCP Tunnel.
Point the entry at the stdio-capable installed executable:

```powershell
codex mcp add lnwjud -- "$env:LOCALAPPDATA\Programs\lnwjud\lnwjud-mcp-stdio.cmd" --workspace D:\Projects\my-app
codex mcp list
```

The stdio launcher is `lnwjud-mcp-stdio.cmd` shipped next to the desktop app
(not the GUI `lnwjud.exe`). It exposes the full tool catalog, including
skills/MCP bridge meta-tools, and uses the bundled private `lnwjud-node.exe`;
no separate Node.js installation is required for an installed release.

The same server can be added in ChatGPT desktop or an IDE extension under
Settings → MCP servers → Add server → STDIO. Restart the host after saving.
In Codex, /mcp lists active servers.

Example user-scoped or trusted project-scoped config.toml:

```toml
[mcp_servers.lnwjud]
command = "C:/Users/<WindowsUser>/AppData/Local/Programs/lnwjud/lnwjud-mcp-stdio.cmd"
args = ["--workspace", "E:/lnwjud"]
startup_timeout_sec = 20
tool_timeout_sec = 3600
```

Use prompt approval while testing an unfamiliar workspace. No OpenAI API key
belongs in this local MCP entry.

## Create an OpenAI Secure MCP Tunnel

This is the path that lets ChatGPT web, which cannot read local files or local
Codex configuration, call lnwjud.

### 1. Create or select a Platform tunnel

Open [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
Create a tunnel and record its ID, for example:

```text
tunnel_0123456789abcdef0123456789abcdef
```

Associate the tunnel with the Platform organization that owns it, the target
ChatGPT workspace, and any other Platform organization that will call it. The
same tunnel_id is used by every association.

### 2. Create the correct runtime key

Open [OpenAI Platform API keys](https://platform.openai.com/settings/organization/api-keys).
Create a runtime API key for tunnel-client and grant Tunnels Read + Use.

Do not use an Admin API key or an unrelated project key (sk-proj-...). Keep the
key in a local secret store or environment variable. Never put it in this
repository, a YAML profile, a committed .env file, or a public issue/log. If a
key is exposed, revoke it and create a replacement.

### 3. tunnel-client for installed releases

The Windows x64 installer already bundles official OpenAI
`tunnel-client v0.0.13`, so normal installed-release setup requires no separate
download or stable external executable path. The Settings path field is only a
manual override/troubleshooting control.

For manual CLI troubleshooting or source-development scenarios, define `$tc`
explicitly for the client you intentionally want to test:

```powershell
$tc = 'C:/path/to/tunnel-client.exe'
& $tc --version
```

### 4. Create a Desktop HTTP profile

For installed releases, prefer **Settings → OpenAI Secure MCP Tunnel → Configure Tunnel**.
The desktop starts or reuses its loopback MCP endpoint and repairs a stale profile
automatically. Manual initialization is still supported when you need it:

```powershell
$env:CONTROL_PLANE_API_KEY = '<runtime-key-for-this-session>'
$mcpEndpoint = 'http://127.0.0.1:<port>/mcp' # copy the actual Local MCP endpoint shown by lnwjud

& $tc init --force --sample sample_mcp_remote_no_auth --profile lnwjud --tunnel-id 'tunnel_0123456789abcdef0123456789abcdef' --control-plane-api-key-ref 'env:CONTROL_PLANE_API_KEY' --health-listen-addr '127.0.0.1:0' --mcp-server-url $mcpEndpoint
```

The Secure Tunnel profile stores a loopback HTTP MCP URL and an
`env:CONTROL_PLANE_API_KEY` secret reference instead of a source-tree command or
literal runtime key. Direct local stdio hosts can still use
`lnwjud-mcp-stdio.cmd`, but the OpenAI Secure Tunnel path intentionally goes
through the Desktop HTTP runtime so Active Project selection and native approval
stay host-owned.

### 5. Run diagnostics and the tunnel

Prefer the desktop Control Center: save the Runtime API key once under Settings,
then click Start Tunnel. The key is stored with Windows DPAPI.

Manual session (still supported):

```powershell
$env:CONTROL_PLANE_API_KEY = '<runtime-key-for-this-session>'
$env:MCP_CONNECTION_MAX_TTL = '168h0m0s'
& $tc doctor --profile lnwjud --explain
if ($LASTEXITCODE -ne 0) { throw 'tunnel-client doctor failed' }
& $tc run --profile lnwjud --mcp.connection-max-ttl 168h0m0s
```

Keep lnwjud and `tunnel-client` running while ChatGPT is using the connector.
The tunnel forwards to lnwjud's Desktop loopback HTTP MCP, so Work Log entries,
Active Project selection, and native approval remain in the same Desktop runtime.

### 6. Verify the tunnel target locally

```powershell
Test-Path -LiteralPath $tc
Get-Content (Join-Path $env:APPDATA 'tunnel-client\lnwjud.yaml') | Select-String 'server_urls:|url:'
```

The `main` MCP channel must point to a loopback URL ending in `/mcp` (for
example `http://127.0.0.1:<port>/mcp`). It must not point to a source checkout,
a public/LAN MCP address, or `lnwjud-mcp-stdio.cmd` for the Secure Tunnel flow.

## Advanced: manual tunnel runner at Windows logon

Normal installed-release users should use the Desktop persistent tunnel runtime
and its reconnect controls; the bundled tunnel-client requires no separate
scheduled task. The example below is only for an intentionally manual runner.
It stores the runtime key encrypted with the current Windows user's DPAPI; the
key is not written in plain text to the profile or task command line.

### Save the key once

```powershell
$secretDir = Join-Path $env:APPDATA 'tunnel-client'
New-Item -ItemType Directory -Path $secretDir -Force | Out-Null
$secureKey = Read-Host 'Tunnel runtime API key' -AsSecureString
$secureKey | ConvertFrom-SecureString | Set-Content (Join-Path $secretDir 'lnwjud.runtime.secret')
```

The encrypted value is tied to the same Windows user and machine.

### Create a runner script

Save as start-lnwjud-tunnel.ps1:

```powershell
$ErrorActionPreference = 'Stop'
$tc = 'C:/path/to/tunnel-client.exe' # advanced manual override only
$profile = 'lnwjud'
$secretPath = Join-Path $env:APPDATA 'tunnel-client/lnwjud.runtime.secret'

if (-not (Test-Path $tc)) { throw "Missing tunnel-client: $tc" }
if (-not (Test-Path $secretPath)) { throw "Missing encrypted runtime key: $secretPath" }

$encrypted = Get-Content $secretPath -Raw
$secureKey = ConvertTo-SecureString $encrypted
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  & $tc doctor --profile $profile --explain
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $tc run --profile $profile
  exit $LASTEXITCODE
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
}
```

### Register the logon task

Run once as the same Windows user who saved the DPAPI secret:

```powershell
$runner = 'C:/path/to/start-lnwjud-tunnel.ps1'
$userId = "$env:USERDOMAIN/$env:USERNAME"
$argument = '-NoProfile -ExecutionPolicy Bypass -File "' + $runner + '"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType InteractiveToken -RunLevel Limited
Register-ScheduledTask -TaskName 'lnwjud Secure MCP Tunnel' -Action $action -Trigger $trigger -Principal $principal -Force
```

Check or start it:

```powershell
Get-ScheduledTask -TaskName 'lnwjud Secure MCP Tunnel'
Start-ScheduledTask -TaskName 'lnwjud Secure MCP Tunnel'
```

Use Run only when user is logged on and a limited principal unless your
organization has a documented service-account design. lnwjud does not need an
administrator token for normal workspace operations.

## Add the connector in ChatGPT Developer mode

### Enable Developer mode

In ChatGPT web:

1. Open Settings.
2. Select Security and login.
3. Turn on Developer mode.

Enterprise/Edu administrators may need to enable this before it appears.

### Create the developer app

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins).
2. Select the plus (+) button.
3. Enter a name such as lnwjud and a short description such as
   Local Windows development workspace gateway.
4. Under Connection, choose Tunnel.
5. Select the tunnel or enter its tunnel_id.
6. Create the connection and review the discovered tools and schemas.

lnwjud v4.52.0 contains a local desktop OAuth sign-in framework for Tunnel credential provisioning, but it is enabled only when a configured provider explicitly supports the official Secure MCP Tunnel runtime-credential contract. Do not invent OAuth URLs, reuse ChatGPT/Codex browser-session tokens, or paste the runtime key into the ChatGPT connector form. Tunnel transport authentication remains handled by tunnel-client; ChatGPT selects the OpenAI-hosted tunnel. Choose a no-extra-auth option only when the tunnel form offers it.

### Attach it to a new chat

Start a new conversation, open the tools menu, and add the lnwjud connection.
A good smoke test is:

```text
Use lnwjud to inspect the available workspace and report only registered workspace IDs and display names. Do not read file contents yet.
```

Then test a read-only project flow:

```text
For workspace <workspace-id>, show the project snapshot, Git status, and the top-level workspace tree. Do not modify anything.
```

After changing tool metadata or restarting the tunnel, refresh the connector and continue in the same chat. Start a new chat only if Refresh connector does not clear a stale schema.

<!-- BEGIN GENERATED README TOOL REGISTRY -->
## Complete MCP tool catalog (231 total definitions; 224 advertised by default; 231 with Codex delegation plus Agent Swarm enabled)

This complete index is generated from `ToolRegistry.listAll()`, not copied from an older release document. The default `tools/list` surface advertises only operational or dependency-gated definitions; planned and feature-disabled definitions remain visible here without being advertised. Enabling Codex delegation plus Agent Swarm adds seven opt-in definitions to the advertised surface.

| # | Tool | Permission | Advertised | Delivery | Runtime evidence | Runtime description |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `workspace_list` | READ | default | operational | service_dispatch | List registered project workspaces available to lnwjud. Legacy explicitly registered drive roots may also appear as kind=machine_root. |
| 2 | `workspace_register` | WRITE | default | operational | service_dispatch | Register an existing project directory by absolute path. parentWorkspaceId is optional and retained only for legacy machine-root-relative registration. Idempotent for the same path. |
| 3 | `workspace_info` | READ | default | operational | service_dispatch | Return the configured workspace summary. |
| 4 | `workspace_tree` | READ | default | operational | service_dispatch | List a bounded workspace tree. Absolute path does not require workspaceId. |
| 5 | `project_snapshot` | READ | default | operational | service_dispatch | Return a bounded project snapshot without source contents. |
| 6 | `read_file` | READ | default | operational | service_dispatch | Read a workspace file as UTF-8 text or as an image/binary payload. Absolute paths (C:\...) do not require workspaceId. For large files or an unknown location, prefer search_text first and then read_file_page for the relevant range instead of reading the whole file. |
| 7 | `read_files` | READ | default | operational | service_dispatch | Read up to twenty bounded workspace files in parallel. Absolute paths do not require workspaceId. For large files, locate text with search_text and page with read_file_page instead of loading entire files. |
| 8 | `search_files` | READ | default | operational | service_dispatch | Search workspace filenames with automatic context-economy filters; set includeIgnored for an explicit full path search. Absolute path does not require workspaceId. |
| 9 | `search_text` | READ | default | operational | service_dispatch | Preferred tool to locate relevant code/lines before reading files. Searches workspace text using direct ripgrep arguments with automatic binary/generated filters; set includeIgnored for an explicit full path search. Absolute path does not require workspaceId. Follow with read_file_page for large files. |
| 10 | `git_status` | READ | default | operational | service_dispatch | Inspect parsed read-only Git status. For writes (init, add, commit, remote, push, rm, clean, reset) use the git tool. |
| 11 | `git_diff` | READ | default | operational | service_dispatch | Return a bounded read-only Git diff. For writes use the git tool. |
| 12 | `git_log` | READ | default | operational | service_dispatch | Return bounded structured Git history. For writes use the git tool. |
| 13 | `git` | EXECUTE | default | operational | service_dispatch | Run a Git subcommand with a separate args array. With Full Bypass OFF, Full Access runs ordinary read and non-destructive Git mutations without confirmation while destructive/data-loss forms, scope overrides, aliases, unsafe pathspecs, unknown commands, and destructive remote/history rewrites remain guarded or denied. Trusted Full Bypass skips lnwjud approval, command-policy, and Active Project scope checks, including explicitly absolute outside paths, without bypassing Git or OS errors. Do not wrap Git in PowerShell/cmd. |
| 14 | `write_file` | WRITE | default | operational | service_dispatch | Create or replace a UTF-8 text file and missing parents. Balanced/Safe refuse existing targets unless overwriteExisting is explicit; Full may replace an existing target without a confirmation prompt and still creates a checkpoint. Prefer edit_file for narrow repairs. Use this instead of shell scripts that call fs.writeFile, writeFileSync, Set-Content, or equivalent when the task is simply to create or replace guarded text. |
| 15 | `apply_patch` | WRITE | default | operational | service_dispatch | Apply reviewed whole-file replacement content to at most twenty files. Existing targets are checkpointed first; Full profile does not prompt for non-destructive replacement. Prefer edit_file for narrow repairs. Use this instead of shell-generated whole-file rewrites when several reviewed text files must change. |
| 16 | `edit_file` | WRITE | default | operational | service_dispatch | First choice for narrow source, config, and text repairs. Replaces exact text only when the expected occurrence count matches, checkpoints the original, and refuses conflicts instead of rewriting an unverified whole file. Use edit_file instead of shell, node -e, python -c, PowerShell Set-Content, or inline filesystem scripts when a guarded text edit can express the change. Full Access performs ordinary edits without a confirmation prompt; destructive deletion remains separately guarded. |
| 17 | `move_file` | WRITE | default | operational | service_dispatch | Move a file or directory, creating missing destination parents. With Full Bypass OFF, Full Access performs ordinary in-project moves without a confirmation prompt while conflicting or destructive forms remain policy-gated. Trusted Full Bypass skips lnwjud approval/scope checks for explicit absolute outside paths; OS/filesystem errors still apply. |
| 18 | `copy_file` | WRITE | default | operational | service_dispatch | Copy a file or directory within one workspace, creating missing destination parents. |
| 19 | `delete_file` | DANGEROUS | default | operational | service_dispatch | Delete one file or empty directory. With Full Bypass OFF, eligible in-project targets move to Recovery Trash and exact safe targets can use scoped auto-approval; critical paths, roots, non-empty directories, ambiguous paths, and mismatched workspaces remain guarded. Trusted Full Bypass skips lnwjud approval/scope checks and permits an exact absolute outside target, which is deleted without Recovery Trash; root and non-empty-directory input guards still apply. |
| 20 | `list_recovery_items` | READ | default | operational | service_dispatch | List trusted Recovery Trash entries for one workspace, including deleted items, binary pre-replacement backups, original paths, timestamps, payload availability, and the local Recovery Trash root. |
| 21 | `restore_deleted_file` | WRITE | default | operational | service_dispatch | Restore one Recovery Trash item to its original path. Deleted-item restores refuse existing targets. A pre-replacement restore first backs up the current live version for undo, then restores the older binary or text payload. Full runs recoverable restores without an extra prompt; stricter profiles may require confirmation. The operation remains scoped to the recorded workspace. |
| 22 | `list_checkpoints` | READ | default | operational | service_dispatch | List encrypted pre-mutation checkpoints for one workspace without returning saved file content. |
| 23 | `restore_checkpoint` | WRITE | default | operational | service_dispatch | Restore a reviewed pre-mutation checkpoint. Standard mode requires explicit confirmation; trusted Full Bypass skips the lnwjud confirmation gate. A new rollback checkpoint is created before replacing current content when the target is inside a recoverable workspace. |
| 24 | `process_start` | EXECUTE | default | operational | service_dispatch | Immediate-return managed process launcher for real executables and long-lived processes. With Full Bypass OFF, inline text-file rewrites must use edit_file/apply_patch/write_file and risky commands, scope changes, or permission-profile ASK decisions require confirmation. Trusted Full Bypass skips lnwjud command/profile/scope approval, including an explicitly absolute cwd outside the Active Project; input validation, executable availability, OS rights, and exact process ownership still apply. Starts one executable with separate arguments and returns processId as soon as the child is spawned; it never waits for command completion. Follow with process_status/process_logs/process_stop. For restart-safe durable work, use shell, whose MCP run mode is forced to background. |
| 25 | `process_list` | READ | default | operational | service_dispatch | List managed process handles owned by this client in a workspace, including launches whose response was cancelled. |
| 26 | `process_status` | READ | default | operational | service_dispatch | Read one status snapshot for an owned process handle. Do not tight-poll this tool; use project_* for normal project verification, or shell background + durable task_id for work expected to exceed ~5 minutes. |
| 27 | `process_logs` | READ | default | operational | service_dispatch | Read bounded logs for an owned process handle. Prefer one bounded log read after meaningful progress rather than repeated status polling. |
| 28 | `process_stop` | EXECUTE | default | operational | service_dispatch | Stop an owned managed process tree after explicit chat confirmation in standard mode. Trusted Full Bypass skips the lnwjud confirmation gate; exact process ownership still applies. |
| 29 | `project_dev` | EXECUTE | default | operational | service_dispatch | Immediate-return launcher for the detected project dev command. In standard mode the gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Trusted Full Bypass skips the lnwjud approval boundary. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 30 | `project_test` | EXECUTE | default | operational | service_dispatch | Immediate-return launcher for the detected project test command. In standard mode the gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Trusted Full Bypass skips the lnwjud approval boundary. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 31 | `project_lint` | EXECUTE | default | operational | service_dispatch | Immediate-return launcher for the detected project lint command. In standard mode the gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Trusted Full Bypass skips the lnwjud approval boundary. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 32 | `project_typecheck` | EXECUTE | default | operational | service_dispatch | Immediate-return launcher for the detected project typecheck command. In standard mode the gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Trusted Full Bypass skips the lnwjud approval boundary. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 33 | `project_build` | EXECUTE | default | operational | service_dispatch | Immediate-return launcher for the detected project build command. In standard mode the gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Trusted Full Bypass skips the lnwjud approval boundary. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 34 | `codex_status` | READ | Codex opt-in | operational | service_dispatch | Report local Codex installation and capabilities without credential inspection. |
| 35 | `codex_run` | EXECUTE | Codex opt-in | operational | service_dispatch | Delegate an instruction to the local Codex CLI in the Active Project. Starting Codex requires explicit chat confirmation and host approval in standard mode; trusted Full Bypass skips those lnwjud application checks without forging userConfirmed. |
| 36 | `codex_task_list` | READ | Codex opt-in | operational | service_dispatch | List local Codex task handles owned by this client, including launches whose response was cancelled. |
| 37 | `codex_task_status` | READ | Codex opt-in | operational | service_dispatch | Read status for an owned Codex task. |
| 38 | `codex_task_logs` | READ | Codex opt-in | operational | service_dispatch | Read bounded logs for an owned Codex task. |
| 39 | `codex_stop` | EXECUTE | Codex opt-in | operational | service_dispatch | Stop an owned Codex task process after explicit chat confirmation in standard mode. Trusted Full Bypass skips the lnwjud confirmation gate; task ownership still applies. |
| 40 | `agent_swarm_run` | EXECUTE | Codex opt-in | dependency_gated | service_dispatch | Run or inspect a bounded 1-4 task Codex-backed agent swarm in enforced read-only mode. The tool is available only when Codex tools are explicitly enabled. start/cancel require trusted host approval; status/result/list are owner-scoped reads. Prompts are never persisted in plaintext and unverifiable post-restart tasks report termination_unverified. |
| 41 | `shell` | EXECUTE | default | operational | service_dispatch | Non-blocking command runner for real command execution, builds/tests, package managers, and system operations. Never use shell as a source/config/text editor. For any direct text-file change, call edit_file first; use apply_patch for reviewed whole-file or multi-file replacements and write_file for file creation/replacement. Inline Node/Python/PowerShell/sed commands that rewrite text files are rejected before native approval so the client can route to the guarded file tools instead. MCP run calls are ALWAYS forced to execution=background, even if a client requests foreground or auto, so the call returns a task_id immediately instead of waiting for command completion. Follow with status/logs/result; wait uses the user-configurable MCP poll window (5-60 seconds, default 5). When the user requires babysitting until completion, keep using bounded waits and do not report completion until the terminal result is inspected. Otherwise, if the host turn must yield while a durable task is still running, checkpoint it as trackedTasks {taskId, provider: shell, role: blocking_job, cancelWithGoal: true} and use the active scheduled-continuation handoff instead of abandoning the goal. Shared services must be marked supporting_service with cancelWithGoal false. With Full Bypass OFF, Full Access runs ordinary policy-allowed commands without confirmation while destructive, broad, recursive, critical, outside-project, or unparseable forms retain normal approval/command policy. Trusted Full Bypass skips lnwjud approval, command-policy, Active Project, goalLease, and allowed-root checks, including an explicitly absolute cwd outside the project; input validation, executable availability, Windows ACL/UAC, and child-process failures still apply. dry_run and task observation are non-mutating. |
| 42 | `dom_cdp` | READ | default | operational | service_dispatch | Default for web-page DOM work inside managed Chrome. Call list_tabs first, select the exact returned tab_id by URL/title, and pass that tab_id to every query, click, type, navigate, evaluate, wait, screenshot, close, or steps call. If no safe matching tab exists, call new_tab and use its returned ID. Target order and the OS-active tab are never ownership signals. Never navigate through the browser address bar with computer_use/accessibility/input_event. Protected ChatGPT tab mutations additionally require allow_protected_tab_action=true plus explicit user confirmation. |
| 43 | `computer_use` | EXECUTE | default | operational | service_dispatch | Codex-style native Windows computer use for testing desktop apps. Take annotated screenshots, inspect semantic controls, and operate by semantic target, numbered visual mark, or explicit coordinates. Routes through Accessibility first and uses guarded pointer/keyboard input only when needed. Supports click, typing, keys, hotkeys, scroll, drag, pointer movement, and window activation. For web navigation, do not focus/type into a browser address bar; use dom_cdp list_tabs/new_tab plus an explicit tab_id. |
| 44 | `accessibility` | READ | default | operational | service_dispatch | Semantic native Windows UI tool. Inspect UI trees and named controls, then click, focus, read or set values, select controls and menus, or manage a native element. Prefer shell for direct system work and dom_cdp for web pages. |
| 45 | `input_event` | EXECUTE | default | operational | service_dispatch | Low-level keyboard and pointer fallback. Use only when DOM/CDP and Accessibility cannot operate the target. Supports text, keys, mouse movement, clicks, drag, scroll, held buttons, release_all, and batched sequences. For web navigation, do not focus/type into a browser address bar; use dom_cdp list_tabs/new_tab plus an explicit tab_id. |
| 46 | `vision` | READ | default | operational | service_dispatch | Visual and OCR fallback for content unavailable through DOM or Accessibility. Capture a display, window, or region, or run local Vision OCR. It never clicks or types. |
| 47 | `vision_annotated_capture` | READ | default | operational | service_dispatch | Capture a local Windows screen/region/window and return a short-lived Set-of-Marks observation with numbered bounds, a content hash, and an annotated PNG. This tool only observes; use ui_target_action for a separately gated action. |
| 48 | `ui_target_action` | EXECUTE | default | operational | service_dispatch | Act on one mark from a current vision_annotated_capture observation. The observation ID, optional hash, TTL, workspace owner, and current Accessibility element are checked before the action is sent. |
| 49 | `window` | EXECUTE | default | operational | service_dispatch | Direct native Windows window management. List, inspect, activate, move, resize, minimize, maximize, restore, or close windows without raw coordinates when a window operation is sufficient. |
| 50 | `health` | READ | default | operational | service_dispatch | Diagnostics only. Check all lnwjud backends or one public tool after a failure, when asked for status, or while diagnosing permissions. Do not use as a preflight before normal work. |
| 51 | `system_info` | READ | default | operational | service_dispatch | Read-only system information: OS, CPU, memory, disks, battery, uptime, and top processes by memory. Use for environment checks and diagnostics. |
| 52 | `notification` | EXECUTE | default | operational | service_dispatch | Show a Windows notification (toast when BurntToast is installed, balloon otherwise). Use to tell the user when a long task finishes. |
| 53 | `file_dialog` | EXECUTE | default | operational | service_dispatch | Open a native Windows file open/save dialog and return the chosen path(s). The dialog does not read or write files itself; use the guarded file tools afterwards. |
| 54 | `clipboard` | EXECUTE | default | operational | service_dispatch | Read or write the Windows clipboard (text, or PNG image as base64). Use get_text/get_image to read and set_text to write. |
| 55 | `web_fetch` | READ | default | operational | service_dispatch | Fetch an http/https URL (GET/POST/PUT/DELETE/HEAD) with bounded size and timeout. In standard mode every POST, PUT, or DELETE requires explicit chat confirmation and host approval; trusted Full Bypass skips lnwjud approval. dry_run remains safe. Returns status, headers, and text or base64 body. |
| 56 | `audio` | EXECUTE | default | operational | service_dispatch | Record the microphone to a WAV file or play a local audio file through MCI. In standard mode recording requires the host-selected Active Project workspaceId and explicit confirmation; trusted Full Bypass skips lnwjud approval/scope checks. Existing in-workspace outputs use Recovery Trash before replacement when available. record is synchronous and limited to 600 seconds. Use stop to abort an ongoing record/play. |
| 57 | `screen_record` | EXECUTE | default | operational | service_dispatch | Record the screen to an MP4 using ffmpeg gdigrab (requires ffmpeg on PATH). In standard mode starting a recording requires the host-selected Active Project workspaceId and explicit confirmation; trusted Full Bypass skips lnwjud approval/scope checks. Existing in-workspace outputs use Recovery Trash before replacement when available. start spawns a background capture, status checks it, stop finalizes the file. Recording stops automatically after 3600 seconds. |
| 58 | `office` | WRITE | default | operational | service_dispatch | Automate Excel, Word, PowerPoint, or Outlook through COM. In standard mode every write, replace, merge, or save_as action requires an Active Project workspaceId, explicit chat confirmation, and host approval. Trusted Full Bypass skips lnwjud approval/scope checks without forging userConfirmed. Existing in-workspace targets use Recovery Trash before replacement when available. Requires Microsoft Office installed. |
| 59 | `scheduler` | EXECUTE | default | operational | service_dispatch | Manage Windows scheduled tasks with schtasks.exe. list is read-only; in standard mode create, run, and delete require explicit chat confirmation and host approval. Trusted Full Bypass skips lnwjud approval without forging userConfirmed. |
| 60 | `wsl_exec` | EXECUTE | default | operational | service_dispatch | Non-blocking WSL2 developer runner for one Linux executable plus argv; shell command strings are not accepted. Do not use wsl_exec as a source/config/text editor. For any direct text-file change, call edit_file first; use apply_patch for reviewed whole-file or multi-file replacements and write_file for file creation/replacement. Inline Node/Python/PowerShell-style rewrites and sed in-place edits are rejected before native approval so the client can route to guarded file tools. MCP run calls are ALWAYS forced to execution=background, even if a client requests foreground or auto, and return a task_id immediately. Follow with status/logs/result; wait uses the user-configurable MCP poll window (5-60 seconds, default 5). When the user requires babysitting until completion, keep using bounded waits and do not report completion until the terminal result is inspected. Otherwise, if the host turn must yield while a durable task is still running, checkpoint it as trackedTasks {taskId, provider: shell, role: blocking_job, cancelWithGoal: true} and use the active scheduled-continuation handoff instead of abandoning the goal. With Full Bypass OFF, Full Access runs ordinary WSL commands without confirmation while destructive, broad, recursive, outside-project, or unparseable forms retain normal approval/command policy. Trusted Full Bypass skips lnwjud approval, command-policy, Active Project, goalLease, and allowed-root checks, including an explicitly requested external cwd; WSL availability, argv validation, Linux permissions, and process failures still apply. |
| 61 | `wsl_fs` | READ | default | operational | service_dispatch | Translate paths and inspect metadata between a registered Windows workspace and WSL without exposing raw \\wsl$ read/write access. |
| 62 | `skills_list` | READ | default | operational | service_dispatch | List the union of bundled skills and every discovered machine-global or active-workspace skill from Cursor, Claude, Agents, Codex, the Codex plugin cache, GitHub workspace roots, and lnwjud settings. Nested and symlinked skill collections are included. Filter with query or source. |
| 63 | `skills_read` | READ | default | operational | service_dispatch | Read a local skill SKILL.md (or a relative file inside the skill folder). Prefer the source-qualified id returned by skills_list; an unambiguous bare name or $name is also accepted. Follow the skill instructions with lnwjud tools and mcp_call. |
| 64 | `mcp_list` | READ | default | operational | service_dispatch | List local MCP servers discovered from Cursor, Claude Desktop, and lnwjud settings. This inspection is read-only and does not flatten child tools into the lnwjud catalog. |
| 65 | `mcp_describe` | READ | default | operational | service_dispatch | Connect to one local MCP server (if needed) and return its tool names, descriptions, and input schemas. This operation only inspects the child tool catalog. |
| 66 | `mcp_call` | DANGEROUS | default | operational | service_dispatch | Call a tool on a discovered local MCP server. Child side effects and filesystem/network scope are controlled by that child server, so standard mode treats every mcp_call as opaque mutation and requires explicit chat plus host exact-action approval. Trusted Full Bypass skips lnwjud application approval; the child server still enforces its own policy. |
| 67 | `workspace_context` | READ | default | operational | service_dispatch | Aggregate ranked workspace context with snippets, symbols, Git/test relevance, economy metadata, and continuation; automatic discovery can be explicitly expanded. |
| 68 | `workspace_context_continue` | READ | default | operational | service_dispatch | Continue a workspace_context result without discarding unreturned candidates. |
| 69 | `workspace_full_scan` | READ | default | operational | service_dispatch | Enumerate workspace files with full access by default; set includeIgnored false to use the persistent automatic index. |
| 70 | `workspace_full_scan_continue` | READ | default | operational | deterministic_operation | Continue a workspace_full_scan result page. |
| 71 | `workspace_snapshot` | READ | default | operational | service_dispatch | Return workspace identity and project snapshot metadata without source contents. |
| 72 | `search_all` | READ | default | operational | service_dispatch | Search text and filenames across one or all registered workspaces with automatic economy filters or an explicit includeIgnored override. |
| 73 | `read_many_files` | READ | default | operational | service_dispatch | Read many workspace files in parallel while preserving one result or error per requested path. |
| 74 | `read_file_page` | READ | default | operational | service_dispatch | Preferred reader for large files after search_text identifies the relevant area. Reads a deterministic line chunk with explicit continuation instead of silently truncating or loading the whole file. |
| 75 | `read_file_page_continue` | READ | default | operational | service_dispatch | Continue read_file_page from the next deterministic line chunk only when more surrounding context is needed; avoid re-reading earlier pages. |
| 76 | `workspace_index` | READ | default | operational | service_dispatch | Build or refresh the persistent workspace index using automatic context filters unless ignored paths are explicitly included. |
| 77 | `workspace_index_status` | READ | default | operational | service_dispatch | Return persistent index metadata and lossless watcher queue telemetry. |
| 78 | `workspace_index_watch` | READ | default | operational | service_dispatch | Watch all workspace paths and incrementally re-index only changed paths with configurable debounce/concurrency. |
| 79 | `workspace_index_stop` | READ | default | operational | service_dispatch | Stop a workspace watcher after draining all queued path updates. |
| 80 | `session_handoff` | READ | default | operational | service_dispatch | Create a concise same-chat recovery message from the real phase tracker, current git status/diff, and durable background task IDs. Use only when the user requests a handoff or an unavoidable client/platform interruption requires recovery; never trigger it merely because elapsed time passed. If a tool schema looks stale, Refresh connector first; open a new chat only if refresh does not fix it. |
| 81 | `verify_incremental` | EXECUTE | default | operational | service_dispatch | Run the detected project typecheck only when the current git status/diff fingerprint changed. Starting a new verification process requires explicit user confirmation in standard mode; trusted Full Bypass skips that lnwjud gate. Returns cache=hit when unchanged and cache=miss after a new verification. Prefer this during iterative edits; use project_test/project_lint/project_build only when that specific verification is needed. For full suites or packaging expected to exceed ~5 minutes, launch a durable shell background task and record its task_id in the tracker. |
| 82 | `run_goal` | WRITE | default | operational | service_dispatch | Immediate-return durable goal create/resume and lease acquisition. The client should invoke run_goal before the first mutation of any multi-step change that includes verification, build, package, push, release preparation, or is likely to outlive the current turn; if such work is already in progress without an active durable goal, enroll it before the next mutation. Unfinished goals default to scheduledContinuation=auto: the client must automatically load/follow the bundled lnwjud-scheduled-continuation skill, keep exactly one native one-time cloud successor after a real checkpoint, continue useful work without waiting for the user to type continue/ทำต่อ, and stop scheduling only when the goal is terminal or scheduling is explicitly disabled. Native ChatGPT task creation remains host-owned; this tool never claims that a task was created. |
| 83 | `get_goal` | READ | default | operational | service_dispatch | Read the latest durable goal snapshot without changing state or returning a lease token. |
| 84 | `checkpoint_goal` | WRITE | default | operational | service_dispatch | Atomically checkpoint durable goal progress using the current lease and expected revision. Use trackedTasks for goal-relative blocking_job/supporting_service roles and explicit provider routing; activeTaskIds remains a legacy compatibility form. Supporting services do not block continuation liveness and are cancelled only when cancelWithGoal=true. For an active goal using the default automatic continuation contract, a successful real checkpoint is the handoff point where the client must ensure exactly one native one-time cloud successor through lnwjud-scheduled-continuation before yielding; never wait for the user to type continue/ทำต่อ. |
| 85 | `finish_goal` | WRITE | default | operational | service_dispatch | Finish the local durable goal using lease/revision compare-and-swap. It must be called before any completion report, even when scheduling was disabled or the user requested no more successors. If it returns status=active with completionState=pending_native_cleanup, follow the exact scheduledTaskCancellation instruction through the native ChatGPT Scheduled Task host, record the matching native deletion or run receipt, then call finish_goal again. Report completion only after completionState=completed and get_goal is terminal; never treat a model assertion or an unverified host task as completion proof. |
| 86 | `cancel_goal` | WRITE | default | operational | service_dispatch | Cancel a durable goal independently of any scheduled successor. It records the goal as cancelled, aborts in-flight fenced MCP requests for that goal, and attempts to stop only tracked tasks whose cancelWithGoal policy is true; shared supporting services remain running by default and are reported as taskCancellations status=skipped. An explicitly bound provider that is unavailable or cannot verify termination is reported as failed, so allTasksStopped remains false until the unresolved task is inspected. Inspect requestCancellation, taskCancellations, and allRequestsStopped/allTasksStopped for unresolved work. If scheduledTaskCancellation requests delete_native_task, use cancel_scheduled_continuation separately and complete the exact native ChatGPT host deletion receipt. |
| 87 | `list_goals` | READ | default | operational | service_dispatch | List a bounded set of durable goals owned by the current stable MCP client, optionally filtered by workspace/status. |
| 88 | `prepare_scheduled_continuation` | WRITE | default | operational | service_dispatch | Checkpoint and reserve exactly one current-chat cloud successor. If successorDelayMinutes is omitted, the adaptive due time is calculated from the current durable-goal lease and clamped to the supported host window between 2 and 25 minutes instead of using a fixed cadence. Explicit delays between 2 and 25 minutes remain available for bounded caller intent. A prepared reservation is NOT a confirmed successor and is not handoff-ready, but a live worker with a valid goal lease may keep doing fenced work while native-task creation is retried. Record native create failure or uncertainty truthfully; before turn yield or handoff, require a created receipt with the real native task ID plus runsOn=cloud unless the goal is terminal or scheduling was explicitly disabled. Use trackedTasks for goal-relative blocking_job/supporting_service roles and explicit provider routing; activeTaskIds remains a legacy compatibility form. Supporting services do not block scheduled-claim liveness and are cancelled only when cancelWithGoal=true. This workflow never creates or deletes the native task itself. |
| 89 | `record_scheduled_continuation_receipt` | WRITE | default | operational | service_dispatch | Record host-owned cloud one-time task create, same-task reschedule, consumed-run reconciliation, or cancellation receipts. Created/rescheduled receipts must include the host-reported absolute dueAt; equivalent timezone offsets are compared as the same instant, while real schedule drift is rejected. A consumed receipt requires exact native host run evidence and means only that the one-time task is no longer pending; it does not mean the goal work completed. Cancelled is accepted only with a matching native ChatGPT host deletion receipt; a model assertion is not cancellation proof. The stored native task ID is immutable across reschedules. |
| 90 | `claim_scheduled_continuation` | WRITE | default | operational | service_dispatch | Scheduled-wake entrypoint. Claim before workspace mutation; a confirmed cloud wake up to 120 seconds early is accepted as bounded host jitter. A one-time task that has already fired is treated as consumed transport identity and is never relied on as future coverage. On acquired, claim atomically reserves a fresh lease-aligned prepared successor and returns its scheduleRequest. On a live/uncertain worker collision, an expired lease with a running blocking job, or a wake outside the accepted early window, the firing task is retired and successor_required returns one fresh adaptive successor instead of trying to update the consumed native task. Interrupted claims reuse the same deterministic successor. Reconcile missing/uncertain native receipts before any blind create. Truthfully failed creates refresh to the current lease-aligned adaptive due time. reschedule_required is legacy compatibility only. terminal_noop returns naturally. Never count prepared as confirmed and never mutate the workspace without the acquired goal lease. |
| 91 | `get_scheduled_continuation` | READ | default | operational | service_dispatch | Read one scheduled-continuation snapshot by continuation ID or the latest record for a goal. Healthy work keeps its calculated successor deadline; a real handoff-risk signal may adaptively expedite only a still-pending future native task. |
| 92 | `expedite_scheduled_continuation` | WRITE | default | operational | service_dispatch | For an enumerated handoff-risk signal, adaptively move the exact still-pending cloud one-time native task closer using the current lease, host-jitter safety margin, and deterministic staggering. This is the only same-task update path; a task that has already fired must be retired and replaced by the fresh successor returned from claim. |
| 93 | `cancel_scheduled_continuation` | WRITE | default | operational | service_dispatch | Cancel one still-pending scheduled successor independently of its goal. Identify it by continuationId or the latest record for a goal, then use the returned cancellation instruction to delete the exact pending native ChatGPT Scheduled Task and record its host receipt. Never treat pausing/disabling an already-fired current wake as deletion or completion proof. This does not cancel the durable goal or stop its running tasks. |
| 94 | `symbol_search` | READ | default | operational | service_dispatch | Search indexed symbols across the workspace. |
| 95 | `find_definition` | READ | default | operational | service_dispatch | Find deterministic symbol definitions. |
| 96 | `find_references` | READ | default | operational | service_dispatch | Find textual and indexed references to a symbol. |
| 97 | `find_implementations` | READ | default | operational | service_dispatch | Find interface and class implementations. |
| 98 | `call_hierarchy` | READ | default | operational | service_dispatch | Return a deterministic call hierarchy approximation. |
| 99 | `import_graph` | READ | default | operational | service_dispatch | Return indexed imports and exports for a module. |
| 100 | `dependency_graph` | READ | default | operational | service_dispatch | Return package and module dependency metadata. |
| 101 | `module_graph` | READ | default | operational | service_dispatch | Return the workspace module graph. |
| 102 | `type_search` | READ | default | operational | service_dispatch | Search indexed TypeScript, JavaScript, and Python types. |
| 103 | `trace_symbol` | READ | default | operational | service_dispatch | Combine definition, references, imports, tests, and recent context. |
| 104 | `context_ranking` | READ | default | operational | deterministic_operation | Explain ranking signals without removing lower-ranked context. |
| 105 | `debug_context` | READ | default | operational | service_dispatch | Gather deterministic debugging context and continuation metadata. |
| 106 | `review_context` | READ | default | operational | service_dispatch | Gather code-review context. |
| 107 | `change_context` | READ | default | operational | service_dispatch | Gather changed files, symbols, dependencies, and tests. |
| 108 | `symbol_context` | READ | default | operational | service_dispatch | Gather context around a symbol. |
| 109 | `test_context` | READ | default | operational | service_dispatch | Gather relevant test context. |
| 110 | `dependency_context` | READ | default | operational | service_dispatch | Gather dependency-related context. |
| 111 | `git_context` | READ | default | operational | service_dispatch | Gather Git status, diff, and history context. |
| 112 | `frontend_context` | READ | default | operational | service_dispatch | Gather frontend project context. |
| 113 | `backend_context` | READ | default | operational | service_dispatch | Gather backend project context. |
| 114 | `route_intent` | READ | default | operational | deterministic_operation | Classify a prompt with a deterministic, overridable route. |
| 115 | `recipe_list` | READ | default | operational | deterministic_operation | List built-in and user recipe names. |
| 116 | `recipe_describe` | READ | default | operational | deterministic_operation | Describe a recipe plan and permissions. |
| 117 | `recipe_run` | EXECUTE | default | operational | deterministic_operation | Preview or run a deterministic recipe plan. |
| 118 | `dry_run` | READ | default | operational | deterministic_operation | Return a no-side-effect execution preview. |
| 119 | `review_changes` | READ | default | operational | service_dispatch | Review current Git changes and affected context. |
| 120 | `changed_symbols` | READ | default | operational | service_dispatch | Find symbols in changed files. |
| 121 | `affected_modules` | READ | default | operational | service_dispatch | Find modules affected by current changes. |
| 122 | `git_history_context` | READ | default | operational | service_dispatch | Return relevant recent Git history. |
| 123 | `git_blame_context` | READ | default | operational | service_dispatch | Return line ownership context for a file. |
| 124 | `discover_tests` | READ | default | operational | service_dispatch | Discover project tests without imposing an execution limit. |
| 125 | `run_affected_tests` | EXECUTE | default | operational | service_dispatch | Plan or run tests affected by changed files. |
| 126 | `test_failures` | READ | default | operational | service_dispatch | Summarize recorded test failures. |
| 127 | `coverage_context` | READ | default | operational | service_dispatch | Return coverage context when project tooling provides it. |
| 128 | `test_history` | READ | default | operational | service_dispatch | Return recent test execution history. |
| 129 | `cache_stats` | READ | default | operational | deterministic_operation | Return shared cache hit/miss telemetry. |
| 130 | `cache_clear` | WRITE | default | operational | deterministic_operation | Clear safe local runtime caches. |
| 131 | `cache_invalidate` | WRITE | default | operational | deterministic_operation | Invalidate cache entries for a path or workspace. |
| 132 | `hook_list` | READ | default | operational | deterministic_operation | List registered lifecycle hooks. |
| 133 | `hook_register` | WRITE | default | operational | deterministic_operation | Register a deterministic lifecycle hook descriptor. |
| 134 | `hook_remove` | WRITE | default | operational | deterministic_operation | Remove a lifecycle hook descriptor. |
| 135 | `skill_match` | READ | default | operational | service_dispatch | Match relevant local skills without loading all skill text. |
| 136 | `skill_load` | READ | default | operational | service_dispatch | Load a selected local skill by identifier. |
| 137 | `plugin_install` | WRITE | default | operational | truthful_unavailable | Register a validated plugin descriptor in the locked shared runtime registry. This manages declared plugin state; it does not execute untrusted plugin code. |
| 138 | `plugin_list` | READ | default | operational | deterministic_operation | List plugin descriptors from the locked shared runtime registry. |
| 139 | `plugin_enable` | WRITE | default | operational | truthful_unavailable | Enable an installed plugin descriptor in persistent shared runtime state. |
| 140 | `plugin_disable` | WRITE | default | operational | truthful_unavailable | Disable an installed plugin descriptor in persistent shared runtime state. |
| 141 | `plugin_remove` | DANGEROUS | default | operational | truthful_unavailable | Remove an installed plugin descriptor from persistent shared runtime state. |
| 142 | `session_context` | READ | default | operational | deterministic_operation | Return persisted development-session context. |
| 143 | `session_checkpoint` | WRITE | default | operational | deterministic_operation | Persist a development-session checkpoint. |
| 144 | `session_resume` | READ | default | operational | deterministic_operation | Resume a persisted session context. |
| 145 | `session_history` | READ | default | operational | deterministic_operation | Return session checkpoints and decisions. |
| 146 | `response_mode` | READ | default | operational | deterministic_operation | Select compact, normal, verbose, or stream formatting. |
| 147 | `inspect_web_app` | READ | default | operational | service_dispatch | Combine DOM, console, network, URL, and screenshot metadata. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 148 | `debug_ui` | READ | default | operational | service_dispatch | Gather deterministic UI debugging context. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 149 | `capture_ui_state` | READ | default | operational | service_dispatch | Capture a structured UI state. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 150 | `form_context` | READ | default | operational | service_dispatch | Inspect form controls and values metadata. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 151 | `network_context` | READ | default | dependency_gated | truthful_unavailable | Summarize browser network context when a retained CDP network event stream is available. |
| 152 | `console_context` | READ | default | dependency_gated | truthful_unavailable | Summarize browser console context when a retained CDP Runtime/Log event stream is available. |
| 153 | `browser_debug_context` | READ | default | operational | service_dispatch | Combine browser diagnostics for one request. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 154 | `windows_environment` | READ | default | operational | service_dispatch | Inspect Windows environment metadata. |
| 155 | `service_context` | READ | default | operational | deterministic_operation | Inspect Windows service metadata. |
| 156 | `process_context` | READ | default | operational | service_dispatch | Inspect process-tree context. |
| 157 | `port_context` | READ | default | operational | deterministic_operation | Inspect local listening-port context. |
| 158 | `registry_context` | READ | default | operational | deterministic_operation | Inspect registry context through the Windows capability boundary. |
| 159 | `event_log_context` | READ | default | operational | deterministic_operation | Inspect Windows event-log context. |
| 160 | `installed_runtime_context` | READ | default | operational | deterministic_operation | Inspect installed runtimes and package managers. |
| 161 | `path_context` | READ | default | operational | deterministic_operation | Resolve executable and PATH context. |
| 162 | `startup_context` | READ | default | operational | deterministic_operation | Inspect startup configuration context. |
| 163 | `mcp_discover` | READ | default | operational | service_dispatch | Discover external MCP servers without flattening native tools. |
| 164 | `mcp_health` | READ | default | operational | service_dispatch | Return external MCP connection health. |
| 165 | `mcp_resources` | READ | default | dependency_gated | service_dispatch | List resources exposed by connected MCP servers when the child server supports resources/list. |
| 166 | `task_create` | EXECUTE | default | operational | service_dispatch | Create a durable background task through the local shell task runtime. Pass executable (or command), arguments, cwd, timeout_seconds, and workspaceId as needed. |
| 167 | `task_status` | READ | default | operational | service_dispatch | Read durable managed task state by taskId. |
| 168 | `task_cancel` | EXECUTE | default | operational | service_dispatch | Cancel a durable managed task by taskId using the same verified process-tree termination path as shell tasks. |
| 169 | `task_result` | READ | default | operational | service_dispatch | Read the current durable managed task result and captured output by taskId. |
| 170 | `task_list` | READ | default | operational | service_dispatch | List durable managed tasks owned by the current client/session/workspace. |
| 171 | `delegate` | EXECUTE | default | dependency_gated | service_dispatch | Delegate one bounded read-only task through the owned agent-swarm provider when configured. |
| 172 | `delegate_status` | READ | default | dependency_gated | service_dispatch | Read delegated agent state from the owned agent-swarm provider. |
| 173 | `delegate_cancel` | EXECUTE | default | dependency_gated | service_dispatch | Cancel an owned delegated agent task. |
| 174 | `delegate_result` | READ | default | dependency_gated | service_dispatch | Read an owned delegated agent result. |
| 175 | `parallel_delegate` | EXECUTE | default | dependency_gated | service_dispatch | Run up to four isolated read-only agent tasks through the owned swarm provider with explicit dependency/collision metadata. |
| 176 | `permission_check` | READ | default | operational | deterministic_operation | Evaluate an action class without limiting allowed context reads. |
| 177 | `permission_profile` | READ | default | operational | deterministic_operation | Return the active Permission v2 profile. |
| 178 | `live_logs_query` | READ | default | operational | truthful_unavailable | Query bounded structured MCP activity events with tool, workspace, phase, result, call/trace correlation filters. |
| 179 | `live_logs_status` | READ | default | operational | truthful_unavailable | Return the built-in MCP activity-log pipeline health and bounded source status. |
| 180 | `telemetry_dashboard` | READ | default | operational | deterministic_operation | Return measured MCP activity, latency, error, cache, and context-economy telemetry from the local runtime. |
| 181 | `context_economy_stats` | READ | default | operational | deterministic_operation | Return context discovery, deduplication, ledger, and token-efficiency telemetry. |
| 182 | `execution_plan` | READ | default | operational | deterministic_operation | Return the cheapest deterministic execution plan and reason. |
| 183 | `repo_map` | READ | default | operational | service_dispatch | Return a traversable repository structural map. |
| 184 | `context_expand` | READ | default | operational | service_dispatch | Return optional import, caller, type, test, and change references. |
| 185 | `recovery_status` | READ | default | operational | deterministic_operation | Return reconnect, retry, continuation, cache, and worker recovery state. |
| 186 | `tool_schema_list` | READ | default | operational | deterministic_operation | List versioned tool schema metadata. |
| 187 | `tool_schema_register` | WRITE | default | operational | deterministic_operation | Register a validated backward-compatible versioned tool schema descriptor in the local runtime registry. |
| 188 | `capabilities` | READ | default | operational | deterministic_operation | Discover capability categories without requiring every full schema. |
| 189 | `tool_search` | READ | default | operational | deterministic_operation | Search tools, tags, phases, and descriptions deterministically. |
| 190 | `tool_dynamic_filter` | READ | default | operational | deterministic_operation | Return a bounded ranked tool set using deterministic scoring with optional local rerank fallback. |
| 191 | `tool_describe` | READ | default | operational | deterministic_operation | Describe one tool contract on demand. |
| 192 | `tool_categories` | READ | default | operational | deterministic_operation | List tool categories and counts. |
| 193 | `tool_function_find` | READ | default | operational | deterministic_operation | Find the best local tool/function candidates for a prompt. |
| 194 | `tool_aliases` | READ | default | operational | deterministic_operation | List stable shorthand aliases and their primitive tool targets. |
| 195 | `mcp_hub` | READ | default | dependency_gated | service_dispatch | Describe the additive MCP hub boundary without flattening child tools or retaining credentials. |
| 196 | `dev_context` | READ | default | operational | service_dispatch | Run the unified deterministic development-context facade. |
| 197 | `recipe_catalog` | READ | default | operational | deterministic_operation | Return inspectable developer automation recipes. |
| 198 | `capture_screenshot` | READ | default | operational | service_dispatch | Capture screenshot metadata for visual validation. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 199 | `compare_screenshot` | READ | default | operational | deterministic_operation | Compare screenshot metadata or supplied artifacts. |
| 200 | `dom_snapshot` | READ | default | operational | service_dispatch | Return a structured DOM snapshot. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 201 | `layout_metadata` | READ | default | operational | service_dispatch | Return layout metadata for visual validation. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 202 | `visual_context` | READ | default | operational | service_dispatch | Combine screenshot, DOM, layout, console, and network references. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 203 | `inspect_workbook` | READ | default | operational | service_dispatch | Inspect workbook sheets, used ranges, and a bounded sample through Excel COM. |
| 204 | `compare_workbook_layout` | READ | default | dependency_gated | service_dispatch | Compare two workbook sheet/layout samples through the local Excel/Office provider. |
| 205 | `render_excel_preview` | READ | default | dependency_gated | service_dispatch | Render a bounded structured Excel preview from sheet names and sampled cell values through the local Excel/Office provider. |
| 206 | `inspect_pdf` | READ | default | dependency_gated | truthful_unavailable | Inspect PDF page structure and text through the local PDF provider. |
| 207 | `compare_pdf_pages` | READ | default | dependency_gated | truthful_unavailable | Compare two PDFs by bounded page/text metadata through the local PDF provider. |
| 208 | `project_profile_get` | READ | default | operational | service_dispatch | Read the validated workspace project-intelligence profile. |
| 209 | `project_profile_set` | WRITE | default | operational | deterministic_operation | Persist validated workspace project-intelligence conventions through the guarded file boundary. |
| 210 | `handoff_context` | READ | default | operational | service_dispatch | Build a structured cross-agent handoff bundle from real workspace, Git, and context services. |
| 211 | `benchmark_run` | EXECUTE | default | dependency_gated | service_dispatch | Preview or start the detected managed benchmark project command and retain bounded run evidence. |
| 212 | `regression_report` | READ | default | operational | deterministic_operation | Return retained local benchmark run evidence and regression comparisons for the current runtime session. |
| 213 | `sandbox_exec` | EXECUTE | default | dependency_gated | truthful_unavailable | Run an artifact-based Windows Sandbox job with networking disabled and read-only mapped input. |
| 214 | `event_watch` | EXECUTE | default | dependency_gated | deterministic_operation | Watch an allowlisted user-mode ETW or Windows Event Log diagnostic stream. |
| 215 | `crash_trace` | READ | default | dependency_gated | deterministic_operation | Return bounded crash and service-diagnostic context from allowlisted user-mode sources. |
| 216 | `lsp_diagnostics` | READ | default | dependency_gated | truthful_unavailable | Read diagnostics from an owned language-server child process. |
| 217 | `lsp_rename` | WRITE | default | dependency_gated | truthful_unavailable | Create a cross-file LSP rename edit plan before any workspace write. |
| 218 | `debug_attach` | EXECUTE | default | dependency_gated | truthful_unavailable | Validate and register an owned loopback DAP endpoint for a workspace debug session; connection details remain session-scoped. |
| 219 | `debug_step` | EXECUTE | default | dependency_gated | truthful_unavailable | Perform a bounded DAP request against a registered owned loopback debug session. |
| 220 | `git_worktree_spawn` | WRITE | default | dependency_gated | deterministic_operation | Create a confined, ledger-owned Git worktree for isolated agent work with collision metadata. |
| 221 | `git_worktree_remove` | DANGEROUS | default | dependency_gated | deterministic_operation | Remove a ledger-owned Git worktree after dry-run and standard-mode confirmation; trusted Full Bypass skips lnwjud approval. |
| 222 | `db_inspect` | READ | default | dependency_gated | truthful_unavailable | Inspect a local database schema through a configured, read-only connection. |
| 223 | `db_query` | READ | default | dependency_gated | truthful_unavailable | Run a bounded read-only local SQLite SELECT, PRAGMA, or WITH...SELECT query. |
| 224 | `office_ppt` | WRITE | default | dependency_gated | service_dispatch | Read PowerPoint content or save a copy through the existing Office policy boundary. |
| 225 | `office_outlook` | READ | default | dependency_gated | service_dispatch | Read Outlook folder and message headers through the existing Office policy boundary. |
| 226 | `pdf_extract_tables` | READ | default | dependency_gated | truthful_unavailable | Extract bounded PDF text and tables through a local document provider. |
| 227 | `docx_merge` | WRITE | default | dependency_gated | service_dispatch | Create a deterministic DOCX merge plan and write only after approval. |
| 228 | `self_heal_plan` | READ | default | operational | service_dispatch | Propose safe, deterministic, reversible recovery steps without applying mutations. |
| 229 | `self_heal_apply` | DANGEROUS | default | dependency_gated | service_dispatch | Apply a current reversible recovery plan without automatic destructive retries; standard mode requires confirmation and trusted Full Bypass skips lnwjud approval. |
| 230 | `skills_import` | WRITE | default | operational | service_dispatch | Import a validated local SKILL.md into the selected workspace skill catalog through guarded file read/write operations. |
| 231 | `tool_batch` | EXECUTE | default | operational | service_dispatch | Execute multiple MCP tools with parallel, dependency-aware, timeout, cancellation, and partial-result handling. |
<!-- END GENERATED README TOOL REGISTRY -->

## Detailed capability guide

### Workspace and project inspection

| Tool | Permission | What it does |
| --- | --- | --- |
| workspace_info | READ | Returns display name, canonical root, project profile, and Git summary |
| workspace_tree | READ | Returns a bounded directory tree; hidden and heavy folders are included, with depth/entry bounds and truncation metadata |
| project_snapshot | READ | Returns profile, Git counts, top-level tree, managed processes, and recent error summaries without source contents |

### Explicit workspace registration

lnwjud never scans A:–Z: or registers drive roots during startup. Add a project
folder explicitly through MCP or the Desktop Projects UI. `workspace_register`
accepts an absolute project path directly; `parentWorkspaceId` remains optional
only for compatibility with an explicitly registered legacy machine root. A
mapped/network drive is therefore touched only when the user deliberately adds a
project on it. Unrestricted visibility does not widen mutation authority beyond
the host-selected Active Project while Full Bypass is OFF.

| Tool | Permission | Input | What it does |
| --- | --- | --- | --- |
| workspace_list | READ | Empty object | Lists registered project workspaces and any explicitly retained legacy machine roots. Read-only discovery; Safe/Balanced/Full allow. |
| workspace_register | WRITE | absolute path, optional displayName/parentWorkspaceId | Registers an existing project directory directly (idempotent); the parent is legacy-compatible and never auto-created |

Registration still validates canonical paths and, when supplied, the parent ID and containment.
**Secret and hidden files may be readable in the default unrestricted mode**
(including `.env`, keys, and credentials) when their absolute path is explicitly
requested and read policy permits it. Image and other binary files are returned as base64 with no
application size cap. Mutation paths remain bound to the Active Project even
when those read/discovery roots are broader.

Local capability tools (`shell`, `vision`, `accessibility`, `input_event`,
`window`, `dom_cdp`, `health`) are available on both desktop HTTP MCP and
stdio/tunnel. Command-bearing mutation still requires the host Active Project,
shared command policy, confirmation, and trusted host approval.

If your build does not advertise `workspace_register`, register the workspace
from the desktop dashboard and use its workspace ID.

### Files and search

| Tool | Permission | What it does |
| --- | --- | --- |
| read_file | READ | Reads a workspace file as UTF-8 or an image/binary payload. Absolute paths do not require workspaceId. |
| read_files | READ | Reads up to 20 workspace files. Absolute paths do not require workspaceId. |
| search_files | READ | Searches workspace filenames with bounded results; automatic mode skips vendor/build/binary/generated paths |
| search_text | READ | Searches text through direct ripgrep arguments; automatic mode avoids binary/generated context |
| write_file | WRITE | Creates UTF-8 text by default; reviewed replacement requires explicit overwrite, Active Project match, confirmation, and checkpoint |
| apply_patch | WRITE | Applies reviewed bounded whole-file replacements; existing targets are checkpointed before replacement |
| edit_file | WRITE | Replaces exact text only when the expected occurrence count matches; checkpoints the original and refuses conflicts |
| move_file | WRITE | Moves a file or directory inside the Active Project; refuses an existing destination and requires confirmation |
| copy_file | WRITE | Copies a file or directory within one workspace and refuses an existing destination |
| delete_file | DANGEROUS | Moves one file or empty directory into Recovery Trash; this exact tool is the only mutation eligible for scoped auto-approval |
| list_recovery_items | READ | Lists deleted/replacement recovery items and the trusted local Recovery Trash root |
| restore_deleted_file | WRITE | Restores one recorded Recovery Trash item within its original workspace after confirmation |
| list_checkpoints | READ | Lists encrypted pre-mutation checkpoints without returning saved file content |
| restore_checkpoint | WRITE | Restores a reviewed checkpoint after creating a rollback checkpoint for the current version |

In the default unrestricted mode, `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`,
`id_ed25519*`, `.ssh/**`, `.aws/**`, and `credentials.json` may be readable when
their absolute path is explicitly requested and the active read policy permits it. This read
visibility never grants mutation authority outside the Active Project.

### Git

| Tool | Permission | What it does |
| --- | --- | --- |
| git | EXECUTE | Runs policy-checked Git argv; mutating forms require Active Project scope, confirmation, and host exact-action approval, while prohibited destructive rewrites fail closed |
| git_status | READ | Parsed read-only working-tree status |
| git_diff | READ | Bounded read-only diff with truncation metadata |
| git_log | READ | Bounded structured commit history |

Use `git` for supported repository operations and the structured read-only tools
for inspection. Hard reset/restore-overwrite, clean, force-delete/force-push, and
equivalent destructive rewrite/discard variants are denied before dispatch by
the shared Git mutation policy. Any allowed mutating Git invocation remains an
opaque exact action requiring explicit chat confirmation and trusted host
approval; Git mutation is never covered by the `delete_file` auto-approval
setting.

### Processes and project commands

| Tool | Permission | What it does |
| --- | --- | --- |
| process_start | EXECUTE | Starts one policy-checked executable/argv inside the Active Project after explicit chat and host approval |
| process_status | READ | Reads state for an owned process handle |
| process_logs | READ | Reads bounded stdout/stderr records with sequence numbers |
| process_stop | EXECUTE | Stops an owned managed process tree after confirmation |
| project_dev | EXECUTE | Runs the detected project development command after exact preview/approval and immediate re-resolution |
| project_test | EXECUTE | Runs the detected project test command after exact preview/approval and immediate re-resolution |
| project_lint | EXECUTE | Runs the detected project lint command after exact preview/approval and immediate re-resolution |
| project_typecheck | EXECUTE | Runs the detected project type-check command after exact preview/approval and immediate re-resolution |
| project_build | EXECUTE | Runs the detected project build command after exact preview/approval and immediate re-resolution |

`process_start` uses an executable plus an args array with `shell: false`.
Project commands come from the detected ProjectProfile; the gateway previews the
exact executable/argv and re-resolves immediately before spawn. Project-owned
script bodies remain opaque, are not an OS sandbox, and are not automatically
recoverable through Recovery Trash.

### Context Economy Engine

Automatic discovery is optimized for useful context rather than raw tree size.
The default policy skips `node_modules`, `.git`, `dist`, `build`, `coverage`,
`.next`, `.turbo`, `.cache`, `vendor`, `target`, `bin`, `obj`, virtualenvs,
binary files, bundles, and source maps. Lockfiles and large JSON/log/CSV files
start as metadata summaries; source and tests start with relevant symbol/line
ranges; changed Git files are ranked first.

This policy is not a deny list. Explicit reads remain full-access within the
normal workspace boundary, for example:

```text
read_file({ "path": "node_modules/pkg/index.js" })
read_many_files({ "files": [{ "path": ".env" }, { "path": ".git/config" }] })
search_files({ "includeIgnored": true, "path": "node_modules/pkg" })
workspace_context({ "includeIgnored": true, "query": "login" })
```

The Context Ledger keeps bounded in-memory fingerprints and small previous
contents. Repeated delivery can be represented as `unchanged`, a line `diff`,
or a duplicate `referencePath`; unchanged bytes are not sent again. The
`context_economy_stats` tool and `telemetry_dashboard` expose raw discovered
bytes, delivered bytes, duplicate/previously-seen bytes avoided, skipped paths,
ledger hits, and estimated savings. No raw file content or credential is
persisted by this telemetry.

### Local Codex delegation

| Tool | Permission | What it does |
| --- | --- | --- |
| codex_status | READ | Reports local Codex installation/version/capabilities without credential inspection |
| codex_run | EXECUTE | Delegates an instruction to local Codex in workspace-write sandbox mode after exact approval and returns codexTaskId |
| codex_task_status | READ | Reads state for an owned Codex task |
| codex_task_logs | READ | Reads bounded logs for an owned Codex task |
| codex_stop | EXECUTE | Stops only a Codex task launched by lnwjud |

Typical flow: codex_run → inspect task status/logs → inspect git_diff → run checks.
Codex still operates as an opaque child agent; the workspace-write sandbox
narrows its mode but does not make its changes automatically recoverable.

### Local desktop capabilities

| Tool | Permission | Actions |
| --- | --- | --- |
| shell | EXECUTE | Non-blocking MCP command execution; `run` is forced to background, returns `task_id` immediately, and follow-up status/logs/result calls inspect progress without holding the connection open |
| dom_cdp | READ | Read-only DOM inspection is READ; navigation/type/evaluate and other mutating actions are escalated to DANGEROUS per invocation |
| accessibility | READ | Inspection/read actions are READ; clicks, value changes, selections, menus, and window mutations are escalated per invocation |
| input_event | EXECUTE | Low-level keyboard/pointer execution; dry-run is READ and real input is treated as opaque/DANGEROUS per invocation |
| vision | READ | Local display/region/window PNG capture and optional OCR; never clicks or types |
| window | EXECUTE | List/inspection is READ, ordinary window-state changes are WRITE, and close/unknown actions are escalated to DANGEROUS |
| health | READ | Per-backend diagnostics with no input/browser/window side effects |
| system_info | READ | OS/CPU/memory/disks/battery/uptime and top processes (read-only) |
| notification | EXECUTE | Windows toast (BurntToast) or balloon notification |
| file_dialog | EXECUTE | Native open/save dialogs returning chosen paths; does not read or write files itself |
| clipboard | EXECUTE | Clipboard reads are READ; set_text replaces clipboard state and is escalated to DANGEROUS per invocation |
| web_fetch | READ | GET/HEAD are READ; POST is opaque, PUT/PATCH replace remote state, and DELETE is DANGEROUS per invocation |
| audio | DANGEROUS | Microphone WAV recording (up to 600s), local audio playback, stop; privacy/capture surface remains high-risk and replacement outputs are recovery-backed |
| screen_record | DANGEROUS | Screen capture remains high-risk; status/dry-run are downgraded to READ at invocation and replacement outputs are recovery-backed |
| office | WRITE | Read/list actions are READ; mutating replacement actions are WRITE with confirmation and FileService recovery |
| scheduler | EXECUTE | List is READ; create/run are opaque and delete is DANGEROUS per invocation |

Use dom_cdp for web pages, accessibility for semantic native controls, and
input_event only as a low-level fallback. Command-bearing actions remain argv-
and policy-bounded; a permission profile never grants free-form shell strings.

### Skills and local MCP bridge

These meta-tools discover local agent skills and other MCP servers on the
machine (Cursor `mcp.json`, Claude Desktop config, plus lnwjud settings). They
do not flatten every child tool into the lnwjud catalog. Default mode enables
all discovered servers except lnwjud itself (recursion guard).

| Tool | Permission | What it does |
| --- | --- | --- |
| skills_list | READ | Lists bundled skills plus all discovered Cursor/Claude/Agents/Codex/Codex-plugin/GitHub workspace/configured roots |
| skills_read | READ | Reads a skill `SKILL.md` or a relative file inside that skill folder |
| mcp_list | READ | Lists discovered local MCP servers and enabled/connected state |
| mcp_describe | READ | Connects if needed and returns child tool names/schemas |
| mcp_call | DANGEROUS | Forwards one opaque tool call to a child MCP server after explicit chat and host exact-action approval |

**Security note:** These tools are available on every transport, including the
Secure MCP Tunnel, but the permission profile is not a bypass. Child `mcp_call`
side effects are treated as opaque mutation and still require independent host
exact-action approval. A standalone/headless runtime with no trusted approval
provider denies the mutation instead of granting it from the `full` profile.
Disable individual servers through the lnwjud `extensions` settings JSON
(`disabledServers`) when needed.

Settings key `extensions` (SQLite) example:

```json
{
  "mode": "enable_all",
  "disabledServers": [],
  "disabledSkillRoots": [],
  "extraSkillRoots": [],
  "extraMcpServers": {}
}
```

The exact schemas and defaults are maintained in
`packages/mcp-server/src/tools/schemas.ts`.

## Recommended workflows

### Read, change, verify

1. workspace_info: confirm the workspace ID.
2. project_snapshot and git_status: establish the starting state.
3. search_files/search_text/read_file: locate code.
4. apply_patch: make a coherent edit.
5. project_test/project_lint/project_typecheck/project_build.
6. process_status/process_logs for long-running work.
7. git_diff and git_status for the final review.

### Run a development server

Use project_dev for a detected project command. For a manually approved
executable, use process_start with separate arguments and an Active Project cwd.
Save the returned process ID and use process_status, process_logs, and
process_stop.

### Delegate to Codex

Run codex_status first. If available and explicitly approved, use codex_run,
inspect the returned task status/logs, inspect git_diff, and run checks. Codex is
an opaque child process; do not assume its filesystem changes are Recovery Trash
backed simply because the launch itself was approved.

### Automate Windows applications

Use health for diagnostics; dom_cdp for managed web pages; accessibility for
native controls; vision for screen/OCR fallback; input_event only when the
higher-level APIs cannot operate; and window for native window management.

## Unrestricted full-access mode

Unrestricted mode expands **explicit absolute-path read/discovery visibility**
for compatibility. It never scans or registers drive letters automatically and
does **not** lift the host-selected Active
Project mutation boundary, shared command/Git policy, independent host approval,
or hard blocks. Enable the visibility mode either way:

- Settings → Unrestricted mode (checkbox; restart the app to apply), or
- `$env:LNWJUD_UNRESTRICTED = '1'` before launching lnwjud (the tunnel script
  below sets this automatically for the stdio runtime).

When enabled:

- `workspace_register` can add an explicitly chosen absolute project path without
  first creating a drive root. Mapped/network drives are not probed on startup.
- Secret files (.env, *.key, id_rsa, .ssh/**, .aws/**, credentials.json) may be
  readable on registered roots when the active read policy permits them; binary
  files are returned as base64 by the file reader.
- Capability discovery uses registered projects and explicitly configured roots, but mutation-
  bearing cwd/targets are re-bound to the host Active Project before dispatch.
- Approved processes still run as the Windows user and may receive the normal
  process environment; this is not a sandbox guarantee.

In every mode, command-bearing mutation uses typed policy plus exact host
approval. The exact recoverable `delete_file` is the only scoped auto-approval
exception. Prohibited destructive Git rewrites and prohibited destructive
command forms fail closed; other allowed opaque mutations require explicit chat
confirmation and trusted host approval. Arbitrary commands/scripts are not
automatically recoverable through Recovery Trash.

## Real-time Live Logs

The desktop app includes a Live Logs screen (sidebar) with three tabs:

- Tunnel — tails `%APPDATA%\tunnel-client\lnwjud-tunnel.log` continuously
- MCP activity — every tool call received by MCP appears immediately
- Processes — state and recent output of managed processes

Follow/pause, text filter, clear, and export-to-file are available per tab,
and "Pop out viewer" opens a compact separate window. The viewer can also be
launched directly:

```powershell
& "$env:LOCALAPPDATA\Programs\lnwjud\lnwjud.exe" --log-viewer
```

The app is single-instance: launching with `--log-viewer` while the dashboard
is already open focuses/opens the viewer in the running instance.

Live Logs v2 preserves partial lines across tunnel-client chunks, correlates
MCP activity, and keeps the tunnel/process streams visible while the app is
running. It is covered by the desktop log-hub and tunnel lifecycle tests.

## Tunnel state sync between the script and the app

The tunnel can be started from the PowerShell script or from the app's Start
Tunnel button, and both reflect the same state:

- When the script starts the tunnel, the dashboard detects the external
  tunnel-client process (within ~4 seconds) and shows "Tunnel connected
  (from script)" with the Start button disabled.
- Stop Tunnel in the app also stops a script-started tunnel.
- If the tunnel exits, the status returns to stopped automatically.

## Run the tunnel with a resilient script

The repository ships `scripts/start-lnwjud-tunnel.ps1`. Copy it anywhere and
run it instead of a manual `tunnel-client run`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\start-lnwjud-tunnel.ps1"
```

The script sets `--mcp.connection-max-ttl 168h0m0s` (prevents the 10-minute
disconnect), writes `lnwjud-tunnel.log`, aligns `LNWJUD_DATA_PATH` with the
desktop app so ChatGPT activity shows in the Work Log and Live Logs, enables
unrestricted read/discovery mode, restarts the tunnel automatically when it
drops (including TTL shutdowns that exit 0), avoids double-starting, and opens
the log viewer window. Rapid failures are bounded with backoff; after five
failures in a 30-second window it stops retrying and asks for a manual Start
Tunnel. Parameters: `-NoViewer`, `-OpenDashboard`, `-ForceRestart`, `-Once`.

### Session resilience / แนวทางสำหรับผู้ปฏิบัติการ

Use **Capture Incident** in Control Center or Live Logs when a turn looks
wrong. It writes one bounded, redacted JSON report after you choose a file;
tokens, authorization values, passwords, and secret-like values are removed.
It is still operational evidence, so review the chosen export before sharing
it outside the support case.

The classification is evidence-based, not a remote root-cause guarantee:

- `local_tool_failed` — the latest structured MCP call completed locally with
  a failure. ตรวจสอบ tool result/Work Log first.
- `tunnel_disconnected` — the tunnel reported a lifecycle stop/TTL/stdio stop,
  or its configured health evidence is unhealthy. ตรวจสอบ doctor and the
  tunnel log.
- `remote_turn_stopped` — a user manually captured after a structured local
  success while the tunnel was live. This is an inference that the remote turn
  stopped; it does **not** prove the remote cause.
- `healthy_or_inconclusive` — the collected evidence cannot safely select one
  of the cases above. Collect the report before restarting layers.

Desktop Start Tunnel and `start-lnwjud-tunnel.ps1` share one profile lock. The
losing launcher reports the actual owner PID and does not start or stop another
owner's `tunnel-client`. A stale lock is reclaimed only when the recorded PID
and process start time no longer match; do not manually delete a lock merely to
force a second tunnel.

For a downloaded update, **Later** is the safe default. **Restart Now** queues
installation until active MCP calls finish and the runtime remains quiet briefly;
a short new call resets that quiet interval. Quitting the app cancels the pending
install rather than interrupting work.

Validate the already configured health endpoint without launching another
tunnel. With `listen_addr: 127.0.0.1:0`, use the runtime address written by the
current client rather than copying a fixed port:

```powershell
$profile = Join-Path $env:APPDATA 'tunnel-client'
$tc = if ($env:LNWJUD_TUNNEL_CLIENT_PATH) { $env:LNWJUD_TUNNEL_CLIENT_PATH } else { Join-Path $env:LOCALAPPDATA 'Programs\lnwjud\resources\tunnel-client\tunnel-client.exe' }
if (-not (Test-Path -LiteralPath $tc -PathType Leaf)) { throw "Missing tunnel-client executable: $tc" }
if (-not (Test-Path -LiteralPath (Join-Path $profile 'lnwjud.yaml') -PathType Leaf)) { throw "Missing configured profile: $(Join-Path $profile 'lnwjud.yaml')" }
Get-Content (Join-Path $profile 'lnwjud.tunnel.lock') -ErrorAction SilentlyContinue
& $tc doctor --profile lnwjud --profile-dir $profile --explain
if ($LASTEXITCODE -ne 0) { throw 'tunnel-client doctor failed' }
$match = Select-String -LiteralPath (Join-Path $profile 'lnwjud-tunnel.log') -Pattern 'health.*(?:listening|listen_addr).*?(127\.0\.0\.1|localhost):(\d{2,5})' | Select-Object -Last 1
if ($null -eq $match) { throw 'No runtime health address was reported by the configured tunnel' }
$address = [regex]::Match($match.Line, '(127\.0\.0\.1|localhost):(\d{2,5})').Value
Invoke-WebRequest -UseBasicParsing "http://$address/healthz"
```

This validates the live configured endpoint and lock/doctor state; it does not
start, replace, or terminate a tunnel. Repository acceptance coverage can be
run with `corepack pnpm@10.15.0 test:acceptance`.

## Security and operational model

### Transport

The local HTTP MCP endpoint binds to 127.0.0.1. Stdio is a child-process
transport. Secure MCP Tunnel is an outbound HTTPS bridge, not an inbound public
listener.

### Filesystem

Every client path passes the workspace path guard. It resolves relative paths,
rejects NUL bytes/traversal, handles non-existing write targets through their
nearest existing ancestor, rejects junction/symlink/reparse-point escapes, and
applies the secret policy after canonicalization. Mutation-bearing paths are
also checked against the host-selected Active Project rather than trusting a
request-supplied workspace identifier.

### Process execution

The default process API is equivalent to:

```text
spawn(executable, args, { shell: false })
```

Arguments are not concatenated into a shell command. Processes have owned
handles, bounded logs, timeout/cancel support, and Windows process-tree
termination. Normal execution is as the current user; administrator privilege
requests are denied by the capability backend. Approval authorizes the exact
previewed action, not arbitrary script contents, and does not create an OS
sandbox or automatic rollback guarantee.

### Audit and recovery

Audit records contain timestamp, actor/client, tool/action, workspace ID,
sanitized argument summary, permission decision, result code, and duration.
They do not persist full prompts, environment variables, bearer tokens, API
keys, passwords, or unlimited terminal history. Existing-file writes checkpoint
before overwrite where supported; native/binary replacement paths use Recovery
Trash backups where the provider can be made recoverable. Opaque external
mutation is explicitly not represented as recoverable when lnwjud cannot own a
pre-image.

### Explicitly unavailable tools

These are intentionally not in the core catalog:

```text
run_shell
git_reset
git_clean
kill_pid
read_arbitrary_path
```

`powershell` and `cmd` are not standalone tools. A permitted exact executable +
argv launch still traverses Active Project scope, the shared prohibited-command
policy, chat confirmation, and independent host approval. Free-form inline
interpreter command strings and prohibited destructive variants are denied.
Git itself is invoked with the `git` tool or a separately policy-checked process
launch; standalone `git_reset` / `git_clean` capabilities do not exist.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Secure Tunnel profile still contains `mcp.commands` or `lnwjud-mcp-stdio.cmd` | Open lnwjud Desktop → Settings → OpenAI Secure MCP Tunnel → Configure Tunnel. v4.10.0 rewrites the profile to the current Desktop loopback HTTP `/mcp` endpoint. |
| Direct local stdio launcher is missing | This affects local stdio hosts such as Codex CLI, not Secure Tunnel. Reinstall the current Windows package and confirm `lnwjud-mcp-stdio.cmd`, `lnwjud-mcp-stdio.cjs`, and `lnwjud-node.exe` are shipped beside lnwjud.exe or under resources. |
| profile_load says the YAML file is missing | Run init with profile lnwjud and verify %APPDATA%/tunnel-client/lnwjud.yaml |
| doctor rejects the key | Use a runtime key with Tunnels Read + Use; do not substitute an Admin or unrelated project key |
| Tunnel is not listed in ChatGPT | Associate it with the target ChatGPT workspace and verify Tunnels Read + Use |
| ChatGPT reports no tools | Check that lnwjud Desktop is running, the profile `server_urls` points to its loopback `/mcp` endpoint, doctor/tunnel health passes, then Refresh connector. |
| Tunnel doctor cannot reach local MCP | Keep lnwjud Desktop running and use Configure Tunnel again so the profile receives the current loopback `/mcp` endpoint. |
| WORKSPACE_NOT_FOUND | Use the exact registered workspace ID, not a path or display name |
| PATH_OUTSIDE_WORKSPACE | Register/select the correct root and use a workspace-relative path |
| A secret file is denied | Check the active read/Strict Roots policy and that the intended root is registered; do not weaken mutation scope to make a read succeed |
| process_start refuses PowerShell/CMD or an interpreter-style command | Use a policy-supported executable + argv inside the Active Project; free-form inline command strings and prohibited destructive forms fail closed |
| Child process windows are visible | This is expected for the current visible-window Windows build; use handles/logs to manage them |
| codex_status is unavailable | Install Codex or continue with process_* and project_*; lnwjud does not inspect credentials |
| Tunnel disconnects with context canceled / context deadline exceeded | MCP connection TTL teardown; start-lnwjud-tunnel.ps1 restarts even on exit 0. After restart, Refresh the connector or send a new ChatGPT message |
| ChatGPT advertises old tools | Restart server/tunnel, Refresh the connector, and start a new conversation |
| Long tool run looks dead / silent | lnwjud emits progress heartbeats every ~15s after the first 15s; ensure tunnel-client is current and TTL is set via `--mcp.connection-max-ttl 168h0m0s` |

For ambiguous failures, call health locally and run tunnel-client doctor
--explain before restarting both layers.

## Public repository and distribution hygiene

This repository is intended to be safe to clone and redistribute, but a local
agent project can easily accumulate machine-specific files if release hygiene is
not enforced.

Current repository rules:

- `.env`, private keys, SSH/AWS credential files, local databases, logs, and
  diagnostic output are ignored by Git.
- Generated MCP stdio bundles under `apps/desktop/build/` are ignored and are
  regenerated from source during build/package. Do not force-add them.
- Logo generation uses repository-relative paths (or explicit CLI arguments),
  not developer-home or editor-upload paths.
- README local documentation links are release-tested so public readers are not
  sent to ignored/private documentation.
- A release regression test rejects known developer-specific paths/private
  project identifiers from tracked text files.
- Secret scanning should cover **Git history**, not only the current working
  tree. Removing a secret from the latest file does not remove it from old
  commits or tags.

Before publishing a fork or release:

```powershell
# Public-tree regression checks
corepack pnpm@10.15.0 exec vitest run tests/release/public-repo-hygiene.test.ts

# Tracked-tree sanity
 git diff --check
 git status --short

# Optional but strongly recommended when gitleaks is installed
 gitleaks git --redact --no-banner
```

If a real credential was ever committed, **rotate/revoke it first**. Then decide
whether the public Git history/tags also need to be rewritten; deleting it from
`main` alone is not a credential-remediation strategy.

Git commit author metadata is public in a public repository. Contributors who do
not want to publish a personal email address should configure a GitHub-provided
`users.noreply.github.com` address before committing.

## Community and contribution

- [Contributing guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [Issue tracker](https://github.com/engasnm111/lnwjud/issues)

Please use the security policy instead of public issues for vulnerability details.
## Development and verification

```powershell
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 test:integration
corepack pnpm@10.15.0 test:packaging
corepack pnpm@10.15.0 build
corepack pnpm@10.15.0 package:windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-release.ps1
```

Electron end-to-end tests:

```powershell
corepack pnpm@10.15.0 test:e2e
```

Use `git diff --check` before committing. For publishing, follow the canonical [release process](docs/development/RELEASE_PROCESS.md): PR/non-main CI skips only the expensive Windows installer packaging, while the exact commit on `main` runs the full gate and creates the SHA-scoped artifact that the tag-triggered Release workflow reuses.

## Repository layout

```text
apps/desktop/          Electron main/preload/renderer and dashboard
apps/cli/              CLI parser and local service entrypoints
packages/application/  Shared use cases and orchestration
packages/domain/       Result/error contracts and policy types
packages/workspace/    Workspace registry, path guard, and secret policy
packages/filesystem/   File adapters
packages/search/       Ripgrep adapter
packages/project/      Project detection and command profiles
packages/git/          Read-only Git adapter
packages/process/      Process lifecycle and bounded logs
packages/codex/        Local Codex discovery and task adapter
packages/permissions/  Permission profiles and command policy
packages/audit/        Sanitized audit events
packages/storage/      SQLite repositories and migrations
packages/mcp-server/   MCP registry plus stdio/HTTP transports
packages/capabilities/ Local shell/browser/UI/vision/window capabilities
packages/extensions/   Local skills catalog and MCP server bridge
packages/ipc-contracts/Typed Electron IPC contracts
assets/logo/           Official brand logos and icons in multiple resolutions
```

All entrypoints are intended to call the same application services so that
validation and permissions remain consistent.

## Further reading

### Official OpenAI documentation

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect and test a plugin in ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [ChatGPT MCP and Codex configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
- [OpenAI Platform API keys](https://platform.openai.com/settings/organization/api-keys)
- [OpenAI tunnel-client releases](https://github.com/openai/tunnel-client)

## License

This project is licensed under the [MIT License](LICENSE).
