> **Expanded reference:** this file preserves the long-form README and historical release detail. For the current concise overview, installation links, and release status, start with [README.md](README.md). Historical version-specific sections below are intentionally retained.

<p align="center">
  <img src="assets/logo/logo-256x256.png" width="160" alt="lnwjud logo" />
</p>

<h1 align="center">lnwjud</h1>

<p align="center">
  <strong>Cross-platform local AI-agent runtime and MCP gateway</strong><br />
  <em>285 total tool definitions for local files, Git, processes, Windows automation, WSL, browser control, durable goal continuation, Engineering Harness, native Goal automation, context capsules, indexing, observability, Office semantic automation, ECC integration, and extensibility; 273 are advertised by default and all 285 when Codex delegation plus Agent Swarm is enabled.</em>

  <em>อ่านที่เหลือใน Readme ได้เลยครับ ติดปัญหาทักมาได้ใน FB: Adisorn NM ได้ตลอดครับ / กำลังพัฒนาให้เรื่อยๆครับ ท่านที่ถามหาช่องสนับสนุนค่ากาแฟ แปะลิงค์ ไว้ให้แล้วครับ ขอบคุณครับ</em>
 https://easydonate.app/abcz
</p>

<p align="center">
  <strong>💬 lnwjud Community</strong><br />
  มีกลุ่มพูดคุยสำหรับ lnwjud แล้วนะครับ หากท่านใดติดปัญหา หรืออยากแชร์การใช้งาน ไอเดีย หรือประสบการณ์ต่าง ๆ สามารถเข้ามาพูดคุยและแชร์กันได้ในกลุ่มครับ<br />
  <a href="https://url.in.th/rEZiG"><strong>เข้าร่วมกลุ่ม lnwjud Community</strong></a>
</p>

<p align="center">
  <a href="https://github.com/engasnm111/lnwjud/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/engasnm111/lnwjud" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4" />
  <img alt="Node" src="https://img.shields.io/badge/Node.js-24.x-339933" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-285%20tools-6f42c1" />
</p>

---

## What is lnwjud?

lnwjud is a cross-platform local development gateway that exposes trusted local
capabilities through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).
It is designed for AI-assisted software development where the agent needs more
than a text-only chat: it may need to inspect a repository, search code, edit
files, review Git state, run project commands, manage owned processes, inspect
Windows UI state, automate a managed browser, work with WSL, or call an
additional local MCP server.

The runtime stays on the local host. Local filesystem paths, processes,
SQLite state, credentials, and capability backends are owned by lnwjud on that
machine. Remote AI clients only receive the MCP requests and results that travel
through the connection mode you choose.

For ChatGPT web and other supported OpenAI surfaces, lnwjud supports the official
[OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
The tunnel is outbound-only: `tunnel-client` runs beside lnwjud, reaches OpenAI
over outbound HTTPS, forwards MCP work to lnwjud's Desktop loopback HTTP MCP,
and returns the response without opening a public inbound port on the host.

## Current published version: v5.7.4

## Current source version: v5.8.0

### What's new in v5.8.0

**v5.7.4** primarily fixed oversized native approval dialogs. **v5.8.0** adds six review-first workflows, richer Doctor evidence, CSV/XLSX data tasks, Git explorer upgrades, a consistent Desktop UI, more reliable Secure MCP Tunnel startup, and controlled dependency maintenance.

- **Six bilingual workflows:** Project Check, Code Review, Release Readiness, Connection Check, Data Audit, and Template Report. Required inputs are validated before preparing a draft; a preview never silently launches a Goal, scheduler, or AI worker.
- **MCP Call History:** retained audit-backed calls with bounded pagination, tool/Goal filters, outcomes, and server p50/p95 when samples exist. Transport/Tunnel timing is still `unknown` where no trusted sample exists; only Goals with attributable calls appear in the Goal filter.
- **Goal Results and checkpoints:** inspect meaningful progress, completed steps, recorded checks, actual mutation receipts and verifiable file artifacts. Result filters exclude Goals without evidence; verification is not inferred from a Goal's completed status.
- **Process Resources:** display measured Windows working-set RAM and lifetime-average CPU for verified Goal-owned child processes; separately show the Desktop main process. Refresh while viewing, suppress Goals without measured resources, and never substitute zero for unavailable measurements.
- **Context Economy observability:** show real transport-scoped MCP HTTP ledger hits and context bytes, explicitly not per-Goal totals. Shared services are not cancelled with a Goal; owned-task cancellation stays permission- and identity-checked.
- **Safer restore and audit visibility:** result and restore flows preserve workspace scope, exact checkpoint/Goal revision checks, verified current file hashes, and explicit user confirmation.
- **CSV/XLSX data workflows:** typed audit and comparison of tabular data plus template-based report creation with readback. Preserve source files by default; native Office actions remain dependent on platform/provider support.
- **Git explorer and diffs:** show individual untracked files in new folders, not merely folder counts. Expand/collapse the tree, search and filter files, retain code/diff navigation, and show safe text/image previews or bounded binary metadata.
- **Desktop controls and typography:** shared inputs, filters, buttons and responsive searchable dropdowns across Settings/Tools/Doctor/Git; menus anchor **below their fields only**, reserve outer scrolling room and scroll internally for long lists. Options wrap when long, compact options remain compact. Restore Prompt/previous Git text sizing and improve validation/loading feedback.
- **Command Prism status visual:** replace the plain golden orb with a faceted prism, using actual MCP states (gold = ready, blue = working, red = stopped/offline). A reserved neutral gray visual does not claim a new backend state. Workflow cards receive matching restrained line icons.
- **Modal and layout fixes:** correct shared-button CSS precedence so close glyphs stay visible in What's New, Tool Detail, and the guided Tunnel screen. Increase close targets, preserve keyboard access, and separate search fields from actions.
- **Work Log and Doctor UX:** default Work Log to all workspaces; improve workspace/session filters, loading states, long labels, goal descriptions and meaningful empty states. Doctor Goal selectors show only entries that have relevant results for each tab.
- **Secure MCP Tunnel reliability:** do not reconnect over a matching managed runtime before a 45-second elapsed readiness grace period. Keep Tunnel identity, ownership protection, health polling and retry backoff; this avoids premature repeated `connect` calls but does not guarantee a fixed startup time.
- **Bundled native runtime:** update the verified target-native `tunnel-client` to **0.0.16** and preserve native payload preparation for installation on supported platforms.
- **Dependency updates and delivery checks:** use one managed dependency-update PR with conditional branch cleanup rather than duplicate updates. Keep functional tests and exact-commit target-native CI/build gates; Windows community artifacts can remain unsigned when no signing certificate exists, with SHA-256/provenance checks required.

**ภาษาไทย — ต่างจาก 5.7.4:** เพิ่มเทมเพลต 6 แบบ, ประวัติ MCP และผลงาน Goal ที่มีหลักฐาน, RAM/CPU จริงของโปรเซสที่ตรวจเจ้าของได้, Context Economy แบบรวมระดับ Transport, ตรวจ CSV/XLSX, Git tree/preview ที่ครบขึ้น, UI และ dropdown กลาง, กากบาท Modal ขนาดชัดเจน, Work Log ที่กรองง่ายขึ้น, แก้ Tunnel reconnect ก่อนพร้อม และอัปเดต tunnel-client 0.0.16 พร้อมการทดสอบ/แพ็กเกจตาม SHA จริง ค่าไม่ทราบจะไม่แสดงเป็น 0 หรืออ้างว่าสำเร็จโดยไม่มีข้อมูล

Latest published release: **v5.7.4**. Windows, macOS, and Linux artifacts are published only after the exact tagged main commit passes the target-native release gates described below.

### What's new in v5.7.4

- **High-risk approval details stay on screen across Windows, macOS, and Linux:** the complete command appears in a bounded lnwjud window with its own scrollable detail area. Cancel is focused by default, and closing the window or pressing Escape cancels the request.
- **Other native alerts resist oversized error text:** variable Update, Tunnel, and shutdown error messages are bounded before they reach native dialogs.

ภาษาไทย: v5.7.4 แก้กล่องยืนยันคำสั่งเสี่ยงสูงที่ยาวจนล้นจอ โดยยังดูคำสั่งฉบับเต็มผ่านพื้นที่เลื่อนได้เหมือนกันบน Windows, macOS และ Linux; ปุ่มยกเลิกเป็นค่าเริ่มต้น และยังจำกัด error text ที่ยาวผิดปกติใน native alert จุดอื่นด้วย

### What's new in v5.7.3

- **Engineering Harness verifies real release evidence:** package gates can consume fresh durable-shell artifacts, cross-platform gates bind to the exact commit, and Windows records Authenticode state. Configured production signing must be Valid, while community releases without a certificate may remain unsigned after SHA-256 and provenance checks.
- **Durable Goal continuity is more reliable:** Ponytail ULTRA preserves loaded skill activation across transport-session rotation, and `finish_goal` reports unfinished plan, acceptance, gate, or blocker conditions instead of false stale-CAS conflicts when the revision is unchanged.
- **Serena and external MCP child processes are safer:** a rejected tool call no longer forces a healthy process to respawn, and replacement waits until the previous process is verified stopped, reducing duplicate processes and resource leaks.
- **Linux AppImage startup is more resilient:** the app can start when keyring/secure storage is temporarily unavailable while encrypted secret/checkpoint operations remain fail-closed; the static AppImage runtime also avoids a FUSE2 dependency.
- **Work Log and Live Logs report severity truthfully:** RESULT event type is separated from INFO/WARN/ERROR severity, recoverable states no longer look like hard errors, filters are clearer, and Workspace/Session badges can copy full canonical IDs.
- **Secure MCP Tunnel, Portable, and Recovery are safer:** fresh installs no longer auto-enable persistent reconnect, Recovery adds a 3-day option, bundled `tunnel-client` selection works after clearing a custom override, and stale runtime ownership is cleared only after lnwjud proves no external Tunnel is running.
- **Managed-browser/native foreground coordination is hardened:** `activate_tab`, browser-scoped file upload with Active Project checks, cross-project foreground serialization, and optional postcondition evidence keep native input aligned with the intended tab and target state.

See [Thai Engineering Harness setup and workflow](docs/USAGE_TH.md#8a-engineering-harness--senior-coding-workflow) for details.

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for complete version history and [Thai troubleshooting](docs/USAGE_TH.md#13-doctor--troubleshooting) for Agent Swarm setup.

Current v4 highlights include:

- Workspace registration, bounded project snapshots, file reads/writes, paging,
  full scans, persistent indexing, and continuation tokens.
- Git status/diff/log plus policy-checked Git execution.
- Foreground/background command tasks with ownership, timeout, cancellation,
  bounded output, logs, and result retrieval.
- Project-aware development, test, lint, typecheck, and build commands.
- Local Codex discovery and optional delegation without reading Codex credential
  files.
- Host-native capabilities for shell execution, windows, accessibility, input,
  screen capture, notifications, clipboard, file dialogs, audio, screen
  recording, Office automation, and scheduling where the declared platform
  provider and permissions are available. Windows-only features remain clearly
  marked unsupported elsewhere.
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
- OpenAI Secure MCP Tunnel management with operating-system secure runtime-key
  storage, target-native bundled clients, and reconnect handling. Windows
  legacy DPAPI envelopes migrate once through the native helper.

Authoritative in-repository references:

- [Native platform support contract](docs/architecture/PLATFORM_SUPPORT.md) —
  macOS/Linux support tiers, bundled official `tunnel-client` evidence, and
  the Windows-only features deliberately marked unsupported on foreign hosts.
- [macOS installation guide](docs/INSTALL_MACOS.md) and [Linux installation
  guide](docs/INSTALL_LINUX.md) — clean-machine install, permissions, tunnel,
  STDIO, troubleshooting, and platform limits.
- [Native provider development](docs/NATIVE_PROVIDER_DEVELOPMENT.md) — bounded
  helper protocol, target-host build rules, integrity evidence, and readiness
  boundaries.
- [Tool contract](docs/architecture/TOOL_CONTRACT.md) — core primitive schemas,
  policy classes, and compatibility rules; the 259-definition complete index below comes from the live runtime registry.
- [Upgrade architecture](docs/architecture/UPGRADE_ARCHITECTURE.md) — v4 runtime
  architecture and additive gateway design.
- [Release process](docs/development/RELEASE_PROCESS.md) — canonical `dev -> PR -> main CI -> tag -> Release -> dev sync` sequence, exact-SHA artifact rule, and failure handling.
- [Roadmap phase status](docs/architecture/ROADMAP_PHASE_STATUS.md) — completed
  implementation phases.

## Security model you should understand before using it

lnwjud is intentionally powerful. It is intended for a machine and workspace you
trust, not as a sandbox for unknown code.

- **Unrestricted mode is enabled by default for read/discovery compatibility, but it never scans or registers filesystem roots automatically.** It permits explicitly requested absolute paths. With Full Bypass OFF, Unrestricted does not widen the host-selected Active Project mutation boundary or bypass command/approval policy. Full Bypass is a separate explicit control.
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
- Runtime tunnel API keys saved from the desktop UI are encrypted with the host's
  secure storage provider. Never commit a runtime key, `.env`, tunnel
  profile containing a plaintext secret, private key, or credential file.

The Context Economy Engine reduces automatic discovery cost without acting as a
security deny list. Automatic search/index/watch flows skip vendor, build,
cache, binary, generated-bundle, and source-map noise, while explicit reads or
full scans can still inspect paths allowed by the active workspace/policy.

## Connection modes

| Client / use case | Connection | What must run on the host | Notes |
| --- | --- | --- | --- |
| ChatGPT Business custom app | Remote MCP via ngrok + OAuth | lnwjud Desktop + ngrok | Recommended easy path: an Admin/Owner configures and publishes the public HTTPS `/mcp` once; members press Connect. Recognized ChatGPT callbacks—including `/connector/oauth/<redirect_id>` used by newly created Plugins/Apps—authorize through the local Desktop handoff. Unrecognized OAuth clients are rejected instead of falling back to a legacy manual-consent flow. |
| ChatGPT web developer-mode app | OpenAI Secure MCP Tunnel | `tunnel-client` + lnwjud Desktop | Private outbound-only path to the Desktop loopback HTTP MCP; no public MCP port |
| Codex CLI or another local MCP host | Local stdio MCP | `lnwjud-mcp-stdio.cmd` | Lowest-overhead local MCP path |
| Local MCP client / dashboard diagnostics | Loopback Streamable HTTP | lnwjud Desktop | Uses an automatically assigned free loopback port by default; actual URL is shown in the UI |
| Supported OpenAI API/Codex surface | Secure MCP Tunnel | `tunnel-client` + local MCP target | Tunnel association and Platform permissions apply |

For most ChatGPT web users, choose **one primary remote connection method**: Remote MCP via ngrok + OAuth is the recommended path, while OpenAI Secure MCP Tunnel is the alternative/advanced path. They are independent transports/authentication surfaces, so enabling one does not remove the other; power users can deliberately keep both online. In Desktop Settings, each method is grouped in its own collapsible section with independent ONLINE/READY/SETUP state, and Secure Tunnel auto-collapses while Remote MCP OAuth is online to keep the normal setup path focused.

The desktop HTTP server starts automatically; adding a project is required before workspace-scoped work, but Doctor and Projects remain available when no project is registered yet.
By default the server asks the OS for a free loopback port, so normal users do not need to configure a port or resolve collisions. Advanced users can pin a non-zero port in Settings or `LNWJUD_MCP_PORT`; if that explicit port is unavailable, lnwjud can fall back and reports the actual endpoint. Always use the endpoint shown in the dashboard. The **Start
Connection** button is useful after a manual stop, while **Stop Connection**
stops the current local HTTP listener.

## Quick start: install a supported release

Choose the guide for the host you will run lnwjud on:

- [macOS 13+ (arm64/x64)](docs/INSTALL_MACOS.md)
- [Linux x64/arm64 on Ubuntu 24.04 LTS](docs/INSTALL_LINUX.md) (arm64 requires the matching native artifact)
- Windows 10/11 x64: the Windows flow below

### 1. Install lnwjud Desktop

1. Download the latest published installer from
   [GitHub Releases](https://github.com/engasnm111/lnwjud/releases/latest).
   Current published Windows 10/11 x64 v5.7.4 artifacts are `lnwjud-Setup-5.7.4.exe` (recommended installer) and `lnwjud-Portable-5.7.4.exe` (no installation required).
2. Run the NSIS installer and launch **lnwjud Agent Control Center**.
3. Add or select the project/workspace you want lnwjud to operate on.
4. Review **Settings** before attaching an AI client, especially Permission
   Profile and Unrestricted Mode.

If you prefer not to install the app, run the currently published `lnwjud-Portable-5.7.4.exe` directly.
Portable mode uses the same per-user lnwjud data/settings location as the installer;
it is a portable executable, not a keep-all-data-next-to-the-EXE mode.
Automatic updates preserve the distribution you chose. Installer users read
`latest.yml` and receive the next `lnwjud-Setup-<version>.exe`. Portable users
read `portable.yml` and receive the next `lnwjud-Portable-<version>.exe`, which
is verified by the updater and then replaces the same Portable EXE path with a
backup/rollback/restart flow after the running process exits. The updater never
converts a Portable install into an Installer install or the reverse.


The graphical desktop app and the packaged **local STDIO** launcher are
self-contained. Target packages ship Electron and a native launcher, so end
users do **not** need a separate system Node.js installation. Secure Tunnel uses
the running Desktop HTTP MCP plus the bundled official target-native
`tunnel-client`; it does not spawn the packaged STDIO launcher.

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

For most ChatGPT web users, **start here**. Remote MCP via **ngrok + OAuth** was established as the default/backward-compatible Remote MCP transport in v5.5.0 and remains the default in the current v5.8.0 source line. It does **not** require an OpenAI Tunnel ID or Runtime API key. lnwjud keeps its real MCP server on loopback, places an OAuth-protected gateway in front of it, and exposes only that protected gateway through ngrok as an HTTPS URL ending in `/mcp`.

1. Open **lnwjud → Settings → Remote MCP & Tunnel**.
2. Check the ngrok status. If lnwjud shows **READY**, keep the detected installation. If it is not ready, lnwjud shows only the installation path supported by the current host: Windows may use Microsoft Store/WinGet, macOS may use Homebrew when available, and hosts without a verified automatic installer get the official ngrok download link instead. Runtime discovery itself is cross-platform and verifies `ngrok version` before use.
3. Save your ngrok authtoken once, then click **Start Remote MCP**. lnwjud starts the OAuth gateway and ngrok, detects the public HTTPS MCP URL, and shows a **Copy MCP URL** action.
4. **Business Admin/Owner setup:** in Workspace Settings → Apps → Create, add the public `https://.../mcp` URL, select **OAuth**, complete Scan Tools, create the app, then **Publish** it. Ordinary workspace members do not need Developer mode and do not paste the Server URL again.
5. **Member connection:** open the published custom lnwjud app in ChatGPT and press **Connect**. For the exact supported ChatGPT OAuth callback paths, the browser is handed once to a random short-lived `http://127.0.0.1:<ephemeral>/...` approval listener owned by the running lnwjud Desktop, then lnwjud completes DCR + Authorization Code + PKCE and redirects back to ChatGPT — **no manual code entry and no extra approval click**. The public ngrok endpoint cannot redeem that localhost ticket. OAuth clients outside the supported ChatGPT callback contract are rejected with `403 access_denied`.
6. lnwjud remembers the trusted registered ChatGPT client and valid refresh grant in the host secure-storage provider. Ordinary app restarts or **Start Remote MCP** do not require another authorization. An explicit **Stop** disables auto-start but preserves the trusted OAuth relationship; use **Reconnect ChatGPT** only when you intentionally want to reset that relationship.
7. Confirm the connection discovers **273 tools by default** (or **285** when Codex delegation plus Agent Swarm is explicitly enabled), then run a read-only smoke test before writes.

The public ngrok URL is not the raw loopback MCP endpoint: requests must pass OAuth and bearer-token validation at the separate gateway. Do not publish `http://127.0.0.1:<port>/mcp` directly through a generic reverse proxy.

#### v5.5.0 Remote MCP transport selector

The transport selector is additive and does not migrate an existing user automatically:

- **ngrok** — default and legacy-compatible. lnwjud can install/resolve its managed ngrok runtime, stores the authtoken through secure storage, starts the protected OAuth gateway, spawns only its owned ngrok child, and preserves the configured/static origin behavior from earlier versions.
- **Cloudflare** — for a Cloudflare Tunnel or reverse proxy that **you manage**. lnwjud does not create the Cloudflare tunnel. It starts a stable loopback OAuth gateway, shows that local gateway target, requires a configured public HTTPS origin, and verifies that the public origin actually routes back to the gateway before reporting RUNNING. ngrok is not installed or spawned in this mode.
- **Custom URL** — the same protected stable-gateway model for another externally managed HTTPS reverse proxy. No ngrok token/install is required. The configured public origin must be HTTPS and must route to the shown loopback gateway.
- **Local MCP** — starts only the loopback MCP listener. It has no public gateway, no ngrok requirement, no public OAuth requirement, and no ChatGPT remote-plugin setup prompt. Use it for local MCP clients; it is not a replacement for Remote MCP OAuth or OpenAI Secure MCP Tunnel.

Cloudflare/Custom must proxy the **protected gateway target shown in Settings**, not the raw Local MCP endpoint. Existing OAuth client trust, refresh grants, Secure MCP Tunnel configuration and Persistent Tunnel Runtime state are independent of this selector.

### 3. Alternative: OpenAI Secure MCP Tunnel (Tunnel ID + Runtime API key)

Use this path only when you specifically prefer the official outbound-only Secure MCP Tunnel transport or your organization requires it. **Tunnel ID + Runtime API key is an alternative/advanced setup, not the default Quick Start path.**

The Secure MCP Tunnel flow requires a Platform tunnel ID and a runtime API key. Published target-native packages include the official OpenAI `tunnel-client v0.0.15` for the packaged OS and architecture, with pinned checksum, license, and provenance evidence. Release users do **not** download or extract a separate tunnel-client package. Creating or editing a tunnel requires **Tunnels Read + Manage**; the runtime key needs **Tunnels Read + Use**.

1. Open [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
2. Create a tunnel named `lnwjud` and associate it with the Platform organization and ChatGPT workspace that should use it.
3. Create a restricted runtime API key with **Tunnels Read + Use**.
4. Open **lnwjud → Settings → Remote MCP & Tunnel → OpenAI Secure MCP Tunnel**. Save the runtime API key, leave the bundled-client override empty, paste the tunnel ID, and click **Configure Tunnel**.
5. The wizard selects the bundled client, starts or reuses lnwjud's Desktop loopback HTTP MCP, creates or repairs the `tunnel-client/lnwjud.yaml` profile under the host's platform-appropriate application-data directory, and runs the required diagnostics.
6. In ChatGPT, add a **Tunnel** connection and select the associated `lnwjud` tunnel or enter its `tunnel_id`.

The tunnel-client path field is an **override/troubleshooting** control only. Clear it and choose **Use bundled** to return to the package-supplied client. Secure Tunnel forwards to the running Desktop MCP and does not spawn a separate headless lnwjud MCP runtime, so Desktop-selected Active Projects and native exact-action approval remain authoritative.

**Multi-chat / multi-host:** one lnwjud Desktop instance and one `lnwjud` Secure Tunnel are designed to serve multiple simultaneous ChatGPT chats and workspaces. Do not create a separate tunnel profile for each chat; Desktop HTTP MCP already separates concurrent protocol sessions, and v4.62.0 explicitly configures bundled tunnel-client with `MCP_MAX_CONCURRENT_REQUESTS=32` (while retaining the 168-hour transport TTL) to provide headroom when several chats fan out tool calls at the same time. This is different from running lnwjud on several physical hosts. tunnel-client's HTTP deployment model allows replicas to share a Tunnel ID, but queued work is delivered to whichever replica polls it first; it does not pin a particular ChatGPT chat to a particular Mac/Windows host. Therefore, when each host must be independently selectable, use a distinct Tunnel ID and ChatGPT Tunnel connection per host (for example `lnwjud-mac` and `lnwjud-windows`). Remote MCP via ngrok + OAuth remains the recommended connection path and removes the extra tunnel polling/dispatch hop, so it can still feel more responsive under bursty workloads.

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

ส่วนนี้สำหรับผู้ใช้ Windows ที่ต้องการติดตั้ง lnwjud แล้วเชื่อมกับ ChatGPT แบบง่ายที่สุด โดย **วิธีหลักที่แนะนำสำหรับ v5.7.4 คือ Remote MCP ผ่าน ngrok + OAuth** ไม่ต้องมี OpenAI Tunnel ID และไม่ต้องสร้าง Runtime API key สำหรับขั้นตอนหลักนี้ ส่วน **Tunnel ID + Runtime API key** ยังคงรองรับ แต่เป็นทางเลือก/โหมดขั้นสูงสำหรับผู้ที่ต้องการ OpenAI Secure MCP Tunnel โดยเฉพาะ

### 1. ติดตั้ง lnwjud หรือใช้ Portable

1. แบบแนะนำ: ดาวน์โหลด public release ล่าสุด `lnwjud-Setup-5.7.4.exe` แล้วติดตั้งตามปกติ
2. ถ้าไม่ต้องการติดตั้ง: ดาวน์โหลด `lnwjud-Portable-5.7.4.exe` แล้วเปิดได้ทันที
3. เปิด **lnwjud Agent Control Center**
4. เพิ่มหรือเลือก Project/Workspace ที่ต้องการให้ ChatGPT ทำงานด้วย

Portable ใช้ Settings/ข้อมูลต่อผู้ใช้ Windows ชุดเดียวกับตัวติดตั้ง ไม่ได้เก็บ database/settings ทุกอย่างไว้ข้าง EXE และตัว release มี packaged Electron host/STDIO launcher สำหรับ local MCP มาให้แล้ว จึงไม่ต้องติดตั้ง Node.js แยกเพื่อใช้งานโปรแกรม

### 2. เชื่อม ChatGPT ด้วย Remote MCP + OAuth (แนะนำ)

สำหรับผู้ใช้ ChatGPT เว็บทั่วไป **ให้เริ่มจากวิธีนี้ก่อน**:

1. เปิด **Settings → Remote MCP & Tunnel**
2. ดูสถานะ ngrok ก่อน ถ้าขึ้น **READY** ให้ใช้ตัวที่ตรวจพบได้เลย; ถ้ายังไม่พร้อมให้กด **ติดตั้ง ngrok อัตโนมัติ** ซึ่ง lnwjud ใช้ช่องทาง Microsoft Store/WinGet ทางการ
3. ใส่ ngrok authtoken หนึ่งครั้ง แล้วกด **Start Remote MCP**
4. รอให้ lnwjud เปิด OAuth-protected gateway, รัน ngrok และแสดง public HTTPS MCP URL ที่ลงท้าย `/mcp` จากนั้นกด **Copy MCP URL**
5. **ฝั่ง Admin/Owner ของ Business:** ไป Workspace Settings → Apps → Create, ใส่ URL ที่คัดลอกมา เลือก **OAuth**, Scan Tools ให้ผ่าน แล้ว Create และ **Publish** แอป lnwjud ให้ Workspace. สมาชิกทั่วไปไม่ต้องเปิด Developer mode และไม่ต้องกรอก Server URL ซ้ำ
6. **ฝั่งสมาชิก:** เปิดแอป lnwjud ที่ถูก Publish แล้วกด **Connect**. ถ้าเป็น callback ของ ChatGPT ที่รองรับ browser จะถูกส่งผ่าน one-time URL ที่ `127.0.0.1` ของเครื่องผู้ใช้ไปหา lnwjud Desktop โดยอัตโนมัติ แล้วจึงทำ DCR + Authorization Code + PKCE และ redirect กลับ ChatGPT — **ไม่ต้องกรอกรหัสและไม่ต้องกดยืนยันเพิ่ม**. public ngrok endpoint ไม่สามารถนำ localhost ticket นี้ไปแลกสิทธิ์แทนได้ และ OAuth client ที่ไม่ตรง callback ที่รองรับจะถูกปฏิเสธด้วย `403 access_denied`
7. หลังเชื่อม lnwjud จะจำ trusted ChatGPT client และ refresh grant แบบเข้ารหัสด้วย secure storage ของ host การเปิดโปรแกรมใหม่หรือกด Start ตามปกติจึงไม่ต้องอนุมัติซ้ำ. การกด **Stop** จะหยุด auto-start แต่ยังจำความสัมพันธ์ OAuth เดิมไว้; ใช้ **Reconnect ChatGPT** เฉพาะเมื่อต้องการล้างความสัมพันธ์ใหม่จริง ๆ
8. ตรวจว่า ChatGPT เห็น tools ของ lnwjud — ปกติ **264 tools**, หรือ **276** เมื่อเปิด Codex delegation + Agent Swarm — แล้วค่อยเริ่มจากงาน read-only

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

`lnwjud-Setup-5.0.0.exe` และ `lnwjud-Portable-5.0.0.exe` รวม official OpenAI `tunnel-client v0.0.15` มาให้แล้ว จึง **ไม่ต้องดาวน์โหลด `tunnel-client.exe` เอง** ช่อง path เป็น override สำหรับ troubleshooting เท่านั้น; หากต้องการกลับไปใช้ตัว bundled ให้ล้าง override แล้วเลือก **Use bundled** อย่างชัดเจน

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

- Windows x64, macOS 13+ arm64/x64, or Linux x64 on Ubuntu 24.04 LTS.
- Node.js `>=24.0.0 <25`.
- Git.
- Corepack with the repository-pinned `pnpm@10.15.0`.
- PowerShell is needed only for Windows-specific migration/packaging helpers.
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

The build generates a Windows `lnwjud-mcp-stdio.cmd` launcher and a POSIX
`lnwjud-mcp-stdio` shell launcher. Both invoke the packaged Electron executable
with `--mcp-stdio`, preserve arguments, and use the same protected checkpoint
storage as Desktop. No private Node executable or CJS stdio bundle is shipped.

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
Use $lnwjud-scheduled-continuation in workspace D:\projects\my-app. Create or resume one durable goal with goalKey release-audit and keep it authoritative until the objective and acceptance checks are complete. Maintain exactly one Native ChatGPT recurring watchdog in cloud mode for that goal, reuse the same native task ID across ordinary wakes, checkpoint meaningful progress, and make every scheduled wake call claim_scheduled_continuation before workspace mutation. Never substitute browser/DOM automation, Windows Task Scheduler, cron, shell timers, or another scheduler. Call finish_goal(status: completed) only after every plan step and acceptance criterion is complete, blockers are empty, blocking tasks are terminal, and the exact native watchdog has been made non-runnable with truthful cleanup evidence; then verify get_goal is terminal before reporting completion.
```

For clients that do not expose `$skill-name` syntax, ask the agent to call
`skills_list`, choose the source-qualified `lnwjud-scheduled-continuation`
result, call `skills_read`, and follow that skill. The first run creates or
resumes the durable goal and prepares exactly one hourly recurring Native
ChatGPT cloud watchdog. The Durable Goal remains the authoritative work state;
when plan or step progress changes, `update_goal_plan` updates that same durable
plan so Watcher presents the current plan/progress rather than a stale shadow.
Call `checkpoint_goal` immediately after meaningful step/task/blocker/commit/
push/hosted-CI/package milestones, and refresh at least every 10 minutes during
sustained work with no natural milestone. Meaningful checkpoints and handoffs
must carry reconstruction-grade `resumeContext` (changed files, exact commands
and results, decisions, failed attempts, pending validation, prerequisites,
state facts, and artifacts); a short summary alone is not sufficient.
Ordinary checkpoints keep useful work moving on the current lease; they do not
create or retime Scheduled Tasks and are not a reason to stop the worker. A
request to stop future scheduling cancels only that watchdog; the current worker
must still inspect blocking task results and finish the durable goal truthfully.

Every recurring wake must call `claim_scheduled_continuation` before any
workspace mutation. `recurring_acquired` returns the current goal lease and
continues from the latest durable checkpoint. `worker_busy_noop` performs no
workspace mutation while worker/blocking liveness is live or uncertain;
`already_claimed` is reserved for a true concurrent/stale duplicate whose
observation predates an already-recorded lease acquisition. An interval runKey
by itself is never liveness proof. A safely stale worker can be recovered in the same tick
when runtime liveness proves no real worker/blocking job remains and the bounded
stale-heartbeat grace has passed. Ordinary wakes never create a successor,
consume the recurring task, or retime its hourly cadence.

v5.0.0 adds a richer durable state model around that watchdog. `get_goal_plan`
projects the authoritative plan, `update_goal_plan` updates that same plan and
its Watcher-visible progress, `update_goal_acceptance` records explicit
completion evidence, and `revise_goal_intent` increments `userIntentRevision`
so older generated work cannot outrank newer accepted user steering. Bounded
immutable Context Capsules can summarize objective, decisions, validation,
completed/remaining work, changed files, artifacts, blockers, and next action
for compact/resume or `session_handoff`; they are task state, never private
chain-of-thought and never a browser transport. Delivery receipts preserve
ambiguous dispatch states without blind retry, while bounded iteration cannot
exceed its configured maximum.

A Native Scheduled Task host failure such as unavailable, unsupported, or
`Resource not found` is a **scheduler transport degradation**, not a durable
work outcome. Keep the goal active when useful work remains, record host state
truthfully, and never substitute Windows Task Scheduler, the lnwjud local
scheduler, cron, shell timers, another provider, or browser/DOM automation.
A concrete fixable CI, test, build, packaging, release-validation, or tool
failure is the next unit of work: inspect the exact failure, diagnose and repair
the root cause, and run the relevant validation in the same host turn while safe
useful actions remain instead of ending with a status-only report.
`finish_goal(status: completed)` remains guarded: all plan steps and acceptance
criteria must be complete, durable blockers must be empty, no blocking task may
remain tracked, and Engineering Harness goals must have every required gate and
blocking review finding resolved from real evidence. Before terminal completion,
make the exact native watchdog non-runnable using the strongest host operation
actually exposed and record truthful cleanup evidence. Reconcile stale duplicate,
superseded, or abandoned Goal cards when authoritative evidence shows the work is
no longer live. After `finish_goal`, verify `get_goal` is terminal before
reporting completion; completed work must not remain Active in Watcher.

Full Bypass does not bypass durable-goal ownership. A stale, missing, expired,
or generation-mismatched `goalLease` is rejected before file, Git, process,
delegated, or UI mutation dispatch, so an older worker cannot keep writing
after ownership has moved.

### STDIO permission profiles and strict roots

The packaged stdio launcher keeps `full` as its backward-compatible permission profile, but it no longer discovers or registers filesystem roots. Pass `--workspace` on first use; later launches may reuse an already registered project. You can opt into a narrower policy per launch:

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

- Windows x64, macOS 13+ arm64/x64, or Linux Ubuntu 24.04 LTS arm64/x64 with the matching native artifact.
- Node.js 24.x for source development/builds. Installed releases provide their own Electron/native launcher for direct local STDIO; Secure Tunnel uses the Desktop HTTP MCP and official target-native tunnel-client.
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
apps/desktop/dist/installers/lnwjud-Setup-5.8.0.exe
apps/desktop/dist/installers/lnwjud-Portable-5.8.0.exe
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

External MCP tools stay in their own origin/tab. Once the server connection and `tools/list` discovery succeed, those discovered tools are shown as `ready` at the transport/catalog layer. That does not invent child-server guarantees: permission/profile classification, cancellation, and dry-run support remain undeclared/unverified when the server does not publish them, and `mcp_call` still crosses the existing opaque dangerous approval boundary.

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
2. Copy the displayed loopback endpoint; the port is assigned automatically unless you explicitly pin one.
3. Add it to a compatible local Streamable HTTP MCP client.
4. Use **Stop Connection** when you intentionally want to stop the listener.
5. Use **Start Connection** to start it again after a manual stop.

The endpoint listens only on loopback: `127.0.0.1` and, when IPv6 loopback is available, `::1` on the same port. Host validation allows localhost values by default; any reverse-proxy/tunnel hostname must be explicitly allow-listed. Origin validation and the same application permission checks used by the dashboard remain enforced. Do not expose the raw loopback URL through a generic port forward.

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

The stdio launcher is `lnwjud-mcp-stdio.cmd` on Windows or
`lnwjud-mcp-stdio` on macOS/Linux, shipped next to the desktop app (not the GUI
entrypoint). It exposes the full tool catalog and needs no separate Node.js
installation for an installed release.

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
`tunnel-client v0.0.15`, so normal installed-release setup requires no separate
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
then click Start Tunnel. The key is stored with the operating-system secure
storage and is supplied to the tunnel process only for the active session.

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
scheduled task. The Desktop owns secure-storage access and supplies the key to
the active tunnel process without putting it in the profile or command line.

### Create a runner script

Save as start-lnwjud-tunnel.ps1:

```powershell
$ErrorActionPreference = 'Stop'
$tc = 'C:/path/to/tunnel-client.exe' # advanced manual override only
$profile = 'lnwjud'

if (-not (Test-Path $tc)) { throw "Missing tunnel-client: $tc" }
if (-not $env:CONTROL_PLANE_API_KEY) { throw 'Set CONTROL_PLANE_API_KEY for this transient troubleshooting session, or use Desktop Start Tunnel.' }
& $tc doctor --profile $profile --explain
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $tc run --profile $profile
exit $LASTEXITCODE
```

### Register the logon task

Run only as a temporary troubleshooting task. Do not place the key in the
scheduled-task command line; prefer Desktop Start Tunnel for persisted use.

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

When a first-party tool is enabled or disabled, standards-compliant MCP clients receive `notifications/tools/list_changed` and can refresh the live list without restarting lnwjud. ChatGPT app/action catalogs may additionally use a host-managed approved snapshot: use the ChatGPT action refresh/tool-scan flow that is actually available for the workspace. A browser F5 alone is **not** guaranteed to update an approved/frozen action snapshot, and lnwjud does not claim host synchronization without evidence.

<!-- BEGIN GENERATED README TOOL REGISTRY -->
## Complete MCP tool catalog (285 total definitions; 273 advertised by default; 285 with Codex delegation plus Agent Swarm enabled)

This complete index is generated from `ToolRegistry.listAll()`, not copied from an older release document. The default `tools/list` surface advertises only operational or dependency-gated definitions; planned and feature-disabled definitions remain visible here without being advertised. Enabling Codex delegation plus Agent Swarm adds 12 opt-in definitions to the advertised surface.

| # | Tool | Permission | Advertised | Delivery | Runtime evidence | Runtime description |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `workspace_list` | READ | default | operational | service_dispatch | List registered project workspaces available to lnwjud. Legacy explicitly registered drive roots may also appear as kind=machine_root. |
| 2 | `workspace_register` | WRITE | default | operational | service_dispatch | Register an existing project directory by absolute path. parentWorkspaceId is optional and retained only for legacy machine-root-relative registration. Idempotent for the same path. |
| 3 | `workspace_info` | READ | default | operational | service_dispatch | Return the configured workspace summary. |
| 4 | `workspace_tree` | READ | default | operational | service_dispatch | List a bounded workspace tree. Absolute path does not require workspaceId. |
| 5 | `project_snapshot` | READ | default | operational | service_dispatch | Return a bounded project snapshot without source contents. |
| 6 | `engineering_prepare_task` | READ | default | operational | service_dispatch | Read-only Engineering Harness preparation. Assess the registered workspace, applicable project instructions, effective Engineering policy, and policy digest without creating a goal, starting a process, scheduling work, or writing repository files. |
| 7 | `engineering_start_task` | WRITE | default | operational | service_dispatch | Start or resume a substantive Engineering Harness task by reusing the existing durable Goal authority. This operation does not create or authorize a scheduled continuation. |
| 8 | `engineering_get_status` | READ | default | operational | service_dispatch | Read the current Engineering Harness task projection, effective policy, required gates, blockers, and truthful delivery boundary without changing goal state. |
| 9 | `read_file` | READ | default | operational | service_dispatch | Read a workspace file as UTF-8 text or as an image/binary payload. Absolute host paths do not require workspaceId. For large files or an unknown location, prefer search_text first and then read_file_page for the relevant range instead of reading the whole file. |
| 10 | `read_files` | READ | default | operational | service_dispatch | Read up to twenty bounded workspace files in parallel. Absolute paths do not require workspaceId. For large files, locate text with search_text and page with read_file_page instead of loading entire files. |
| 11 | `search_files` | READ | default | operational | service_dispatch | Search workspace filenames with automatic context-economy filters; set includeIgnored for an explicit full path search. Absolute path does not require workspaceId. |
| 12 | `search_text` | READ | default | operational | service_dispatch | Preferred tool to locate relevant code/lines before reading files. Query matching is literal/fixed-string by default so characters such as (), {}, ?, +, and * are searched as text; set regex=true only for intentional ripgrep regex syntax. Glob filtering remains separate from the query. Uses direct ripgrep arguments with automatic binary/generated filters; path may be a directory or a specific file, and set includeIgnored for an explicit full path search. Absolute path does not require workspaceId. Follow with read_file_page for large files. |
| 13 | `git_status` | READ | default | operational | service_dispatch | Inspect parsed read-only Git status. For writes (init, add, commit, remote, push, rm, clean, reset) use the git tool. |
| 14 | `git_diff` | READ | default | operational | service_dispatch | Return a bounded read-only Git diff. For writes use the git tool. |
| 15 | `git_log` | READ | default | operational | service_dispatch | Return bounded structured Git history. For writes use the git tool. |
| 16 | `git` | EXECUTE | default | operational | service_dispatch | Run a Git subcommand with a separate args array. With Full Bypass OFF, Full Access runs ordinary read and non-destructive Git mutations without confirmation while destructive/data-loss forms, scope overrides, aliases, unsafe pathspecs, unknown commands, and destructive remote/history rewrites remain guarded or denied. Trusted Full Bypass skips lnwjud approval, command-policy, and Active Project scope checks, including explicitly absolute outside paths, without bypassing Git or OS errors. Do not wrap Git in PowerShell/cmd. |
| 17 | `write_file` | WRITE | default | operational | service_dispatch | Create or replace a UTF-8 text file and missing parents. Balanced/Safe refuse existing targets unless overwriteExisting is explicit; Full may replace an existing target without a confirmation prompt and still creates a checkpoint. Prefer edit_file for narrow repairs. Use this instead of shell scripts that call fs.writeFile, writeFileSync, Set-Content, or equivalent when the task is simply to create or replace guarded text. Do not use write_file to persist lnwjud continuation/recovery as USER_INSTRUCTIONS, user-instruction, or generic handoff-history files; use checkpoint_goal/session_handoff for that state. |
| 18 | `apply_patch` | WRITE | default | operational | service_dispatch | Apply reviewed whole-file replacement content to at most twenty files. Existing targets are checkpointed first; Full profile does not prompt for non-destructive replacement. Prefer edit_file for narrow repairs. Use this instead of shell-generated whole-file rewrites when several reviewed text files must change. |
| 19 | `edit_file` | WRITE | default | operational | service_dispatch | First choice for narrow source, config, and text repairs. Replaces exact text only when the expected occurrence count matches, checkpoints the original, and refuses conflicts instead of rewriting an unverified whole file. Exact-match conflicts are recoverable and include structured conflict kind, mismatch hints, candidate context when available, and a re-read/retry suggestion; never fuzzy-edit automatically. Use edit_file instead of shell, node -e, python -c, PowerShell Set-Content, or inline filesystem scripts when a guarded text edit can express the change. Full Access performs ordinary edits without a confirmation prompt; destructive deletion remains separately guarded. |
| 20 | `move_file` | WRITE | default | operational | service_dispatch | Move a file or directory, creating missing destination parents. With Full Bypass OFF, Full Access performs ordinary in-project moves without a confirmation prompt while conflicting or destructive forms remain policy-gated. Trusted Full Bypass skips lnwjud approval/scope checks for explicit absolute outside paths; OS/filesystem errors still apply. |
| 21 | `copy_file` | WRITE | default | operational | service_dispatch | Copy a file or directory within one workspace, creating missing destination parents. |
| 22 | `delete_file` | DANGEROUS | default | operational | service_dispatch | Delete one file or empty directory. With Full Bypass OFF, eligible in-project targets move to Recovery Trash and exact safe targets can use scoped auto-approval; critical paths, roots, non-empty directories, ambiguous paths, and mismatched workspaces remain guarded. Trusted Full Bypass skips lnwjud approval/scope checks and permits an exact absolute outside target, which is deleted without Recovery Trash; root and non-empty-directory input guards still apply. |
| 23 | `list_recovery_items` | READ | default | operational | service_dispatch | List trusted Recovery Trash entries for one workspace, including deleted items, binary pre-replacement backups, original paths, timestamps, payload availability, and the local Recovery Trash root. |
| 24 | `restore_deleted_file` | WRITE | default | operational | service_dispatch | Restore one Recovery Trash item to its original path. Deleted-item restores refuse existing targets. A pre-replacement restore first backs up the current live version for undo, then restores the older binary or text payload. Full runs recoverable restores without an extra prompt; stricter profiles may require confirmation. The operation remains scoped to the recorded workspace. |
| 25 | `list_checkpoints` | READ | default | operational | service_dispatch | List encrypted pre-mutation checkpoints for one workspace without returning saved file content. |
| 26 | `restore_checkpoint` | WRITE | default | operational | service_dispatch | Restore a reviewed pre-mutation checkpoint. Standard mode requires explicit confirmation; trusted Full Bypass skips the lnwjud confirmation gate. A new rollback checkpoint is created before replacing current content when the target is inside a recoverable workspace. |
| 27 | `process_start` | EXECUTE | default | operational | service_dispatch | Immediate-return managed process launcher for real executables and long-lived processes. With Full Bypass OFF, inline text-file rewrites must use edit_file/apply_patch/write_file and risky commands, scope changes, or permission-profile ASK decisions require confirmation. Trusted Full Bypass skips lnwjud command/profile/scope approval, including an explicitly absolute cwd outside the Active Project; input validation, executable availability, OS rights, and exact process ownership still apply. Starts one executable with separate arguments and returns processId as soon as the child is spawned; it never waits for command completion. Follow with process_status/process_logs/process_stop. For restart-safe durable work, use shell, whose MCP run mode is forced to background. |
| 28 | `process_list` | READ | default | operational | service_dispatch | List managed process handles owned by this client in a workspace, including launches whose response was cancelled. |
| 29 | `process_status` | READ | default | operational | service_dispatch | Read one status snapshot for an owned process handle. Do not tight-poll this tool; use project_* for normal project verification, or shell background + durable task_id for work expected to exceed ~5 minutes. |
| 30 | `process_logs` | READ | default | operational | service_dispatch | Read bounded logs for an owned process handle. Prefer one bounded log read after meaningful progress rather than repeated status polling. |
| 31 | `process_stop` | EXECUTE | default | operational | service_dispatch | Stop an owned managed process tree after explicit chat confirmation in standard mode. Trusted Full Bypass skips the lnwjud confirmation gate; exact process ownership still applies. |
| 32 | `project_dev` | EXECUTE | default | operational | service_dispatch | Immediate-return launcher for the detected project dev command. In standard mode the gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Trusted Full Bypass skips the lnwjud approval boundary. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 33 | `project_test` | EXECUTE | default | operational | service_dispatch | Immediate-return launcher for the detected project test command. In standard mode the gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Trusted Full Bypass skips the lnwjud approval boundary. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 34 | `project_lint` | EXECUTE | default | operational | service_dispatch | Immediate-return launcher for the detected project lint command. In standard mode the gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Trusted Full Bypass skips the lnwjud approval boundary. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 35 | `project_typecheck` | EXECUTE | default | operational | service_dispatch | Immediate-return launcher for the detected project typecheck command. In standard mode the gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Trusted Full Bypass skips the lnwjud approval boundary. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 36 | `project_build` | EXECUTE | default | operational | service_dispatch | Immediate-return launcher for the detected project build command. In standard mode the gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Trusted Full Bypass skips the lnwjud approval boundary. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 37 | `codex_status` | READ | Codex opt-in | operational | service_dispatch | Report local Codex installation and capabilities without credential inspection. |
| 38 | `codex_run` | EXECUTE | Codex opt-in | operational | service_dispatch | Delegate an instruction to the local Codex CLI in the Active Project. Starting Codex requires explicit chat confirmation and host approval in standard mode; trusted Full Bypass skips those lnwjud application checks without forging userConfirmed. |
| 39 | `codex_task_list` | READ | Codex opt-in | operational | service_dispatch | List local Codex task handles owned by this client, including launches whose response was cancelled. |
| 40 | `codex_task_status` | READ | Codex opt-in | operational | service_dispatch | Read status for an owned Codex task. |
| 41 | `codex_task_logs` | READ | Codex opt-in | operational | service_dispatch | Read bounded logs for an owned Codex task. |
| 42 | `codex_stop` | EXECUTE | Codex opt-in | operational | service_dispatch | Stop an owned Codex task process after explicit chat confirmation in standard mode. Trusted Full Bypass skips the lnwjud confirmation gate; task ownership still applies. |
| 43 | `agent_swarm_run` | EXECUTE | Codex opt-in | dependency_gated | service_dispatch | Run or inspect a bounded 1-4 task Codex-backed agent swarm in enforced read-only mode. The tool is available only when Codex tools are explicitly enabled. start/cancel require trusted host approval; status/result/list are owner-scoped reads. Prompts are never persisted in plaintext and unverifiable post-restart tasks report termination_unverified. |
| 44 | `shell` | EXECUTE | default | operational | service_dispatch | Non-blocking command runner for real command execution, builds/tests, package managers, and system operations. Never use shell as a source/config/text editor. For any direct text-file change, call edit_file first; use apply_patch for reviewed whole-file or multi-file replacements and write_file for file creation/replacement. Inline Node/Python/PowerShell/sed commands that rewrite text files are rejected before native approval so the client can route to the guarded file tools instead. MCP run calls are ALWAYS forced to execution=background, even if a client requests foreground or auto, so the call returns a task_id immediately instead of waiting for command completion. Follow with status/logs/result; wait uses the user-configurable MCP poll window (5-60 seconds, default 5). When the user requires babysitting until completion, keep using bounded waits and do not report completion until the terminal result is inspected. Otherwise, if the host turn must yield while a durable task is still running, checkpoint it as trackedTasks {taskId, provider: shell, role: blocking_job, cancelWithGoal: true} and use the active scheduled-continuation handoff instead of abandoning the goal. Shared services must be marked supporting_service with cancelWithGoal false. With Full Bypass OFF, Full Access runs ordinary policy-allowed commands without confirmation while destructive, broad, recursive, critical, outside-project, or unparseable forms retain normal approval/command policy. Trusted Full Bypass skips lnwjud approval, command-policy, Active Project, and allowed-root checks; an active rolling scheduled goal still requires the current goalLease ownership proof. Full Bypass may still use an explicitly absolute cwd outside the project; input validation, executable availability, Windows ACL/UAC, and child-process failures still apply. dry_run and task observation are non-mutating. |
| 45 | `dom_cdp` | READ | default | operational | service_dispatch | Default for web-page DOM work inside managed Chrome. Call list_tabs first, select the exact returned tab_id by URL/title, and pass that tab_id to every query, click, type, navigate, evaluate, wait, screenshot, activate_tab, set_files, close, or steps call. Use activate_tab before crossing into native accessibility/input_event when foreground state matters. Use set_files for a browser file input instead of native dialog choreography; uploaded files remain subject to Active Project path policy. If no safe matching tab exists, call new_tab and use its returned ID. Target order and the OS-active tab are never ownership signals. Never navigate through the browser address bar with computer_use/accessibility/input_event. Protected ChatGPT tab mutations additionally require allow_protected_tab_action=true plus explicit user confirmation. |
| 46 | `computer_use` | EXECUTE | default | operational | service_dispatch | Codex-style native computer use for testing desktop apps when the host provider and session permissions are available. Take annotated screenshots, inspect semantic controls, and operate by semantic target, numbered visual mark, or explicit coordinates. Routes through Accessibility first and uses guarded pointer/keyboard input only when needed. Supports click, typing, keys, hotkeys, scroll, drag, pointer movement, and window activation. For web navigation, do not focus/type into a browser address bar; use dom_cdp list_tabs/new_tab plus an explicit tab_id. |
| 47 | `accessibility` | READ | default | operational | service_dispatch | Semantic host-native UI tool. Inspect UI trees and named controls, then click, focus, read or set values, select controls and menus, or manage a native element when the platform provider and permission are available. Mutating calls may include postcondition {parameters, expected_value} to report whether a follow-up read_value observed the requested state. Prefer shell for direct system work and dom_cdp for web pages. |
| 48 | `input_event` | EXECUTE | default | operational | service_dispatch | Low-level keyboard and pointer fallback. Use only when DOM/CDP and host Accessibility cannot operate the target and the active desktop session grants input permission. Supports text, keys, mouse movement, clicks, drag, scroll, held buttons, release_all, and batched sequences. A mutating call may include postcondition {parameters, expected_value} to report whether a follow-up Accessibility read_value observed the target state. For web navigation, do not focus/type into a browser address bar; use dom_cdp list_tabs/new_tab plus an explicit tab_id. |
| 49 | `vision` | READ | default | operational | service_dispatch | Visual and OCR fallback for content unavailable through DOM or host Accessibility. Capture a display, window, or region, or run local Vision OCR when the host capture permission/dependency is ready. It never clicks or types. |
| 50 | `vision_annotated_capture` | READ | default | operational | service_dispatch | Capture a local host screen/region/window and return a short-lived Set-of-Marks observation with numbered bounds, a content hash, and an annotated PNG when the host capture provider is ready. This tool only observes; use ui_target_action for a separately gated action. |
| 51 | `ui_target_action` | EXECUTE | default | operational | service_dispatch | Act on one mark from a current vision_annotated_capture observation. The observation ID, optional hash, TTL, workspace owner, and current Accessibility element are checked before the action is sent. |
| 52 | `window` | EXECUTE | default | operational | service_dispatch | Direct host-native window management. List, inspect, activate, move, resize, minimize, maximize, restore, or close windows when the active session provider proves the operation is supported. |
| 53 | `health` | READ | default | operational | service_dispatch | Diagnostics only. Check all lnwjud backends or one public tool after a failure, when asked for status, or while diagnosing permissions. Do not use as a preflight before normal work. |
| 54 | `system_info` | READ | default | operational | service_dispatch | Read-only system information: OS, CPU, memory, disks, battery, uptime, and top processes by memory. Use for environment checks and diagnostics. |
| 55 | `notification` | EXECUTE | default | operational | service_dispatch | Show a host-native desktop notification when a notification session is available. Use to tell the user when a long task finishes. |
| 56 | `file_dialog` | EXECUTE | default | operational | service_dispatch | Open a host-native file open/save dialog and return the chosen path(s). The dialog does not read or write files itself; use the guarded file tools afterwards. |
| 57 | `clipboard` | EXECUTE | default | operational | service_dispatch | Read or write the host clipboard (text or PNG image as base64). Use get_text/get_image to read and set_text to write. |
| 58 | `web_fetch` | READ | default | operational | service_dispatch | Fetch an http/https URL (GET/POST/PUT/DELETE/HEAD) with bounded size and timeout. In standard mode every POST, PUT, or DELETE requires explicit chat confirmation and host approval; trusted Full Bypass skips lnwjud approval. dry_run remains safe. Returns status, headers, and text or base64 body. |
| 59 | `audio` | EXECUTE | default | operational | service_dispatch | Record the microphone to a WAV file or play a local audio file through the host media provider. In standard mode recording requires the host-selected Active Project workspaceId and explicit confirmation; trusted Full Bypass skips lnwjud approval/scope checks. Existing in-workspace outputs use Recovery Trash before replacement when available. record is synchronous and limited to 600 seconds. Use stop to abort an ongoing record/play. |
| 60 | `screen_record` | EXECUTE | default | operational | service_dispatch | Record the screen to an MP4 using the host-native media provider. In standard mode starting a recording requires the host-selected Active Project workspaceId and explicit confirmation; trusted Full Bypass skips lnwjud approval/scope checks. Existing in-workspace outputs use Recovery Trash before replacement when available. start spawns a background capture, status checks it, stop finalizes the file. Recording stops automatically after 3600 seconds. |
| 61 | `office` | WRITE | default | operational | service_dispatch | Automate a supported spreadsheet/document provider when installed. In standard mode every write, replace, merge, or save_as action requires an Active Project workspaceId, explicit chat confirmation, and host approval. Trusted Full Bypass skips lnwjud approval/scope checks without forging userConfirmed. Existing in-workspace targets use Recovery Trash before replacement when available. Unsupported app/action pairs are dependency-gated rather than approximated. |
| 62 | `scheduler` | EXECUTE | default | operational | service_dispatch | Manage host-native scheduled tasks. list is read-only; in standard mode create, run, and delete require explicit chat confirmation and host approval. Trusted Full Bypass skips lnwjud approval without forging userConfirmed. The provider uses the current OS scheduler and never silently falls back to another scheduler. |
| 63 | `wsl_exec` | EXECUTE | default | operational | service_dispatch | Non-blocking WSL2 developer runner for one Linux executable plus argv; shell command strings are not accepted. cwd accepts either an absolute Windows workspace path or an absolute WSL path such as /mnt/e/project returned by wsl_fs. Do not use wsl_exec as a source/config/text editor. For any direct text-file change, call edit_file first; use apply_patch for reviewed whole-file or multi-file replacements and write_file for file creation/replacement. Inline Node/Python/PowerShell-style rewrites and sed in-place edits are rejected before native approval so the client can route to guarded file tools. MCP run calls are ALWAYS forced to execution=background, even if a client requests foreground or auto, and return a task_id immediately. Follow with status/logs/result; wait uses the user-configurable MCP poll window (5-60 seconds, default 5). When the user requires babysitting until completion, keep using bounded waits and do not report completion until the terminal result is inspected. Otherwise, if the host turn must yield while a durable task is still running, checkpoint it as trackedTasks {taskId, provider: shell, role: blocking_job, cancelWithGoal: true} and use the active scheduled-continuation handoff instead of abandoning the goal. With Full Bypass OFF, Full Access runs ordinary WSL commands without confirmation while destructive, broad, recursive, outside-project, or unparseable forms retain normal approval/command policy. Trusted Full Bypass skips lnwjud approval, command-policy, Active Project, and allowed-root checks; an active rolling scheduled goal still requires the current goalLease ownership proof. Full Bypass may still use an explicitly requested external cwd; WSL availability, argv validation, Linux permissions, and process failures still apply. |
| 64 | `wsl_fs` | READ | default | operational | service_dispatch | Translate paths and inspect metadata between a registered Windows workspace and WSL without exposing raw \\wsl$ read/write access. |
| 65 | `skills_list` | READ | default | operational | service_dispatch | List the union of bundled skills and every discovered machine-global or active-workspace skill from Cursor, Claude, Agents, Codex, the Codex plugin cache, GitHub workspace roots, and lnwjud settings. Nested and symlinked skill collections are included. Filter with query or source. |
| 66 | `skills_read` | READ | default | operational | service_dispatch | Read a local skill SKILL.md (or a relative file inside the skill folder). Prefer the source-qualified id returned by skills_list; an unambiguous bare name or $name is also accepted. Pass workspaceId and the active goalId when loading a policy-required skill, then follow it with lnwjud tools and mcp_call. |
| 67 | `ponytail_session` | WRITE | default | operational | service_dispatch | Temporarily suppress or resume the effective Ponytail coding policy for this MCP session and workspace/goal only. This does not change persisted global, workspace, or durable-goal settings. Use suppressed=true when the user explicitly asks to stop Ponytail or return to normal mode; use false to resume the effective policy. |
| 68 | `mcp_list` | READ | default | operational | service_dispatch | List local MCP servers discovered from Cursor, Claude Desktop, and lnwjud settings. This inspection is read-only and does not flatten child tools into the lnwjud catalog. |
| 69 | `mcp_describe` | READ | default | operational | service_dispatch | Connect to one local MCP server (if needed) and return its tool names, descriptions, and input schemas. This operation only inspects the child tool catalog. |
| 70 | `mcp_call` | DANGEROUS | default | operational | service_dispatch | Call a tool on a discovered local MCP server. Child side effects and filesystem/network scope are controlled by that child server, so standard mode treats every mcp_call as opaque mutation and requires explicit chat plus host exact-action approval. Trusted Full Bypass skips lnwjud application approval; the child server still enforces its own policy. |
| 71 | `workspace_context` | READ | default | operational | service_dispatch | Aggregate ranked workspace context with snippets, symbols, Git/test relevance, economy metadata, and continuation; automatic discovery can be explicitly expanded. |
| 72 | `workspace_context_continue` | READ | default | operational | service_dispatch | Continue a workspace_context result without discarding unreturned candidates. |
| 73 | `workspace_full_scan` | READ | default | operational | service_dispatch | Enumerate workspace files with full access by default; set includeIgnored false to use the persistent automatic index. |
| 74 | `workspace_full_scan_continue` | READ | default | operational | deterministic_operation | Continue a workspace_full_scan result page. |
| 75 | `workspace_snapshot` | READ | default | operational | service_dispatch | Return workspace identity and project snapshot metadata without source contents. |
| 76 | `search_all` | READ | default | operational | service_dispatch | Search text and filenames across one or all registered workspaces with automatic economy filters or an explicit includeIgnored override. |
| 77 | `read_many_files` | READ | default | operational | service_dispatch | Read many workspace files in parallel while preserving one result or error per requested path. |
| 78 | `read_file_page` | READ | default | operational | service_dispatch | Preferred reader for large files after search_text identifies the relevant area. Reads a deterministic line chunk with explicit continuation instead of silently truncating or loading the whole file. |
| 79 | `read_file_page_continue` | READ | default | operational | service_dispatch | Continue read_file_page from the next deterministic line chunk only when more surrounding context is needed; avoid re-reading earlier pages. |
| 80 | `workspace_index` | READ | default | operational | service_dispatch | Build or refresh the persistent workspace index using automatic context filters unless ignored paths are explicitly included. |
| 81 | `workspace_index_status` | READ | default | operational | service_dispatch | Return persistent index metadata and lossless watcher queue telemetry. |
| 82 | `workspace_index_watch` | READ | default | operational | service_dispatch | Watch all workspace paths and incrementally re-index only changed paths with configurable debounce/concurrency. |
| 83 | `workspace_index_stop` | READ | default | operational | service_dispatch | Stop a workspace watcher after draining all queued path updates. |
| 84 | `session_handoff` | READ | default | operational | service_dispatch | Create concise recovery state after a client/page interruption or missing assistant summary without rerunning completed work. Prefer the active Durable Goal; when none exists, recover the latest terminal Durable Goal and its terminal receipt. Also inspect recent durable shell tasks with bounded status/output tails so a terminal result can be summarized immediately instead of relaunched. Then include Git/workspace state and an optional legacy phase tracker fallback. This is task state, not persistent user/agent instructions. It never opens, clicks, types into, or creates a ChatGPT browser conversation; resume must happen through supported host-native turns/chats. |
| 85 | `verify_incremental` | EXECUTE | default | operational | service_dispatch | Run the detected project typecheck only when the current git status/diff fingerprint changed. Starting a new verification process requires explicit user confirmation in standard mode; trusted Full Bypass skips that lnwjud gate. Returns cache=hit when unchanged and cache=miss after a new verification. Prefer this during iterative edits; use project_test/project_lint/project_build only when that specific verification is needed. For full suites or packaging expected to exceed ~5 minutes, launch a durable shell background task and record its task_id in the tracker. |
| 86 | `run_goal` | WRITE | default | operational | service_dispatch | Immediate-return durable goal create/resume and lease acquisition. Every invocation re-reads workspace AGENTS.md when present and returns it as projectInstructionsPreflight so repository rules are available before subsequent work; the preflight is never cached. Invoke run_goal before the first mutation of any non-trivial multi-step change. For an active rolling goal whose prior worker died, stale-lease recovery still requires trustworthy runtime liveness and rotates the lease generation. Unfinished goals default to scheduledContinuation=auto: the client must load/follow the bundled lnwjud-scheduled-continuation skill and maintain exactly one Native ChatGPT hourly recurring watchdog with cloud execution requested. New v4.53 goals reuse the same native task ID across ordinary hourly wakes; checkpoints and collisions never imply per-wake successor creation or recurrence retiming. Historical v4.52 occurrence=once rows are migrated compatibly and must not overlap a new recurring watchdog. Continue useful work without waiting for the user to type continue/ทำต่อ. The leased worker is work-conserving: a milestone checkpoint is not a turn boundary, a transient tool/task-observation failure is not a handoff signal, and a safely reacquirable lease expiry should be recovered with the same goalKey so useful work continues in the same host turn. A concrete fixable failure discovered during CI, tests, code scanning, packaging, release validation, or another tool is the next unit of work; diagnose, repair, and validate it in the same host turn while safe useful actions remain instead of stopping to report it. A truthful native create failure or Resource not found is scheduler transport degradation only: keep the durable goal active and continue the current leased worker rather than terminalizing the work, and never substitute another scheduler. Stop scheduling only when the goal is terminal or scheduling is explicitly disabled. Native ChatGPT task operations remain host-owned through the Scheduled Task surface exposed to the chat; this tool never claims that a task was created and never substitutes browser/DOM automation, Windows Task Scheduler, cron, or shell timers. |
| 87 | `get_goal` | READ | default | operational | service_dispatch | Read the latest durable goal snapshot without changing state or returning a lease token. |
| 88 | `get_goal_plan` | READ | default | operational | service_dispatch | Read the user-facing plan projection, acceptance criteria, intent revision, and bounded-iteration policy from authoritative durable goal state. This is a projection, not a second workflow engine. |
| 89 | `update_goal_plan` | WRITE | default | operational | service_dispatch | Atomically replace the user-facing durable goal plan through the current lease and revision fence. It only updates plan state; it does not execute plan steps by itself. |
| 90 | `update_goal_acceptance` | WRITE | default | operational | service_dispatch | Update explicit durable acceptance criteria with evidence. finish_goal(status=completed) remains blocked until every criterion is completed. |
| 91 | `revise_goal_intent` | WRITE | default | operational | service_dispatch | Record accepted newer user steering by incrementing userIntentRevision under the current lease. Older pending delivery receipts are retired so stale generated actions cannot outrank newer user instructions. |
| 92 | `create_context_capsule` | WRITE | default | operational | service_dispatch | Create and publish a bounded immutable context capsule from authoritative durable goal state for compact/resume or handoff. Stores decisions/results, not private chain-of-thought, and never opens, clicks, types into, or creates a ChatGPT browser conversation. |
| 93 | `get_context_capsule` | READ | default | operational | service_dispatch | Read one immutable durable context capsule by ID. |
| 94 | `list_context_capsules` | READ | default | operational | service_dispatch | List bounded context-capsule lineage for one durable goal. |
| 95 | `context_pressure` | READ | default | operational | service_dispatch | Estimate local durable-context pressure from the goal snapshot and latest capsule. This never claims exact ChatGPT/provider context usage when the host does not expose it. |
| 96 | `record_delivery_receipt` | WRITE | default | operational | service_dispatch | Record or advance a durable dispatch receipt with explicit ambiguous-delivery states. Blind retries are rejected by lifecycle/state and newer user intent can retire stale deliveries. |
| 97 | `list_delivery_receipts` | READ | default | operational | service_dispatch | List bounded durable dispatch receipts for a goal. |
| 98 | `advance_goal_iteration` | WRITE | default | operational | service_dispatch | Advance one bounded review/improvement iteration under the durable goal lease. It never sends browser messages or creates an autonomous ChatGPT UI loop and cannot exceed maxIterations. |
| 99 | `checkpoint_goal` | WRITE | default | operational | service_dispatch | Atomically checkpoint durable goal progress using the current lease and expected revision. For every meaningful milestone or handoff boundary, include resumeContext with the concrete state a new worker needs to reconstruct work without guessing: changedFiles, exact commands with pass/fail/running status and result, decisions, failedAttempts, pendingValidation, resumePrerequisites, stateFacts, and artifacts. summary is only a headline and must not replace reconstruction-grade resumeContext. Use trackedTasks for goal-relative blocking_job/supporting_service roles and explicit provider routing; activeTaskIds remains a legacy compatibility form. Supporting services do not block continuation liveness and are cancelled only when cancelWithGoal=true. A checkpoint records durable progress only; it is not a turn boundary or permission to yield, and it does not create a new Scheduled Task. After an ordinary checkpoint keep useful work moving on the current lease. A transient task/status/log/result observation failure must be retried or re-resolved in the same turn, and a tracked blocking job that becomes terminal must have its terminal result inspected before handoff. Before yielding an active automatic-continuation goal, ensure exactly one confirmed Native ChatGPT hourly recurring watchdog exists with cloud execution requested unless scheduling was explicitly disabled. Reuse the same nativeTaskId across checkpoints and ordinary hourly wakes; never create a per-wake successor and never retime the recurring cadence merely because a checkpoint changed. Historical v4.52 one-time rows keep their compatibility behavior until they become historical, and one-time plus recurring watchdogs must never overlap for one goal. A real native task ID is required for confirmed coverage, while execution mode may remain unverified when the host does not expose it. At an unavoidable turn boundary, persist full resumeContext before releasing the lease; if scheduling is enabled confirm watchdog coverage first. Never wait for the user to type continue/ทำต่อ. |
| 100 | `finish_goal` | WRITE | default | operational | service_dispatch | Finish the local durable goal using lease/revision compare-and-swap. It must be called before any completion report, even when scheduling was disabled or the user requested no watchdog. status=completed is rejected while durable plan work, blockers, or blocking tasks remain. After the terminal CAS, finish_goal aborts in-flight fenced MCP requests and attempts to stop every tracked task whose cancelWithGoal policy is true; inspect requestCancellation, taskCancellations, allRequestsStopped, and allTasksStopped for unresolved work. Preferred v4.54 completion cleans any live Native ChatGPT watchdog first: call cancel_scheduled_continuation while the goal is still active, make the exact task non-runnable using host delete or confirmed disable, record truthful cleanup evidence, then call finish_goal once. Explicit user-attested manual deletion is a separate evidence class and must never be represented as host-native proof. Defensive compatibility remains: if finish_goal returns status=active with completionState=pending_native_cleanup, recover the exact cleanup locator from get_goal/get_scheduled_continuation, perform cleanup only, record evidence, and call finish_goal again without resuming workspace work. A recurring hourly run never consumes the task and outcome=consumed is not cleanup proof. Report completion only after completionState=completed and get_goal is terminal with no pending scheduled-task cleanup. |
| 101 | `cancel_goal` | WRITE | default | operational | service_dispatch | Cancel a durable goal independently of any scheduled watchdog. It records the goal as cancelled, aborts in-flight fenced MCP requests for that goal, and attempts to stop only tracked tasks whose cancelWithGoal policy is true; shared supporting services remain running by default and are reported as taskCancellations status=skipped. An explicitly bound provider that is unavailable or cannot verify termination is reported as failed, so allTasksStopped remains false until the unresolved task is inspected. Inspect requestCancellation, taskCancellations, and allRequestsStopped/allTasksStopped for unresolved work. If scheduledTaskCancellation requests make_native_task_non_runnable, use cancel_scheduled_continuation separately, resolve the actual native ChatGPT cleanup operation exposed by the host, and record exact proof that the pending task is non-runnable. |
| 102 | `reconcile_goals` | WRITE | default | operational | service_dispatch | Preview or apply exact durable-goal reconciliation after runtime liveness checks. |
| 103 | `list_goals` | READ | default | operational | service_dispatch | List a bounded set of durable goals owned by the current stable MCP client, optionally filtered by workspace/status. |
| 104 | `resource_snapshot` | READ | default | operational | service_dispatch | Show sampled resources scoped to registered workspace/owned Goal. Unknown ownership and context metrics remain unknown; shared tasks are never cancellable. |
| 105 | `call_history` | READ | default | operational | service_dispatch | Read server-observed correlated MCP calls from bounded SQLite audit records. Values without measured transport spans remain null/unknown; supports filters and opaque keyset pagination. |
| 106 | `goal_result` | READ | default | operational | service_dispatch | Read evidence-limited Durable Goal results. Never attributes legacy operations without a server-verified Goal lease. |
| 107 | `workflow_templates` | READ | default | operational | service_dispatch | List six built-in Thai/English workflows for a registered workspace. Read-only; does not create a Goal. |
| 108 | `workflow_prepare` | READ | default | operational | service_dispatch | Validate bounded inputs, workspace paths, provider readiness, and return a deterministic preview. No side effects. |
| 109 | `workflow_start` | WRITE | default | operational | service_dispatch | Start or attach the selected validated workflow to an existing Durable Goal contract with hashed idempotency key. Never creates any scheduled task; caller must hold returned Goal lease to execute. |
| 110 | `prepare_scheduled_continuation` | WRITE | default | operational | service_dispatch | Checkpoint durable progress and ensure exactly one live current-chat Native ChatGPT hourly recurring watchdog with cloud execution requested. When the current chat exposes an exact @connector mention for lnwjud, pass it as connectorMention so the generated native Scheduled Task prompt remains bound to that connector; omit it only when the host exposes no mention. At a meaningful continuation handoff include reconstruction-grade resumeContext (changed files, exact commands/results, decisions, failed attempts, pending validation, resume prerequisites, state facts, artifacts); summary alone is not sufficient resume state. New v4.53 watchdogs use occurrence=interval and intervalMinutes=60; when successorDelayMinutes is omitted the first firing is one hour from prepare, while a legacy explicit 2–25 minute value changes only the first firing and never the hourly recurrence cadence. Reuse the same confirmed native task ID across checkpoints and ordinary wakes; never create a per-wake successor or retime the recurring cadence. If an active v4.52 one-time watchdog already exists, reuse that legacy task until it becomes historical before creating the recurring watchdog, so one-time and recurring native tasks never overlap for one goal. prepared means reservation only and is not confirmed host coverage. Record native create failure or uncertainty truthfully and reconcile uncertain host state before any blind create. On an explicit host-surface lookup/dispatch failure such as Resource not found that proves the operation was not dispatched, re-resolve the current Native Scheduled Task host operation once and retry that exact native operation once; never retry ambiguous possible-success and never switch scheduler providers. Host create and cleanup remain Native ChatGPT Scheduled Task operations exposed by the current chat; never use browser/DOM automation, Windows Task Scheduler, cron, shell timers, or an lnwjud-local scheduler as a substitute. |
| 111 | `record_scheduled_continuation_receipt` | WRITE | default | operational | service_dispatch | Record truthful cleanup/run receipts for recurring Native ChatGPT watchdogs and legacy one-time watchdogs. created requires the real native task ID and host-reported absolute dueAt. A recurring interval firing never consumes or replaces the native task, so outcome=consumed and reschedule_* remain legacy one-time compatibility only. For outcome=cancelled prefer matching native host evidence that the exact task is non-runnable: delete may report deleted/not_found and hosts without delete may report an exact disable receipt. If the host management surface is unavailable and the user explicitly deleted the exact task in ChatGPT Scheduled Tasks, userCancellationReceipt may record that separately as user-attested manual deletion only with userConfirmed=true; never label user testimony as host-native proof. The stored native task ID is immutable for the lifetime of the watchdog. |
| 112 | `claim_scheduled_continuation` | WRITE | default | operational | service_dispatch | Scheduled-wake entrypoint and the first lnwjud action before any workspace mutation. Native watchdogs should pass the expected goalId and workspaceId from their wake metadata so the host-visible WRITE scope is explicit and lnwjud can reject mismatched identity before liveness or lease mutation; legacy callers that only have continuationId remain compatible. For occurrence=interval, the same native hourly task remains scheduled across firings: a live/uncertain worker returns worker_busy_noop without lease theft or host-task mutation, a true concurrent/stale duplicate whose observation predates an already-recorded lease acquisition returns already_claimed, an existing interval runKey alone never suppresses a fresh current-liveness check, a safely available lease returns recurring_acquired, and a still-valid stale lease with trustworthy no-worker/no-blocking-work evidence is recovered in the same hourly tick after the bounded 60-second stale-heartbeat grace rather than waiting for expiry or a second hourly firing. Only recurring_acquired may include a read-only automationResume hint; busy/no-op claims never inspect or mutate automation state. After recurring_acquired, discovering a fixable CI, test, code-scanning, packaging, release, or tool failure is not permission to yield: continue diagnosis, repair, and relevant validation in the same host turn while safe useful actions remain, rather than ending the hourly wake with a status-only report. Ordinary recurring wakes never create a successor, never consume the native task, and never retime its cadence. terminal_noop performs no work; if terminal cleanup is pending, make the exact recurring native task non-runnable rather than resuming goal work. Historical occurrence=once rows retain the v4.52 acquired/successor_required/reschedule compatibility paths. Never count prepared as confirmed and never mutate the workspace without the acquired goal lease. |
| 113 | `get_scheduled_continuation` | READ | default | operational | service_dispatch | Read one scheduled-continuation snapshot by continuation ID or the latest record for a goal. In v4.53, occurrence=interval identifies the single hourly recurring watchdog; its dueAt is the first scheduled firing, not a mutation handoff deadline, and its native task ID remains stable across ordinary wakes. Historical occurrence=once rows preserve legacy one-time compatibility state. |
| 114 | `expedite_scheduled_continuation` | WRITE | default | operational | service_dispatch | Legacy one-time compatibility only. For a still-pending occurrence=once watchdog and an enumerated handoff-risk signal, adaptively move that exact native task closer using the existing v4.52 rules. occurrence=interval recurring watchdogs must not use expedite_scheduled_continuation because ordinary recurring cadence is fixed at one hour and the host contract exposes no truthful immediate-run operation. Never create a replacement task through this operation. |
| 115 | `cancel_scheduled_continuation` | WRITE | default | operational | service_dispatch | Cancel the scheduled watchdog independently of its durable goal. For v4.53 occurrence=interval, make the exact recurring Native ChatGPT task non-runnable with the strongest host operation actually exposed: prefer true delete, otherwise a host-confirmed disable. One recurring firing never consumes the task, so a past first due time is not cleanup proof. Historical occurrence=once rows retain their legacy cancellation/reconciliation behavior. Never treat a model assertion or unverified host state as cleanup proof. This does not cancel the durable goal or stop its running tasks. |
| 116 | `symbol_search` | READ | default | operational | service_dispatch | Search indexed symbols across the workspace. |
| 117 | `find_definition` | READ | default | operational | service_dispatch | Find deterministic symbol definitions. |
| 118 | `find_references` | READ | default | operational | service_dispatch | Find textual and indexed references to a symbol. |
| 119 | `find_implementations` | READ | default | operational | service_dispatch | Find interface and class implementations. |
| 120 | `call_hierarchy` | READ | default | operational | service_dispatch | Return a deterministic call hierarchy approximation. |
| 121 | `import_graph` | READ | default | operational | service_dispatch | Return indexed imports and exports for a module. |
| 122 | `dependency_graph` | READ | default | operational | service_dispatch | Return package and module dependency metadata. |
| 123 | `module_graph` | READ | default | operational | service_dispatch | Return the workspace module graph. |
| 124 | `type_search` | READ | default | operational | service_dispatch | Search indexed TypeScript, JavaScript, and Python types. |
| 125 | `trace_symbol` | READ | default | operational | service_dispatch | Combine definition, references, imports, tests, and recent context. |
| 126 | `context_ranking` | READ | default | operational | deterministic_operation | Explain ranking signals without removing lower-ranked context. |
| 127 | `debug_context` | READ | default | operational | service_dispatch | Gather deterministic debugging context and continuation metadata. |
| 128 | `review_context` | READ | default | operational | service_dispatch | Gather code-review context. |
| 129 | `change_context` | READ | default | operational | service_dispatch | Gather changed files, symbols, dependencies, and tests. |
| 130 | `symbol_context` | READ | default | operational | service_dispatch | Gather context around a symbol. |
| 131 | `test_context` | READ | default | operational | service_dispatch | Gather relevant test context. |
| 132 | `dependency_context` | READ | default | operational | service_dispatch | Gather dependency-related context. |
| 133 | `git_context` | READ | default | operational | service_dispatch | Gather Git status, diff, and history context. |
| 134 | `frontend_context` | READ | default | operational | service_dispatch | Gather frontend project context. |
| 135 | `backend_context` | READ | default | operational | service_dispatch | Gather backend project context. |
| 136 | `route_intent` | READ | default | operational | deterministic_operation | Classify a prompt with a deterministic, overridable route. |
| 137 | `recipe_list` | READ | default | operational | deterministic_operation | List built-in and user recipe names. |
| 138 | `recipe_describe` | READ | default | operational | deterministic_operation | Describe a recipe plan and permissions. |
| 139 | `recipe_run` | EXECUTE | default | operational | deterministic_operation | Preview or run a deterministic recipe plan. |
| 140 | `dry_run` | READ | default | operational | deterministic_operation | Return a no-side-effect execution preview. |
| 141 | `review_changes` | READ | default | operational | service_dispatch | Review current Git changes and affected context. |
| 142 | `changed_symbols` | READ | default | operational | service_dispatch | Find symbols in changed files. |
| 143 | `affected_modules` | READ | default | operational | service_dispatch | Find modules affected by current changes. |
| 144 | `git_history_context` | READ | default | operational | service_dispatch | Return relevant recent Git history. |
| 145 | `git_blame_context` | READ | default | operational | service_dispatch | Return line ownership context for a file. |
| 146 | `discover_tests` | READ | default | operational | service_dispatch | Discover project tests without imposing an execution limit. |
| 147 | `run_affected_tests` | EXECUTE | default | operational | service_dispatch | Plan or run tests affected by changed files. |
| 148 | `test_failures` | READ | default | operational | service_dispatch | Summarize recorded test failures. |
| 149 | `coverage_context` | READ | default | operational | service_dispatch | Return coverage context when project tooling provides it. |
| 150 | `test_history` | READ | default | operational | service_dispatch | Return recent test execution history. |
| 151 | `cache_stats` | READ | default | operational | deterministic_operation | Return shared cache hit/miss telemetry. |
| 152 | `cache_clear` | WRITE | default | operational | deterministic_operation | Clear safe local runtime caches. |
| 153 | `cache_invalidate` | WRITE | default | operational | deterministic_operation | Invalidate cache entries for a path or workspace. |
| 154 | `hook_list` | READ | default | operational | deterministic_operation | List registered lifecycle hooks. |
| 155 | `hook_register` | WRITE | default | operational | deterministic_operation | Register a deterministic lifecycle hook descriptor. |
| 156 | `hook_remove` | WRITE | default | operational | deterministic_operation | Remove a lifecycle hook descriptor. |
| 157 | `skill_match` | READ | default | operational | service_dispatch | Match relevant local skills without loading all skill text. |
| 158 | `skill_load` | READ | default | operational | service_dispatch | Load a selected local skill by identifier. |
| 159 | `plugin_install` | WRITE | default | operational | truthful_unavailable | Register a validated plugin descriptor in the locked shared runtime registry. This manages declared plugin state; it does not execute untrusted plugin code. |
| 160 | `plugin_list` | READ | default | operational | deterministic_operation | List plugin descriptors from the locked shared runtime registry. |
| 161 | `plugin_enable` | WRITE | default | operational | truthful_unavailable | Enable an installed plugin descriptor in persistent shared runtime state. |
| 162 | `plugin_disable` | WRITE | default | operational | truthful_unavailable | Disable an installed plugin descriptor in persistent shared runtime state. |
| 163 | `plugin_remove` | DANGEROUS | default | operational | truthful_unavailable | Remove an installed plugin descriptor from persistent shared runtime state. |
| 164 | `session_context` | READ | default | operational | deterministic_operation | Return persisted development-session context. |
| 165 | `session_checkpoint` | WRITE | default | operational | deterministic_operation | Persist a development-session checkpoint. |
| 166 | `session_resume` | READ | default | operational | deterministic_operation | Resume a persisted session context. |
| 167 | `session_history` | READ | default | operational | deterministic_operation | Return session checkpoints and decisions. |
| 168 | `response_mode` | READ | default | operational | deterministic_operation | Select compact, normal, verbose, or stream formatting. |
| 169 | `inspect_web_app` | READ | default | operational | service_dispatch | Combine DOM, console, network, URL, and screenshot metadata. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 170 | `debug_ui` | READ | default | operational | service_dispatch | Gather deterministic UI debugging context. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 171 | `capture_ui_state` | READ | default | operational | service_dispatch | Capture a structured UI state. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 172 | `form_context` | READ | default | operational | service_dispatch | Inspect form controls and values metadata. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 173 | `network_context` | READ | default | dependency_gated | truthful_unavailable | Summarize browser network context when a retained CDP network event stream is available. |
| 174 | `console_context` | READ | default | dependency_gated | truthful_unavailable | Summarize browser console context when a retained CDP Runtime/Log event stream is available. |
| 175 | `browser_debug_context` | READ | default | operational | service_dispatch | Combine browser diagnostics for one request. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 176 | `windows_environment` | READ | default | dependency_gated | service_dispatch | Inspect Windows environment metadata. |
| 177 | `service_context` | READ | default | operational | deterministic_operation | Inspect host service-manager metadata. |
| 178 | `process_context` | READ | default | operational | service_dispatch | Inspect host process-tree context. |
| 179 | `port_context` | READ | default | operational | deterministic_operation | Inspect local listening-port context. |
| 180 | `registry_context` | READ | default | dependency_gated | deterministic_operation | Inspect Windows registry context through the Windows capability boundary. |
| 181 | `event_log_context` | READ | default | operational | deterministic_operation | Inspect host-native event and log context. |
| 182 | `installed_runtime_context` | READ | default | operational | deterministic_operation | Inspect installed runtimes and package managers. |
| 183 | `path_context` | READ | default | operational | deterministic_operation | Resolve executable and PATH context. |
| 184 | `startup_context` | READ | default | operational | deterministic_operation | Inspect host startup configuration context. |
| 185 | `mcp_discover` | READ | default | operational | service_dispatch | Discover external MCP servers without flattening native tools. |
| 186 | `mcp_health` | READ | default | operational | service_dispatch | Return external MCP connection health. |
| 187 | `mcp_resources` | READ | default | dependency_gated | service_dispatch | List resources exposed by connected MCP servers when the child server supports resources/list. |
| 188 | `task_create` | EXECUTE | default | operational | service_dispatch | Create a durable background task through the local shell task runtime. When the task belongs to a durable goal, pass goalId (or the current goalLease envelope) so terminal goals reject stale task creation before launch. Pass executable plus arguments; command is only an executable alias, never a shell command line. Pass cwd, timeout_seconds, and workspaceId as needed. |
| 189 | `task_status` | READ | default | operational | service_dispatch | Read durable managed task state with bounded recent output by taskId; use task_result for the full captured result. |
| 190 | `task_cancel` | EXECUTE | default | operational | service_dispatch | Cancel a durable managed task by taskId using the same verified process-tree termination path as shell tasks. |
| 191 | `task_result` | READ | default | operational | service_dispatch | Read the current durable managed task result and captured output by taskId. |
| 192 | `task_list` | READ | default | operational | service_dispatch | List durable managed tasks owned by the current client/session/workspace. |
| 193 | `delegate` | EXECUTE | Codex opt-in | dependency_gated | service_dispatch | Delegate one bounded read-only task through the owned agent-swarm provider when configured. |
| 194 | `delegate_status` | READ | Codex opt-in | dependency_gated | service_dispatch | Read delegated agent state from the owned agent-swarm provider. |
| 195 | `delegate_cancel` | EXECUTE | Codex opt-in | dependency_gated | service_dispatch | Cancel an owned delegated agent task. |
| 196 | `delegate_result` | READ | Codex opt-in | dependency_gated | service_dispatch | Read an owned delegated agent result. |
| 197 | `parallel_delegate` | EXECUTE | Codex opt-in | dependency_gated | service_dispatch | Run up to four isolated read-only agent tasks through the owned swarm provider with explicit dependency/collision metadata. |
| 198 | `permission_check` | READ | default | operational | deterministic_operation | Evaluate an action class without limiting allowed context reads. |
| 199 | `permission_profile` | READ | default | operational | deterministic_operation | Return the active Permission v2 profile. |
| 200 | `live_logs_query` | READ | default | operational | truthful_unavailable | Query bounded structured MCP activity events with tool, workspace, phase, result, call/trace correlation filters. |
| 201 | `live_logs_status` | READ | default | operational | truthful_unavailable | Return the built-in MCP activity-log pipeline health and bounded source status. |
| 202 | `telemetry_dashboard` | READ | default | operational | deterministic_operation | Return measured MCP activity, latency, error, cache, and context-economy telemetry from the local runtime. |
| 203 | `context_economy_stats` | READ | default | operational | deterministic_operation | Return context discovery, deduplication, ledger, and token-efficiency telemetry. |
| 204 | `execution_plan` | READ | default | operational | deterministic_operation | Return the cheapest deterministic execution plan and reason. |
| 205 | `repo_map` | READ | default | operational | service_dispatch | Return a traversable repository structural map. |
| 206 | `context_expand` | READ | default | operational | service_dispatch | Return optional import, caller, type, test, and change references. |
| 207 | `recovery_status` | READ | default | operational | deterministic_operation | Return reconnect, retry, continuation, cache, and worker recovery state. |
| 208 | `tool_schema_list` | READ | default | operational | deterministic_operation | List versioned tool schema metadata. |
| 209 | `tool_schema_register` | WRITE | default | operational | deterministic_operation | Register a validated backward-compatible versioned tool schema descriptor in the local runtime registry. |
| 210 | `capabilities` | READ | default | operational | deterministic_operation | Discover capability categories without requiring every full schema. |
| 211 | `tool_search` | READ | default | operational | deterministic_operation | Search tools, tags, phases, and descriptions deterministically. |
| 212 | `tool_dynamic_filter` | READ | default | operational | deterministic_operation | Return a bounded ranked tool set using deterministic scoring with optional local rerank fallback. |
| 213 | `tool_describe` | READ | default | operational | deterministic_operation | Describe one tool contract on demand. |
| 214 | `tool_categories` | READ | default | operational | deterministic_operation | List tool categories and counts. |
| 215 | `tool_function_find` | READ | default | operational | deterministic_operation | Find the best local tool/function candidates for a prompt. |
| 216 | `tool_aliases` | READ | default | operational | deterministic_operation | List stable shorthand aliases and their primitive tool targets. |
| 217 | `mcp_hub` | READ | default | dependency_gated | service_dispatch | Describe the additive MCP hub boundary without flattening child tools or retaining credentials. |
| 218 | `dev_context` | READ | default | operational | service_dispatch | Run the unified deterministic development-context facade. |
| 219 | `recipe_catalog` | READ | default | operational | deterministic_operation | Return inspectable developer automation recipes. |
| 220 | `capture_screenshot` | READ | default | operational | service_dispatch | Capture screenshot metadata for visual validation. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 221 | `compare_screenshot` | READ | default | operational | deterministic_operation | Compare screenshot metadata or supplied artifacts. |
| 222 | `dom_snapshot` | READ | default | operational | service_dispatch | Return a structured DOM snapshot. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 223 | `layout_metadata` | READ | default | operational | service_dispatch | Return layout metadata for visual validation. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 224 | `visual_context` | READ | default | operational | service_dispatch | Combine screenshot, DOM, layout, console, and network references. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab. |
| 225 | `inspect_workbook` | READ | default | operational | service_dispatch | Inspect workbook sheets, used ranges, and a bounded sample through Excel COM. |
| 226 | `compare_workbook_layout` | READ | default | dependency_gated | service_dispatch | Compare two workbook sheet/layout samples through the local Excel/Office provider. |
| 227 | `render_excel_preview` | READ | default | dependency_gated | service_dispatch | Render a bounded structured Excel preview from sheet names and sampled cell values through the local Excel/Office provider. |
| 228 | `inspect_pdf` | READ | default | dependency_gated | truthful_unavailable | Inspect PDF page structure and text through the local PDF provider. |
| 229 | `compare_pdf_pages` | READ | default | dependency_gated | truthful_unavailable | Compare two PDFs by bounded page/text metadata through the local PDF provider. |
| 230 | `project_profile_get` | READ | default | operational | service_dispatch | Read the validated workspace project-intelligence profile. |
| 231 | `project_profile_set` | WRITE | default | operational | deterministic_operation | Persist validated workspace project-intelligence conventions through the guarded file boundary. |
| 232 | `handoff_context` | READ | default | operational | service_dispatch | Build a structured cross-agent handoff bundle from real workspace, Git, and context services. |
| 233 | `benchmark_run` | EXECUTE | default | dependency_gated | service_dispatch | Preview or start the detected managed benchmark project command and retain bounded run evidence. |
| 234 | `regression_report` | READ | default | operational | deterministic_operation | Return retained local benchmark run evidence and regression comparisons for the current runtime session. |
| 235 | `sandbox_exec` | EXECUTE | default | dependency_gated | truthful_unavailable | Run an artifact-based Windows Sandbox job with networking disabled and read-only mapped input. |
| 236 | `event_watch` | EXECUTE | default | dependency_gated | deterministic_operation | Watch an allowlisted user-mode ETW or Windows Event Log diagnostic stream. |
| 237 | `crash_trace` | READ | default | dependency_gated | deterministic_operation | Return bounded crash and service-diagnostic context from allowlisted user-mode sources. |
| 238 | `lsp_diagnostics` | READ | default | dependency_gated | truthful_unavailable | Read diagnostics from an owned language-server child process. |
| 239 | `lsp_rename` | WRITE | default | dependency_gated | truthful_unavailable | Create a cross-file LSP rename edit plan before any workspace write. |
| 240 | `debug_attach` | EXECUTE | default | dependency_gated | truthful_unavailable | Validate and register an owned loopback DAP endpoint for a workspace debug session; connection details remain session-scoped. |
| 241 | `debug_step` | EXECUTE | default | dependency_gated | truthful_unavailable | Perform a bounded DAP request against a registered owned loopback debug session. |
| 242 | `git_worktree_spawn` | WRITE | default | dependency_gated | deterministic_operation | Create a confined, ledger-owned Git worktree for isolated agent work with collision metadata. |
| 243 | `git_worktree_remove` | DANGEROUS | default | dependency_gated | deterministic_operation | Remove a ledger-owned Git worktree after dry-run and standard-mode confirmation; trusted Full Bypass skips lnwjud approval. |
| 244 | `db_inspect` | READ | default | dependency_gated | truthful_unavailable | Inspect a local database schema through a configured, read-only connection. |
| 245 | `db_query` | READ | default | dependency_gated | truthful_unavailable | Run a bounded read-only local SQLite SELECT, PRAGMA, or WITH...SELECT query. |
| 246 | `office_ppt` | WRITE | default | dependency_gated | service_dispatch | Read PowerPoint content or save a copy through the existing Office policy boundary. |
| 247 | `office_status` | READ | default | operational | service_dispatch | Report truthful Office provider, app, action, dependency, and policy readiness without exposing credentials. |
| 248 | `office_word` | WRITE | default | dependency_gated | service_dispatch | Read, create, edit, inspect, merge, convert, and validate Word documents through a verified Office provider. |
| 249 | `office_excel` | WRITE | default | dependency_gated | service_dispatch | Automate structured Excel workbook reads, edits, formulas, sheets, formatting, exports, and validation through a verified provider. |
| 250 | `office_powerpoint` | WRITE | default | dependency_gated | service_dispatch | Author, inspect, edit, export, and validate PowerPoint presentations through a verified provider. |
| 251 | `office_outlook` | WRITE | default | dependency_gated | service_dispatch | Read Outlook mail, create and update drafts, and perform guarded mailbox mutations through a verified provider. |
| 252 | `office_calendar` | WRITE | default | dependency_gated | service_dispatch | Read and manage Outlook/Microsoft 365 calendar events through a verified provider with guarded invite/cancel actions. |
| 253 | `office_contacts` | WRITE | default | dependency_gated | service_dispatch | Read and manage Outlook/Microsoft 365 contacts through a verified provider. |
| 254 | `office_tasks` | WRITE | default | dependency_gated | service_dispatch | Read and manage Outlook/Microsoft 365 tasks only when the configured provider exposes a compatible task API. |
| 255 | `office_onenote` | WRITE | default | dependency_gated | truthful_unavailable | Read and manage OneNote through Microsoft Graph when OAuth and required scopes are configured. |
| 256 | `office_onedrive` | WRITE | default | dependency_gated | truthful_unavailable | Manage OneDrive files through Microsoft Graph while respecting Active Project boundaries for local transfers. |
| 257 | `office_sharepoint` | WRITE | default | dependency_gated | truthful_unavailable | Read and manage bounded SharePoint sites, lists, drives, and files through Microsoft Graph. |
| 258 | `office_teams` | WRITE | default | dependency_gated | truthful_unavailable | Read and send guarded Microsoft Teams messages only through supported Microsoft Graph permissions. |
| 259 | `office_access` | WRITE | default | dependency_gated | service_dispatch | Automate Microsoft Access only when a verified local Access provider is installed. |
| 260 | `office_visio` | WRITE | default | dependency_gated | service_dispatch | Automate Microsoft Visio only when a verified local Visio provider is installed. |
| 261 | `office_project` | WRITE | default | dependency_gated | service_dispatch | Automate Microsoft Project only when a verified local Project provider is installed. |
| 262 | `office_publisher` | WRITE | default | dependency_gated | service_dispatch | Automate legacy Microsoft Publisher only when an installed automation provider is verified. |
| 263 | `office_convert` | WRITE | default | dependency_gated | deterministic_operation | Convert supported Office formats through a verified provider and verify the produced artifact before reporting success. |
| 264 | `office_batch` | WRITE | default | dependency_gated | deterministic_operation | Run a bounded ordered Office batch with per-step results, dry-run support, and fail-fast semantics; operations are not atomic across apps. |
| 265 | `pdf_extract_tables` | READ | default | dependency_gated | truthful_unavailable | Extract bounded PDF text and tables through a local document provider. |
| 266 | `docx_merge` | WRITE | default | dependency_gated | service_dispatch | Create a deterministic DOCX merge plan and write only after approval. |
| 267 | `self_heal_plan` | READ | default | operational | service_dispatch | Propose safe, deterministic, reversible recovery steps without applying mutations. |
| 268 | `self_heal_apply` | DANGEROUS | default | dependency_gated | service_dispatch | Apply a current reversible recovery plan without automatic destructive retries; standard mode requires confirmation and trusted Full Bypass skips lnwjud approval. |
| 269 | `skills_import` | WRITE | default | operational | service_dispatch | Import a validated local SKILL.md into the selected workspace skill catalog through guarded file read/write operations. |
| 270 | `ecc_status` | READ | default | operational | deterministic_operation | Report the pinned ECC provider, provenance, activation policy, and bundled security-scanner readiness. |
| 271 | `ecc_catalog` | READ | default | operational | deterministic_operation | Search the pinned ECC artifact catalog without eagerly loading artifact bodies. |
| 272 | `ecc_load` | READ | default | operational | truthful_unavailable | Load one selected bounded ECC text artifact by stable catalog ID. |
| 273 | `ecc_configure` | WRITE | default | operational | truthful_unavailable | Persist selective ECC activation settings without granting imported artifacts extra runtime authority. |
| 274 | `ecc_security_scan` | EXECUTE | default | dependency_gated | truthful_unavailable | Run the pinned bundled AgentShield scanner against ECC resources or a registered workspace with bounded JSON output. |
| 275 | `ecc_memory_save` | WRITE | default | operational | service_dispatch | Create one unreviewed ecc.memory.v1 document without overwriting existing memory. |
| 276 | `ecc_memory_search` | READ | default | operational | service_dispatch | Search active ECC Memory Vault entries with bounded local lexical retrieval. |
| 277 | `ecc_memory_read` | READ | default | operational | service_dispatch | Read one ECC Memory Vault entry by stable memory id after completeness checks. |
| 278 | `ecc_memory_doctor` | READ | default | operational | service_dispatch | Validate ECC Memory Vault documents, symlinks, duplicates, and schema health without rewriting them. |
| 279 | `tool_batch` | EXECUTE | default | operational | service_dispatch | Execute multiple MCP tools with parallel, dependency-aware, timeout, cancellation, and partial-result handling. |
| 280 | `automation_create` | WRITE | default | operational | service_dispatch | Create one owner- and workspace-scoped durable shell automation run beneath an existing leased Goal. The plan must be a bounded acyclic milestone graph with evidence-producing verification for every milestone. |
| 281 | `automation_status` | READ | default | operational | service_dispatch | Read one durable automation run owned by the current actor in the requested workspace. |
| 282 | `automation_events` | READ | default | operational | service_dispatch | Read a bounded page of durable automation events owned by the current actor in the requested workspace. |
| 283 | `automation_run` | EXECUTE | default | operational | service_dispatch | Advance one leased durable automation run to its next deterministic dispatch, observation, or verification boundary. Repeat with the returned current revision; this operation never creates a scheduler. |
| 284 | `automation_control` | DANGEROUS | default | operational | service_dispatch | Pause, resume, or cancel one leased durable automation run. Cancellation also applies the run cancellation policy to its root Goal. |
| 285 | `automation_finalize` | WRITE | default | operational | service_dispatch | Finalize a fully verified durable automation run and confirm its root Goal reached terminal completion. This fails closed while native scheduled-task cleanup is pending. |
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
| agent_swarm_run | EXECUTE | Lists or inspects owned Agent Swarm runs; starting or cancelling a bounded read-only swarm requires trusted host approval |

Typical flow: codex_run → inspect task status/logs → inspect git_diff → run checks.
Codex still operates as an opaque child agent; the workspace-write sandbox
narrows its mode but does not make its changes automatically recoverable.
To expose `agent_swarm_run`, enable Codex delegation in Settings and enable that
tool on the Tools page. Changes reach an active MCP connection immediately;
ChatGPT may need its connected app tools refreshed or rescanned.

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
for compatibility. It never scans or registers filesystem roots automatically and
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

The local HTTP MCP endpoint binds only to IPv4/IPv6 loopback (`127.0.0.1` and `::1` when available), never a wildcard interface. Stdio is a child-process transport. Secure MCP Tunnel is an outbound HTTPS bridge, not an inbound public listener.

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
| Direct local stdio launcher is missing | This affects local stdio hosts such as Codex CLI, not Secure Tunnel. Reinstall the current package and confirm the target-native `lnwjud-mcp-stdio` launcher is shipped beside the packaged Electron executable. |
| profile_load says the YAML file is missing | Run init with profile lnwjud and verify %APPDATA%/tunnel-client/lnwjud.yaml |
| doctor rejects the key | Use a runtime key with Tunnels Read + Use; do not substitute an Admin or unrelated project key |
| Tunnel is not listed in ChatGPT | Associate it with the target ChatGPT workspace and verify Tunnels Read + Use |
| ChatGPT reports no tools | Check that lnwjud Desktop is running, the profile `server_urls` points to its loopback `/mcp` endpoint, doctor/tunnel health passes, then Refresh connector. |
| Tunnel doctor cannot reach local MCP | Keep lnwjud Desktop running and use Configure Tunnel again so the profile receives the current loopback `/mcp` endpoint. |
| ChatGPT shows 424 or “Access token is missing” while creating a no-auth Tunnel connection | Install v5.6.4 or later, open lnwjud, and check that the existing Tunnel is running. On Windows, lnwjud retires an older duplicate only when it verifies the same profile and Tunnel ID. If it cannot verify the old process, restart Windows, reopen lnwjud, then retry or refresh the ChatGPT connection. Do not switch to OAuth to solve a stale local destination. |
| WORKSPACE_NOT_FOUND | Use the exact registered workspace ID, not a path or display name |
| PATH_OUTSIDE_WORKSPACE | Register/select the correct root and use a workspace-relative path |
| A secret file is denied | Check the active read/Strict Roots policy and that the intended root is registered; do not weaken mutation scope to make a read succeed |
| process_start refuses PowerShell/CMD or an interpreter-style command | Use a policy-supported executable + argv inside the Active Project; free-form inline command strings and prohibited destructive forms fail closed |
| Child process windows are visible | This is expected for the current visible-window Windows build; use handles/logs to manage them |
| codex_status is unavailable | Install Codex or continue with process_* and project_*; lnwjud does not inspect credentials |
| Tunnel disconnects with context canceled / context deadline exceeded | MCP connection TTL teardown; start-lnwjud-tunnel.ps1 restarts even on exit 0. After restart, Refresh the connector or send a new ChatGPT message |
| ChatGPT advertises old tools | Verify lnwjud/tunnel health, then Refresh the connector. If a new conversation sees the refreshed tools but the old conversation returns `FORBIDDEN: This conversation does not support developer MCPs`, that refusal is ChatGPT conversation-level developer-MCP binding state; lnwjud cannot grant or bypass it. Continue in a new conversation rather than repeatedly restarting a healthy local tunnel. |
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

Use `git diff --check` before committing. For publishing, follow the canonical [release process](docs/development/RELEASE_PROCESS.md): the exact commit on `main` runs the Windows and target-native macOS/Linux gates, creates SHA-scoped artifacts for every release target, and the tag-triggered Release workflow reuses those artifacts without rebuilding.

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
