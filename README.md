<p align="center">
  <img src="assets/logo/logo-256x256.png" width="160" alt="lnwjud logo" />
</p>

<h1 align="center">lnwjud</h1>

<p align="center">
  <strong>Windows-first local AI-agent runtime and MCP gateway</strong><br />
  <em>223 configurable tools for local files, Git, processes, Windows automation, WSL, browser control, durable goal continuation, indexing, observability, and extensibility; 217 are advertised by default because codex_* delegation is opt-in.</em>
</p>

<p align="center">
  <a href="https://github.com/engasnm111/lnwjud/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/engasnm111/lnwjud" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20x64-0078D4" />
  <img alt="Node" src="https://img.shields.io/badge/Node.js-24.x-339933" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-223%20tools-6f42c1" />
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

## Current version: v4.12.0

The v4.12.0 release target and runtime contract contain **223 configurable MCP tools**,
with **217 advertised by default** because
the six `codex_*` delegation tools are opt-in. The earlier 184-tool snapshot remains
only as the compatibility baseline used by the v4 architecture; new v4 gateway
capabilities are additive.

### What's new in v4.12.0

- Adds a bilingual **Guided Local Tunnel Setup** for first-time users. A pristine install shows a Tips dialog and can route directly to **Settings > Secure Tunnel** without requiring Terminal commands or manual config-file editing.
- Adds a five-step Secure Tunnel guide for creating/pasting the Tunnel ID, securely saving the Runtime API key through the existing Windows DPAPI path, configuring the bundled `tunnel-client` profile, starting the tunnel, and opening ChatGPT Plugins for the final user-controlled connection step.
- Adds strict allowlisted external setup links. Renderer code sends only one of three fixed targets; the main process resolves those targets to the official OpenAI Tunnel Settings, OpenAI API Keys, or ChatGPT Plugins HTTPS pages and rejects arbitrary URLs.
- Adds resume/recovery behavior based on real tunnel status. Existing configured users are not interrupted, dismissed users can reopen the guide from Home or Settings, and in-progress setup resumes at the first step still required by the local key/profile/runtime state.
- Keeps secrets local: onboarding storage contains only a finite UI state, Runtime API key drafts are cleared after a successful save or guide close, and status/summary UI uses only masked Tunnel IDs.
- Adds focused unit/IPC/renderer coverage plus a real isolated Electron E2E smoke for first-run Tips, Secure Tunnel navigation, language switching, and the Set up later/reopen flow.

### Fork additions carried on top of v4.12.0

- Adds first-class project lifecycle management in the Desktop Projects page: active projects can be archived, archived projects can be restored, and project registrations can be removed with a two-step confirmation.
- Treats archived workspaces as inactive trust-boundary entries: they remain in SQLite for management/history labels but are excluded from normal runtime/MCP workspace lookup until restored.
- Makes project removal registration-only. Removing a project from lnwjud does **not** delete its directory, files, Git repository, audit history, or checkpoints; system/machine-root workspaces are protected from archive/remove actions.
- Repairs selected-workspace state after archive/removal, stops the workspace index watcher, blocks lifecycle changes while tracked Desktop work is active, and restores an archived registration instead of creating a duplicate when the same path is added again.
- Adds native macOS support across runtime paths (Darwin data/home directories, machine-root resolution, process/LSP/document/sandbox runtimes, window/tunnel lifetime handling, application menu), plus signed-off packaging via `pnpm package:macos` (DMG + ZIP for x64/arm64) and an MCP stdio shell launcher for macOS bundles.
- Makes macOS a first-class desktop target: the platform compatibility profile and Doctor OS check pass on Darwin arm64/x64, packaged Mac bundles ship a pinned universal ripgrep 15.2.0 runtime (SHA-256-verified, `lipo`-merged), and CI runs a dedicated macOS verification lane (typecheck + lint + full unit suite + integration).

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
- Skills discovery plus child MCP discovery/description/call contracts.
- Compound and parallel workflows, deterministic semantic tool routing, and
  Context Economy telemetry.
- Trace-correlated activity, NDJSON/SQLite audit metadata, Work Log, Live Logs,
  Doctor checks, health surfaces, and background tray operation.
- OpenAI Secure MCP Tunnel management with Windows DPAPI-encrypted runtime-key
  storage and reconnect handling.

Authoritative in-repository references:

- [Tool contract](docs/architecture/TOOL_CONTRACT.md) — core primitive schemas,
  policy classes, and compatibility rules; the 223-tool configurable index below comes from the live runtime registry.
- [Upgrade architecture](docs/architecture/UPGRADE_ARCHITECTURE.md) — v4 runtime
  architecture and additive gateway design.
- [Roadmap phase status](docs/architecture/ROADMAP_PHASE_STATUS.md) — completed
  implementation phases.

## Security model you should understand before using it

lnwjud is intentionally powerful. It is intended for a machine and workspace you
trust, not as a sandbox for unknown code.

- **Unrestricted mode is enabled by default for read/discovery compatibility.** Fixed local drives can be registered as machine roots and inspected by the local-agent runtime. Unrestricted mode does not widen the host-selected Active Project mutation boundary, bypass command policy, or bypass trusted host approval.
- Desktop MCP applies the selected permission profile (`safe`, `balanced`,
  `full`, or `custom`) to tool calls.
- The packaged standalone/headless STDIO runtime supports selectable `safe`,
  `balanced`, `full`, or `custom` profiles. For backward compatibility the
  default remains **full** with the existing machine-root behavior until Strict
  Roots is enabled. Secure Tunnel does not use this headless profile; it uses the
  running Desktop MCP permission profile and the Desktop-selected Active Project.
- **Strict Roots** is opt-in and limits standalone/headless STDIO workspace
  visibility to explicitly allowed roots. It is a filesystem/capability boundary,
  not an operating-system sandbox. Secure Tunnel remains constrained by the
  Desktop Active Project mutation boundary and native exact-action approval.
- Explicit file reads can include sensitive files such as `.env` when the active
  policy permits them. Do not register or expose a machine to an AI client you
  do not trust.
- Destructive and opaque operations are centrally classified. Approval-required mutations need explicit chat confirmation and an independent trusted host exact-action approval before backend dispatch. The Desktop native dialog is cancel-first; standalone/headless runtimes without a trusted host approval provider fail closed instead of silently approving.
- The exact `delete_file` operation is the only mutation eligible for scoped auto-approval, and only after the target is proven recoverable inside the Active Project. Protected critical paths, workspace roots, non-empty directories, unsafe/broad patterns, outside paths, and reparse/junction escapes are never auto-approved.
- Recovery Center derives and displays the local Recovery Trash path from the configured Desktop data root (`<dataRoot>/recovery-trash`). Replacement backups and supported deletes are recorded there or in encrypted checkpoints before the authoritative mutation where the operation is recoverable.
- Arbitrary approved commands, package scripts, project-owned scripts, Codex instructions, child MCP calls, and remote mutations are opaque execution. They are not an operating-system sandbox and are not automatically recoverable through Recovery Trash.
- Disk formatting and machine shutdown/reboot remain hard-blocked by the
  capability policy.
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
| ChatGPT web developer-mode app | OpenAI Secure MCP Tunnel | `tunnel-client` + lnwjud Desktop | Private outbound-only path to the Desktop loopback HTTP MCP; no public MCP port |
| Codex CLI or another local MCP host | Local stdio MCP | `lnwjud-mcp-stdio.cmd` | Lowest-overhead local MCP path |
| Local MCP client / dashboard diagnostics | Loopback Streamable HTTP | lnwjud Desktop | Defaults to `http://127.0.0.1:18765/mcp`; actual URL is shown in the UI |
| Supported OpenAI API/Codex surface | Secure MCP Tunnel | `tunnel-client` + local MCP target | Tunnel association and Platform permissions apply |

The desktop HTTP server starts automatically after lnwjud resolves a workspace.
If the preferred port `18765` is busy, the server can fall back to an ephemeral
loopback port; always use the endpoint shown in the dashboard. The **Start
Connection** button is useful after a manual stop, while **Stop Connection**
stops the current local HTTP listener.

## Quick start: install the Windows release

### 1. Install lnwjud Desktop

1. Download the latest published installer from
   [GitHub Releases](https://github.com/engasnm111/lnwjud/releases/latest).
   Current Windows 10/11 x64 artifacts are `lnwjud-Setup-4.12.0.exe` (recommended installer) and `lnwjud-Portable-4.12.0.exe` (no installation required).
2. Run the NSIS installer and launch **lnwjud Agent Control Center**.
3. Add or select the project/workspace you want lnwjud to operate on.
4. Review **Settings** before attaching an AI client, especially Permission
   Profile and Unrestricted Mode.

If you prefer not to install the app, run `lnwjud-Portable-4.11.0.exe` directly.
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

### 2. Prepare OpenAI Secure MCP Tunnel for ChatGPT web

OpenAI's Secure MCP Tunnel flow requires a Platform tunnel ID and a runtime
API key. The published Windows x64 installer and portable executable already contain the official
OpenAI `tunnel-client v0.0.12`, so release users do **not** download or
extract a separate tunnel-client package. Creating or editing a tunnel requires
**Tunnels Read + Manage**; the runtime key needs **Tunnels Read + Use**.

1. Open [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
2. Create a tunnel named `lnwjud` and associate it with the Platform organization
   that owns it and the ChatGPT workspace that should use it.
3. Create a restricted runtime API key with **Tunnels Read + Use**.
4. Open **lnwjud → Settings → OpenAI Secure MCP Tunnel**. Save the runtime API
   key, leave the **tunnel-client (bundled)** override field empty, paste the
   tunnel ID, and click **Configure Tunnel**.
5. The Setup Wizard selects the bundled client automatically, starts or reuses
   lnwjud's **Desktop loopback HTTP MCP**, creates or repairs
   `%APPDATA%/tunnel-client/lnwjud.yaml`, and runs the required tunnel diagnostics.
   Secure Tunnel does not spawn a separate headless lnwjud MCP runtime, so the
   Desktop-selected Active Projects and native exact-action approval remain
   authoritative for remote ChatGPT calls.

The tunnel-client path field is an **override/troubleshooting** control only.
Clear it and choose **Use bundled** to return to the package-supplied client.
Source builds may prepare the pinned client during `package:windows`; that build
step is not an end-user installation step.

If you intentionally need to initialize the profile by hand, keep lnwjud running
and copy the **Local MCP endpoint** shown by lnwjud (it is loopback-only and ends
in `/mcp`):

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

### 3. Save tunnel settings in the desktop UI

In **Settings → OpenAI Secure MCP Tunnel**:

1. Save the runtime API key. lnwjud encrypts it locally with Windows DPAPI. The
   generated tunnel profile stores only the reference `env:CONTROL_PLANE_API_KEY`,
   never the literal runtime key.
2. Leave the tunnel-client override field empty to use the official
   `tunnel-client v0.0.12` bundled with the Windows x64 installer. Browse/save a
   custom executable only when intentionally overriding it for troubleshooting.
3. Paste the OpenAI tunnel ID and click **Configure Tunnel**. The wizard replaces
   or repairs the lnwjud-owned profile so `mcp.server_urls` points to the Desktop
   loopback MCP endpoint and `control_plane.api_key` is the environment reference.
4. After Configure Tunnel succeeds, confirm
   `%APPDATA%/tunnel-client/lnwjud.yaml` exists and click **Start Tunnel**.
5. Open **Live Logs** or run **Doctor** if the tunnel fails to start.

The desktop tunnel controller repairs stale stdio profiles into Desktop HTTP
profiles before Doctor/Start, runs `tunnel-client doctor` before launch, starts
the client with a seven-day MCP connection ceiling, detects externally started
lnwjud tunnel processes, and performs bounded reconnect attempts after unexpected
exits. If an older profile contains `commands:`, a build-machine path such as
`D:/lnwjud/lnwjud-mcp-stdio.cmd`, or a literal `control_plane.api_key`,
Configure Tunnel/Start Tunnel repairs it to the current Desktop loopback `/mcp`
endpoint and the `env:CONTROL_PLANE_API_KEY` secret reference before Doctor/Run.

### 4. Add lnwjud to ChatGPT

For current ChatGPT developer-mode MCP testing, use the official
[Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
guide as the UI source of truth because workspace policy and labels can change.
The stable flow is:

1. Enable Developer mode for the target ChatGPT account/workspace if your plan
   and workspace policy allow it.
2. Open [ChatGPT Plugins](https://chatgpt.com/plugins) and select the plus button.
3. Enter a name/description, choose **Tunnel** under Connection, and select the
   associated `lnwjud` tunnel or enter its `tunnel_id`.
4. Create the connection and review the discovered tools and metadata.
5. Confirm that the default runtime exposes **217 tools** (or **223** when Codex delegation is explicitly enabled) and run a read-only
   smoke test before trying writes.

Example smoke test:

```text
Use lnwjud to list registered workspaces, report Git status for the selected project, and summarize the top-level project tree. Do not modify anything.
```

## Quick start: install the Windows release (ภาษาไทย)

ส่วนนี้สำหรับผู้ใช้ Windows ที่ต้องการติดตั้ง lnwjud แล้วเชื่อมกับ ChatGPT ผ่าน
OpenAI Secure MCP Tunnel แบบง่ายที่สุด โดย **ไม่ต้องติดตั้ง Node.js เพิ่ม**
Secure Tunnel จะส่งงานเข้าที่ Desktop loopback HTTP MCP ของ lnwjud โดยตรง
ส่วน private Node runtime ที่มากับตัวติดตั้งยังคงใช้สำหรับ local stdio เช่น Codex CLI

### 1. ติดตั้ง lnwjud หรือใช้ Portable

1. แบบแนะนำ: ดาวน์โหลด `lnwjud-Setup-4.11.0.exe` แล้วติดตั้งตามปกติ
2. ถ้าไม่ต้องการติดตั้ง: ดาวน์โหลด `lnwjud-Portable-4.11.0.exe` แล้วเปิดได้ทันที
3. เปิด **lnwjud Agent Control Center**
4. เพิ่มหรือเลือก Project/Workspace ที่ต้องการให้ ChatGPT ทำงานด้วย

Portable ใช้ Settings/ข้อมูลต่อผู้ใช้ Windows ชุดเดียวกับตัวติดตั้ง ไม่ได้เก็บ database/settings ทุกอย่างไว้ข้าง EXE

### 2. สร้าง OpenAI Tunnel และ Runtime API key

1. เข้า [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
2. สร้าง Tunnel ใหม่และจดค่า `tunnel_id` ไว้
3. สร้าง Runtime API key ที่มีสิทธิ์ **Tunnels Read + Use**
4. เก็บ key ไว้เป็นความลับ ห้ามใส่ใน Git, README, issue หรือไฟล์ที่จะแชร์

### 3. tunnel-client มากับตัวติดตั้งแล้ว

ถ้าใช้ `lnwjud-Setup-4.11.0.exe` หรือ `lnwjud-Portable-4.11.0.exe` บน Windows x64 **ไม่ต้องดาวน์โหลด
`tunnel-client.exe` เอง** ตัว release รวม official OpenAI
`tunnel-client v0.0.12` มาให้และ lnwjud จะเลือกใช้ให้อัตโนมัติ

ช่อง path ของ tunnel-client ใน Settings เป็น **override สำหรับ troubleshoot**
เท่านั้น ปล่อยว่างไว้สำหรับการใช้งานปกติ หากเคย override แล้วต้องการกลับมาใช้
ตัวที่มากับโปรแกรม ให้ล้างช่องแล้วกด **ใช้ตัวที่มากับโปรแกรม / Use bundled**

### 4. ตั้งค่า Tunnel ใน lnwjud

เปิด **Settings → OpenAI Secure MCP Tunnel** แล้วทำตามลำดับนี้:

1. ใส่ Runtime API key แล้วกด **Save key**
2. ปล่อยช่อง tunnel-client override ว่างไว้
   โปรแกรมจะใช้ `tunnel-client v0.0.12` ที่มากับ installer อัตโนมัติ
3. ใส่ OpenAI Tunnel ID
4. กด **Configure Tunnel**
5. รอให้ Configure/Doctor ผ่าน
6. กด **Start Tunnel** หรือ **Reconnect Tunnel เดิม** ตามสถานะที่แสดง
   ใช้ **Browse...** เฉพาะกรณีต้องการ override executable เพื่อ troubleshooting

ตรงนี้ **ไม่ต้องพิมพ์ path ของ `lnwjud-mcp-stdio.cmd` เอง** โปรแกรมจะ
เปิด/ใช้ Local MCP ของ Desktop แล้วสร้างหรือซ่อม
`%APPDATA%\tunnel-client\lnwjud.yaml` ให้ `mcp.server_urls` ชี้ไปที่
`http://127.0.0.1:<port>/mcp` อัตโนมัติ และบังคับให้
`control_plane.api_key` เป็น `env:CONTROL_PLANE_API_KEY` แทนการเก็บ key จริงใน YAML

ถ้าเคยใช้รุ่นเก่าแล้ว YAML ค้าง `commands:`, path เช่น
`D:/lnwjud/lnwjud-mcp-stdio.cmd` / `E:/lnwjud/lnwjud-mcp-stdio.cmd` หรือมี
Runtime API key จริงอยู่ใน `control_plane.api_key` ให้กด **Configure Tunnel**
ใหม่ โปรแกรมจะเปลี่ยน profile เป็น Desktop HTTP และ secret reference ให้เอง

### 5. เชื่อม Tunnel เข้ากับ ChatGPT

1. เปิด Developer mode ของ ChatGPT ถ้าบัญชี/Workspace รองรับ
2. เปิดหน้า Plugins/Connections ของ ChatGPT แล้วกดเพิ่ม connection
3. เลือก Connection แบบ **Tunnel**
4. เลือก tunnel ที่สร้างไว้ หรือใส่ `tunnel_id`
5. สร้าง connection แล้วตรวจว่าเห็น tools ของ lnwjud
6. ถ้าเพิ่งแก้ Tunnel หรืออัปเดต lnwjud ให้กด Refresh connector ก่อน ถ้ายัง stale
   ค่อยเปิดแชทใหม่

### 6. ทดสอบแบบ Read-only ก่อน

ลองสั่ง ChatGPT ก่อนด้วยงานที่ไม่แก้ไฟล์ เช่น:

```text
Use lnwjud to list registered workspaces, show Git status for the selected project, and summarize the top-level project tree. Do not modify anything.
```

ถ้าคำสั่งนี้ทำงานได้ แปลว่า ChatGPT → OpenAI Tunnel → tunnel-client →
lnwjud Desktop HTTP MCP เชื่อมต่อครบแล้ว จากนั้นจึงค่อยลองงานเขียนไฟล์หรือ
คำสั่งที่ต้องมี native approval ใน Desktop

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

### STDIO permission profiles and strict roots

The packaged stdio launcher keeps the historical behavior by default: the permission profile is `full` and machine-drive roots are registered as before. You can opt into a narrower policy per launch:

```text
lnwjud-mcp-stdio.cmd --workspace D:\\projects\\my-app --profile safe --strict-roots --allowed-root D:\\projects\\my-app
```

Supported direct-stdio profiles are `safe`, `balanced`, `full`, and `custom`. Equivalent environment variables are `LNWJUD_STDIO_PROFILE`, `LNWJUD_STRICT_ROOTS`, and semicolon-separated `LNWJUD_ALLOWED_ROOTS`. OpenAI Secure MCP Tunnel does not use the headless stdio policy; it uses the running Desktop MCP permission profile, Active Project, and native host approval. In strict-root mode lnwjud skips automatic whole-drive registration and exposes only explicitly allowed canonical roots; absolute paths outside those roots fail closed. Existing realpath/reparse-point and secret-policy checks still apply. Strict roots are a filesystem/capability boundary, not an OS sandbox: spawned programs still run under the Windows user token.

The **AI Destructive Actions** setting is now deliberately narrow. Only the exact `delete_file` operation can be scoped auto-approved, and only when its saved policy is enabled, the target matches the host-selected Active Project, Recovery Trash is available, and the target is not a protected critical path, workspace root, non-empty directory, unsafe/broad pattern, outside path, or reparse escape. Git deletion/discard, shell/WSL deletion, process/project/Codex execution, child MCP calls, Office/native mutations, and remote mutations are never toggle-auto-approved. Approval-required actions need explicit chat confirmation plus independent trusted host exact-action approval; the Desktop dialog is cancel-first, while standalone/headless runtimes without a trusted provider fail closed. Recovery Center derives and displays the local Recovery Trash path from the configured data root (`<dataRoot>/recovery-trash`). Approved arbitrary commands/scripts remain opaque execution rather than an OS sandbox and are not automatically recoverable through Recovery Trash.

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
apps/desktop/dist/installers/lnwjud-Setup-4.12.0.exe
apps/desktop/dist/installers/lnwjud-Portable-4.12.0.exe
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
read/discovery visibility when Strict Roots is not enabled (every fixed drive is
a machine root), but it never broadens the host Active Project mutation boundary.
The exact recoverable `delete_file` is the only mutation that can use scoped
auto-approval. Destructive Git forms that would rewrite/discard/delete state are
blocked when policy cannot prove a safe supported mutation; any allowed opaque
mutation still requires explicit chat confirmation and independent host
exact-action approval. Disk format, shutdown, and reboot stay hard-blocked.

### Optional local capability roots

The local desktop capability layer can receive additional roots through the
semicolon-separated environment variable LNWJUD_CAPABILITY_ROOTS:

```powershell
$env:LNWJUD_CAPABILITY_ROOTS = 'E:/work;E:/projects'
```

In the default unrestricted mode, all fixed-drive roots are available to local
capability read/discovery tools. `LNWJUD_CAPABILITY_ROOTS` is optional extra
configuration; it is not a visibility ignore list. Core file tools still require
a registered workspace, and mutation-capable tools still require the exact
Active Project and normal confirmation/host-approval boundaries.

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
`tunnel-client v0.0.12`, so normal installed-release setup requires no separate
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

lnwjud does not expose an OAuth login endpoint. Do not invent OAuth URLs or
paste the runtime key into the ChatGPT connector form. Tunnel authentication is
handled by tunnel-client; ChatGPT selects the OpenAI-hosted tunnel. Choose a
no-extra-auth option only when the tunnel form offers it.

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
## Complete MCP tool catalog (223 configurable tools; 217 advertised by default)

This index is generated from the current `ToolRegistry`, not copied from an older release document. Optional/planned tools still appear in the advertised contract and report their availability/requirements at runtime where applicable.

| # | Tool | Permission | Runtime description |
| ---: | --- | --- | --- |
| 1 | `workspace_list` | READ | List all registered workspaces/drive roots available to lnwjud. Call this first to discover workspace IDs. Entries include kind=machine_root\|project. |
| 2 | `workspace_register` | WRITE | Register an existing project directory under a machine-root drive. parentWorkspaceId must be a machine root from workspace_list. Idempotent for the same path. |
| 3 | `workspace_info` | READ | Return the configured workspace summary. |
| 4 | `workspace_tree` | READ | List a bounded workspace tree. Absolute path does not require workspaceId. |
| 5 | `project_snapshot` | READ | Return a bounded project snapshot without source contents. |
| 6 | `read_file` | READ | Read a workspace file as UTF-8 text or as an image/binary payload. Absolute paths (C:\...) do not require workspaceId. For large files or an unknown location, prefer search_text first and then read_file_page for the relevant range instead of reading the whole file. |
| 7 | `read_files` | READ | Read up to twenty bounded workspace files in parallel. Absolute paths do not require workspaceId. For large files, locate text with search_text and page with read_file_page instead of loading entire files. |
| 8 | `search_files` | READ | Search workspace filenames with automatic context-economy filters; set includeIgnored for an explicit full path search. Absolute path does not require workspaceId. |
| 9 | `search_text` | READ | Preferred tool to locate relevant code/lines before reading files. Searches workspace text using direct ripgrep arguments with automatic binary/generated filters; set includeIgnored for an explicit full path search. Absolute path does not require workspaceId. Follow with read_file_page for large files. |
| 10 | `git_status` | READ | Inspect parsed read-only Git status. For writes (init, add, commit, remote, push, rm, clean, reset) use the git tool. |
| 11 | `git_diff` | READ | Return a bounded read-only Git diff. For writes use the git tool. |
| 12 | `git_log` | READ | Return bounded structured Git history. For writes use the git tool. |
| 13 | `git` | EXECUTE | Run a Git subcommand with a separate args array. Full Access runs ordinary read and non-destructive Git mutations without confirmation. Destructive/data-loss Git forms ask unless their exact scoped family is enabled for auto-approval; scope overrides, aliases, unsafe pathspecs, unknown commands, and destructive remote/history rewrites remain guarded or denied. Mutating calls require workspaceId to match the host-selected Active Project. Do not wrap Git in PowerShell/cmd. |
| 14 | `write_file` | WRITE | Create or replace a UTF-8 text file and missing parents. Balanced/Safe refuse existing targets unless overwriteExisting is explicit; Full may replace an existing target without a confirmation prompt and still creates a checkpoint. Prefer edit_file for narrow repairs. Use this instead of shell scripts that call fs.writeFile, writeFileSync, Set-Content, or equivalent when the task is simply to create or replace guarded text. |
| 15 | `apply_patch` | WRITE | Apply reviewed whole-file replacement content to at most twenty files. Existing targets are checkpointed first; Full profile does not prompt for non-destructive replacement. Prefer edit_file for narrow repairs. Use this instead of shell-generated whole-file rewrites when several reviewed text files must change. |
| 16 | `edit_file` | WRITE | First choice for narrow source, config, and text repairs. Replaces exact text only when the expected occurrence count matches, checkpoints the original, and refuses conflicts instead of rewriting an unverified whole file. Use edit_file instead of shell, node -e, python -c, PowerShell Set-Content, or inline filesystem scripts when a guarded text edit can express the change. Full Access performs ordinary edits without a confirmation prompt; destructive deletion remains separately guarded. |
| 17 | `move_file` | WRITE | Move a file or directory within the Active Project, creating missing destination parents. Full Access performs ordinary moves without a confirmation prompt; conflicting or destructive forms remain policy-gated. |
| 18 | `copy_file` | WRITE | Copy a file or directory within one workspace, creating missing destination parents. |
| 19 | `delete_file` | DANGEROUS | Move one file or empty directory from the host-selected Active Project into Recovery Trash. This structured delete can be auto-approved when its saved setting is enabled and the exact target is proven safe. Other destructive Git/shell/WSL families have separate exact-scope settings; critical paths, workspace roots, non-empty directories, ambiguous paths, and mismatched workspaces remain guarded. Returns a recoveryId and local recovery path. |
| 20 | `list_recovery_items` | READ | List trusted Recovery Trash entries for one workspace, including deleted items, binary pre-replacement backups, original paths, timestamps, payload availability, and the local Recovery Trash root. |
| 21 | `restore_deleted_file` | WRITE | Restore one Recovery Trash item to its original path. Deleted-item restores refuse existing targets. A pre-replacement restore first backs up the current live version for undo, then restores the older binary or text payload. Full runs recoverable restores without an extra prompt; stricter profiles may require confirmation. The operation remains scoped to the recorded workspace. |
| 22 | `list_checkpoints` | READ | List encrypted pre-mutation checkpoints for one workspace without returning saved file content. |
| 23 | `restore_checkpoint` | WRITE | Restore a reviewed pre-mutation checkpoint. Requires explicit confirmation and creates a new rollback checkpoint before replacing current content. |
| 24 | `process_start` | EXECUTE | Immediate-return managed process launcher. Normal policy-allowed commands run without confirmation; only risky command shapes, protected scope changes, or permission-profile ASK decisions require explicit confirmation. Starts one policy-checked executable with separate arguments and returns processId as soon as the child is spawned; it never waits for command completion. Follow with process_status/process_logs/process_stop. For restart-safe durable work, use shell, whose MCP run mode is forced to background. |
| 25 | `process_list` | READ | List managed process handles owned by this client in a workspace, including launches whose response was cancelled. |
| 26 | `process_status` | READ | Read one status snapshot for an owned process handle. Do not tight-poll this tool; use project_* for normal project verification, or shell background + durable task_id for work expected to exceed ~5 minutes. |
| 27 | `process_logs` | READ | Read bounded logs for an owned process handle. Prefer one bounded log read after meaningful progress rather than repeated status polling. |
| 28 | `process_stop` | EXECUTE | Stop an owned managed process tree after explicit chat confirmation. |
| 29 | `project_dev` | EXECUTE | Immediate-return launcher for the detected project dev command. The gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 30 | `project_test` | EXECUTE | Immediate-return launcher for the detected project test command. The gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 31 | `project_lint` | EXECUTE | Immediate-return launcher for the detected project lint command. The gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 32 | `project_typecheck` | EXECUTE | Immediate-return launcher for the detected project typecheck command. The gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 33 | `project_build` | EXECUTE | Immediate-return launcher for the detected project build command. The gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Project-owned script bodies remain opaque and are not covered by Recovery Trash. |
| 34 | `codex_status` | READ | Report local Codex installation and capabilities without credential inspection. |
| 35 | `codex_run` | EXECUTE | Delegate an instruction to the local Codex CLI in the Active Project. Starting Codex always requires explicit chat confirmation and userConfirmed: true. |
| 36 | `codex_task_list` | READ | List local Codex task handles owned by this client, including launches whose response was cancelled. |
| 37 | `codex_task_status` | READ | Read status for an owned Codex task. |
| 38 | `codex_task_logs` | READ | Read bounded logs for an owned Codex task. |
| 39 | `codex_stop` | EXECUTE | Stop an owned Codex task process after explicit chat confirmation. |
| 40 | `shell` | EXECUTE | Non-blocking command runner for system operations and CLI tasks. Use shell for command execution, builds/tests, package managers, and system operations; do not use it as a text editor. For source/config/text changes, prefer edit_file for exact replacements, apply_patch for reviewed multi-file or whole-file replacements, and write_file for creation/replacement. Do not wrap Node, Python, or PowerShell inline scripts around fs.writeFile, writeFileSync, Set-Content, or equivalent when a guarded file tool can perform the edit. MCP run calls are ALWAYS forced to execution=background, even if a client requests foreground or auto, so the call returns a task_id immediately instead of waiting for command completion. Follow with status/logs/result; wait uses the user-configurable MCP poll window (5-60 seconds, default 5). After one or two checks still show running, do not keep polling in the same chat turn: preserve task_id and return control so the durable task can continue without risking a ChatGPT turn timeout. Full Access runs ordinary policy-allowed commands without confirmation. Destructive/data-loss command forms ask unless an exact scoped destructive family is enabled for auto-approval; broad, recursive, critical, outside-project, or unparseable destructive forms remain interactive. dry_run and task observation are non-mutating. Active Project is the default cwd/ownership context, but an explicitly absolute cwd outside it may be used when the active capability policy allows that location; executable paths are never required to live inside the Active Project. |
| 41 | `dom_cdp` | READ | Default for web-page DOM work inside managed Chrome: inspect content, query selectors, click, type, navigate, evaluate JavaScript, wait, manage tabs, and capture screenshots. Any action that can change local or remote state requires explicit chat confirmation and userConfirmed: true. Use steps to batch related DOM actions in one call. |
| 42 | `accessibility` | READ | Semantic native Windows UI tool. Inspect UI trees and named controls, then click, focus, read or set values, select controls and menus, or manage a native element. Prefer shell for direct system work and dom_cdp for web pages. |
| 43 | `input_event` | EXECUTE | Low-level keyboard and pointer fallback. Use only when DOM/CDP and Accessibility cannot operate the target. Supports text, keys, mouse movement, clicks, drag, scroll, held buttons, release_all, and batched sequences. |
| 44 | `vision` | READ | Visual and OCR fallback for content unavailable through DOM or Accessibility. Capture a display, window, or region, or run local Vision OCR. It never clicks or types. |
| 45 | `vision_annotated_capture` | READ | Capture a local Windows screen/region/window and return a short-lived Set-of-Marks observation with numbered bounds, a content hash, and an annotated PNG. This tool only observes; use ui_target_action for a separately gated action. |
| 46 | `ui_target_action` | EXECUTE | Act on one mark from a current vision_annotated_capture observation. The observation ID, optional hash, TTL, workspace owner, and current Accessibility element are checked before the action is sent. |
| 47 | `window` | EXECUTE | Direct native Windows window management. List, inspect, activate, move, resize, minimize, maximize, restore, or close windows without raw coordinates when a window operation is sufficient. |
| 48 | `health` | READ | Diagnostics only. Check all lnwjud backends or one public tool after a failure, when asked for status, or while diagnosing permissions. Do not use as a preflight before normal work. |
| 49 | `system_info` | READ | Read-only system information: OS, CPU, memory, disks, battery, uptime, and top processes by memory. Use for environment checks and diagnostics. |
| 50 | `notification` | EXECUTE | Show a Windows notification (toast when BurntToast is installed, balloon otherwise). Use to tell the user when a long task finishes. |
| 51 | `file_dialog` | EXECUTE | Open a native Windows file open/save dialog and return the chosen path(s). The dialog does not read or write files itself; use the guarded file tools afterwards. |
| 52 | `clipboard` | EXECUTE | Read or write the Windows clipboard (text, or PNG image as base64). Use get_text/get_image to read and set_text to write. |
| 53 | `web_fetch` | READ | Fetch an http/https URL (GET/POST/PUT/DELETE/HEAD) with bounded size and timeout. Every POST, PUT, or DELETE requires explicit chat confirmation and userConfirmed: true; dry_run remains safe. Returns status, headers, and text or base64 body. |
| 54 | `audio` | EXECUTE | Record the microphone to a WAV file or play a local audio file through MCI. Recording requires the host-selected Active Project workspaceId, explicit confirmation, and a Recovery Trash backup before an existing output is replaced. record is synchronous and limited to 600 seconds. Use stop to abort an ongoing record/play. |
| 55 | `screen_record` | EXECUTE | Record the screen to an MP4 using ffmpeg gdigrab (requires ffmpeg on PATH). Starting a recording requires the host-selected Active Project workspaceId, explicit confirmation, and a Recovery Trash backup before an existing output is replaced. start spawns a background capture, status checks it, stop finalizes the file. Recording stops automatically after 3600 seconds. |
| 56 | `office` | WRITE | Automate Excel, Word, PowerPoint, or Outlook through COM. Every write, replace, merge, or save_as action requires an Active Project workspaceId, explicit chat confirmation, userConfirmed: true, and a Recovery Trash backup before an existing target is replaced. Requires Microsoft Office installed. |
| 57 | `scheduler` | EXECUTE | Manage Windows scheduled tasks with schtasks.exe. list is read-only; create, run, and delete always require explicit chat confirmation and userConfirmed: true. |
| 58 | `wsl_exec` | EXECUTE | Non-blocking WSL2 developer runner. MCP run calls are ALWAYS forced to background and return a task_id immediately; foreground/auto requests are normalized by the server. Follow with status/logs/result; wait uses the user-configurable MCP poll window (5-60 seconds, default 5). After one or two checks still show running, do not keep polling in the same chat turn: preserve task_id and return control so the durable task can continue without risking a ChatGPT turn timeout. It executes one Linux executable with argv, an explicit distribution, and a Windows workspace cwd, and never accepts shell command strings. Full Access runs ordinary WSL commands without confirmation. Destructive/data-loss forms ask unless an exact scoped WSL destructive family is enabled for auto-approval; broad, recursive, outside-project, or unparseable forms remain interactive. Active Project remains the default cwd/ownership context, while an explicitly requested external cwd may be used when the capability policy allows it; the Linux executable itself is not restricted to the Active Project. |
| 59 | `wsl_fs` | READ | Translate paths and inspect metadata between a registered Windows workspace and WSL without exposing raw \\wsl$ read/write access. |
| 60 | `skills_list` | READ | List local agent skills discovered from Cursor, Claude, Agents, workspace skill roots, and lnwjud settings. Filter with query or source. |
| 61 | `skills_read` | READ | Read a local skill SKILL.md (or a relative file inside the skill folder). Follow the skill instructions with lnwjud tools and mcp_call. |
| 62 | `mcp_list` | READ | List local MCP servers discovered from Cursor, Claude Desktop, and lnwjud settings. This inspection is read-only and does not flatten child tools into the lnwjud catalog. |
| 63 | `mcp_describe` | READ | Connect to one local MCP server (if needed) and return its tool names, descriptions, and input schemas. This operation only inspects the child tool catalog. |
| 64 | `mcp_call` | DANGEROUS | Call a tool on a discovered local MCP server. Child side effects and filesystem/network scope are controlled by that child server, so every mcp_call is treated as opaque mutation and requires explicit chat plus host exact-action approval. |
| 65 | `workspace_context` | READ | Aggregate ranked workspace context with snippets, symbols, Git/test relevance, economy metadata, and continuation; automatic discovery can be explicitly expanded. |
| 66 | `workspace_context_continue` | READ | Continue a workspace_context result without discarding unreturned candidates. |
| 67 | `workspace_full_scan` | READ | Enumerate workspace files with full access by default; set includeIgnored false to use the persistent automatic index. |
| 68 | `workspace_full_scan_continue` | READ | Continue a workspace_full_scan result page. |
| 69 | `workspace_snapshot` | READ | Return workspace identity and project snapshot metadata without source contents. |
| 70 | `search_all` | READ | Search text and filenames across one or all registered workspaces with automatic economy filters or an explicit includeIgnored override. |
| 71 | `read_many_files` | READ | Read many workspace files in parallel while preserving one result or error per requested path. |
| 72 | `read_file_page` | READ | Preferred reader for large files after search_text identifies the relevant area. Reads a deterministic line chunk with explicit continuation instead of silently truncating or loading the whole file. |
| 73 | `read_file_page_continue` | READ | Continue read_file_page from the next deterministic line chunk only when more surrounding context is needed; avoid re-reading earlier pages. |
| 74 | `workspace_index` | READ | Build or refresh the persistent workspace index using automatic context filters unless ignored paths are explicitly included. |
| 75 | `workspace_index_status` | READ | Return persistent index metadata and lossless watcher queue telemetry. |
| 76 | `workspace_index_watch` | READ | Watch all workspace paths and incrementally re-index only changed paths with configurable debounce/concurrency. |
| 77 | `workspace_index_stop` | READ | Stop a workspace watcher after draining all queued path updates. |
| 78 | `session_handoff` | READ | Create a concise same-chat recovery message from the real phase tracker, current git status/diff, and durable background task IDs. Use only when the user requests a handoff or an unavoidable client/platform interruption requires recovery; never trigger it merely because elapsed time passed. If a tool schema looks stale, Refresh connector first; open a new chat only if refresh does not fix it. |
| 79 | `verify_incremental` | EXECUTE | Run the detected project typecheck only when the current git status/diff fingerprint changed. Starting a new verification process requires explicit user confirmation. Returns cache=hit when unchanged and cache=miss after a new verification. Prefer this during iterative edits; use project_test/project_lint/project_build only when that specific verification is needed. For full suites or packaging expected to exceed ~5 minutes, launch a durable shell background task and record its task_id in the tracker. |
| 80 | `run_goal` | WRITE | Immediate-return durable goal create/resume and lease acquisition. It never runs a model or waits for foreground work. |
| 81 | `get_goal` | READ | Read the latest durable goal snapshot without changing state or returning a lease token. |
| 82 | `checkpoint_goal` | WRITE | Atomically checkpoint durable goal progress using the current lease and expected revision. |
| 83 | `finish_goal` | WRITE | Finish a durable goal as completed, failed, or blocked using lease/revision compare-and-swap. |
| 84 | `list_goals` | READ | List a bounded set of durable goals owned by the current stable MCP client, optionally filtered by workspace/status. |
| 85 | `symbol_search` | READ | Search indexed symbols across the workspace. |
| 86 | `find_definition` | READ | Find deterministic symbol definitions. |
| 87 | `find_references` | READ | Find textual and indexed references to a symbol. |
| 88 | `find_implementations` | READ | Find interface and class implementations. |
| 89 | `call_hierarchy` | READ | Return a deterministic call hierarchy approximation. |
| 90 | `import_graph` | READ | Return indexed imports and exports for a module. |
| 91 | `dependency_graph` | READ | Return package and module dependency metadata. |
| 92 | `module_graph` | READ | Return the workspace module graph. |
| 93 | `type_search` | READ | Search indexed TypeScript, JavaScript, and Python types. |
| 94 | `trace_symbol` | READ | Combine definition, references, imports, tests, and recent context. |
| 95 | `context_ranking` | READ | Explain ranking signals without removing lower-ranked context. |
| 96 | `debug_context` | READ | Gather deterministic debugging context and continuation metadata. |
| 97 | `review_context` | READ | Gather code-review context. |
| 98 | `change_context` | READ | Gather changed files, symbols, dependencies, and tests. |
| 99 | `symbol_context` | READ | Gather context around a symbol. |
| 100 | `test_context` | READ | Gather relevant test context. |
| 101 | `dependency_context` | READ | Gather dependency-related context. |
| 102 | `git_context` | READ | Gather Git status, diff, and history context. |
| 103 | `frontend_context` | READ | Gather frontend project context. |
| 104 | `backend_context` | READ | Gather backend project context. |
| 105 | `route_intent` | READ | Classify a prompt with a deterministic, overridable route. |
| 106 | `recipe_list` | READ | List built-in and user recipe names. |
| 107 | `recipe_describe` | READ | Describe a recipe plan and permissions. |
| 108 | `recipe_run` | EXECUTE | Preview or run a deterministic recipe plan. |
| 109 | `dry_run` | READ | Return a no-side-effect execution preview. |
| 110 | `review_changes` | READ | Review current Git changes and affected context. |
| 111 | `changed_symbols` | READ | Find symbols in changed files. |
| 112 | `affected_modules` | READ | Find modules affected by current changes. |
| 113 | `git_history_context` | READ | Return relevant recent Git history. |
| 114 | `git_blame_context` | READ | Return line ownership context for a file. |
| 115 | `discover_tests` | READ | Discover project tests without imposing an execution limit. |
| 116 | `run_affected_tests` | EXECUTE | Plan or run tests affected by changed files. |
| 117 | `test_failures` | READ | Summarize recorded test failures. |
| 118 | `coverage_context` | READ | Return coverage context when project tooling provides it. |
| 119 | `test_history` | READ | Return recent test execution history. |
| 120 | `cache_stats` | READ | Return shared cache hit/miss telemetry. |
| 121 | `cache_clear` | WRITE | Clear safe local runtime caches. |
| 122 | `cache_invalidate` | WRITE | Invalidate cache entries for a path or workspace. |
| 123 | `hook_list` | READ | List registered lifecycle hooks. |
| 124 | `hook_register` | WRITE | Register a deterministic lifecycle hook descriptor. |
| 125 | `hook_remove` | WRITE | Remove a lifecycle hook descriptor. |
| 126 | `skill_match` | READ | Match relevant local skills without loading all skill text. |
| 127 | `skill_load` | READ | Load a selected local skill by identifier. |
| 128 | `plugin_install` | WRITE | Register a declared plugin descriptor after validation and permission evaluation. |
| 129 | `plugin_list` | READ | List installed and enabled plugins. |
| 130 | `plugin_enable` | WRITE | Enable an installed plugin. |
| 131 | `plugin_disable` | WRITE | Disable an installed plugin. |
| 132 | `plugin_remove` | DANGEROUS | Remove an installed plugin. |
| 133 | `session_context` | READ | Return persisted development-session context. |
| 134 | `session_checkpoint` | WRITE | Persist a development-session checkpoint. |
| 135 | `session_resume` | READ | Resume a persisted session context. |
| 136 | `session_history` | READ | Return session checkpoints and decisions. |
| 137 | `response_mode` | READ | Select compact, normal, verbose, or stream formatting. |
| 138 | `inspect_web_app` | READ | Combine DOM, console, network, URL, and screenshot metadata. |
| 139 | `debug_ui` | READ | Gather deterministic UI debugging context. |
| 140 | `capture_ui_state` | READ | Capture a structured UI state. |
| 141 | `form_context` | READ | Inspect form controls and values metadata. |
| 142 | `network_context` | READ | Summarize browser network context. |
| 143 | `console_context` | READ | Summarize browser console context. |
| 144 | `browser_debug_context` | READ | Combine browser diagnostics for one request. |
| 145 | `windows_environment` | READ | Inspect Windows environment metadata. |
| 146 | `service_context` | READ | Inspect Windows service metadata. |
| 147 | `process_context` | READ | Inspect process-tree context. |
| 148 | `port_context` | READ | Inspect local listening-port context. |
| 149 | `registry_context` | READ | Inspect registry context through the Windows capability boundary. |
| 150 | `event_log_context` | READ | Inspect Windows event-log context. |
| 151 | `installed_runtime_context` | READ | Inspect installed runtimes and package managers. |
| 152 | `path_context` | READ | Resolve executable and PATH context. |
| 153 | `startup_context` | READ | Inspect startup configuration context. |
| 154 | `mcp_discover` | READ | Discover external MCP servers without flattening native tools. |
| 155 | `mcp_health` | READ | Return external MCP connection health. |
| 156 | `mcp_resources` | READ | List resources exposed by connected MCP servers. |
| 157 | `task_create` | EXECUTE | Create a visible managed runtime task. |
| 158 | `task_status` | READ | Read managed task state. |
| 159 | `task_cancel` | EXECUTE | Cancel a managed runtime task. |
| 160 | `task_result` | READ | Read a managed task result. |
| 161 | `task_list` | READ | List managed runtime tasks. |
| 162 | `delegate` | EXECUTE | Delegate a task through a policy/audit adapter. |
| 163 | `delegate_status` | READ | Read delegated agent state. |
| 164 | `delegate_cancel` | EXECUTE | Cancel a delegated agent task. |
| 165 | `delegate_result` | READ | Read a delegated agent result. |
| 166 | `parallel_delegate` | EXECUTE | Run isolated read-only agent tasks with collision metadata. |
| 167 | `permission_check` | READ | Evaluate an action class without limiting allowed context reads. |
| 168 | `permission_profile` | READ | Return the active Permission v2 profile. |
| 169 | `live_logs_query` | READ | Query structured activity/log metadata with correlation IDs. |
| 170 | `live_logs_status` | READ | Return Live Logs pipeline health and source status. |
| 171 | `telemetry_dashboard` | READ | Return runtime performance telemetry. |
| 172 | `context_economy_stats` | READ | Return context discovery, deduplication, ledger, and token-efficiency telemetry. |
| 173 | `execution_plan` | READ | Return the cheapest deterministic execution plan and reason. |
| 174 | `repo_map` | READ | Return a traversable repository structural map. |
| 175 | `context_expand` | READ | Return optional import, caller, type, test, and change references. |
| 176 | `recovery_status` | READ | Return reconnect, retry, continuation, cache, and worker recovery state. |
| 177 | `tool_schema_list` | READ | List versioned tool schema metadata. |
| 178 | `tool_schema_register` | WRITE | Register a backward-compatible tool schema descriptor. |
| 179 | `capabilities` | READ | Discover capability categories without requiring every full schema. |
| 180 | `tool_search` | READ | Search tools, tags, phases, and descriptions deterministically. |
| 181 | `tool_dynamic_filter` | READ | Return a bounded ranked tool set using deterministic scoring with optional local rerank fallback. |
| 182 | `tool_describe` | READ | Describe one tool contract on demand. |
| 183 | `tool_categories` | READ | List tool categories and counts. |
| 184 | `tool_function_find` | READ | Find the best local tool/function candidates for a prompt. |
| 185 | `tool_aliases` | READ | List stable shorthand aliases and their primitive tool targets. |
| 186 | `mcp_hub` | READ | Describe the additive MCP hub boundary without flattening child tools or retaining credentials. |
| 187 | `dev_context` | READ | Run the unified deterministic development-context facade. |
| 188 | `recipe_catalog` | READ | Return inspectable developer automation recipes. |
| 189 | `capture_screenshot` | READ | Capture screenshot metadata for visual validation. |
| 190 | `compare_screenshot` | READ | Compare screenshot metadata or supplied artifacts. |
| 191 | `dom_snapshot` | READ | Return a structured DOM snapshot. |
| 192 | `layout_metadata` | READ | Return layout metadata for visual validation. |
| 193 | `visual_context` | READ | Combine screenshot, DOM, layout, console, and network references. |
| 194 | `inspect_workbook` | READ | Inspect workbook sheets, used ranges, and a bounded sample through Excel COM. |
| 195 | `compare_workbook_layout` | READ | Compare workbook layout metadata through an optional spreadsheet plugin. |
| 196 | `render_excel_preview` | READ | Render an Excel preview through an optional spreadsheet plugin. |
| 197 | `inspect_pdf` | READ | Inspect PDF page structure and text through the local PDF provider. |
| 198 | `compare_pdf_pages` | READ | Compare PDF page metadata through an optional PDF plugin. |
| 199 | `project_profile_get` | READ | Read project intelligence conventions. |
| 200 | `project_profile_set` | WRITE | Update project intelligence conventions. |
| 201 | `handoff_context` | READ | Build a structured cross-agent handoff bundle. |
| 202 | `benchmark_run` | EXECUTE | Run or preview a benchmark scenario. |
| 203 | `regression_report` | READ | Return benchmark and regression results. |
| 204 | `sandbox_exec` | EXECUTE | Run an artifact-based Windows Sandbox job with networking disabled and read-only mapped input. |
| 205 | `event_watch` | EXECUTE | Watch an allowlisted user-mode ETW or Windows Event Log diagnostic stream. |
| 206 | `crash_trace` | READ | Return bounded crash and service-diagnostic context from allowlisted user-mode sources. |
| 207 | `lsp_diagnostics` | READ | Read diagnostics from an owned language-server child process. |
| 208 | `lsp_rename` | WRITE | Create a cross-file LSP rename edit plan before any workspace write. |
| 209 | `debug_attach` | EXECUTE | Attach a DAP client only to an owned workspace debug adapter. |
| 210 | `debug_step` | EXECUTE | Perform a bounded DAP stepping/read operation in an owned debug session. |
| 211 | `git_worktree_spawn` | WRITE | Create a confined, ledger-owned Git worktree for isolated agent work with collision metadata. |
| 212 | `git_worktree_remove` | DANGEROUS | Remove a ledger-owned Git worktree after dry-run and explicit confirmation. |
| 213 | `db_inspect` | READ | Inspect a local database schema through a configured, read-only connection. |
| 214 | `db_query` | READ | Run a bounded read-only local SQLite SELECT, PRAGMA, or WITH...SELECT query. |
| 215 | `office_ppt` | WRITE | Read PowerPoint content or save a copy through the existing Office policy boundary. |
| 216 | `office_outlook` | READ | Read Outlook folder and message headers through the existing Office policy boundary. |
| 217 | `pdf_extract_tables` | READ | Extract bounded PDF text and tables through a local document provider. |
| 218 | `docx_merge` | WRITE | Create a deterministic DOCX merge plan and write only after approval. |
| 219 | `self_heal_plan` | READ | Propose safe, deterministic, reversible recovery steps without applying mutations. |
| 220 | `self_heal_apply` | DANGEROUS | Apply an approved reversible recovery plan without automatic destructive retries. |
| 221 | `skills_import` | WRITE | Import a compatible skill descriptor after validation and permission review. |
| 222 | `agent_swarm_run` | EXECUTE | Plan bounded parallel subagents with ownership, collision, approval, and cancellation metadata. |
| 223 | `tool_batch` | EXECUTE | Execute multiple MCP tools with parallel, dependency-aware, timeout, cancellation, and partial-result handling. |
<!-- END GENERATED README TOOL REGISTRY -->

## Detailed capability guide

### Workspace and project inspection

| Tool | Permission | What it does |
| --- | --- | --- |
| workspace_info | READ | Returns display name, canonical root, project profile, and Git summary |
| workspace_tree | READ | Returns a bounded directory tree; hidden and heavy folders are included, with depth/entry bounds and truncation metadata |
| project_snapshot | READ | Returns profile, Git counts, top-level tree, managed processes, and recent error summaries without source contents |

### Optional machine-root discovery extension

The current default is **Unrestricted mode**, which registers every available
fixed drive (C:, D:, E:, …) as a machine root for read/discovery compatibility.
If Unrestricted mode is explicitly disabled, the restricted machine-root contract
selects the active/preferred Windows drive dynamically (falling back through the
normal system, home, and current-working-directory drive discovery) and prunes
other drive-root registrations. No fixed drive letter is required. Project folders
may be registered below the active machine roots through MCP or the desktop UI.
This visibility setting does not widen mutation authority beyond the host-selected
Active Project.

| Tool | Permission | Input | What it does |
| --- | --- | --- | --- |
| workspace_list | EXECUTE | Empty object | Lists registered machine roots and project workspaces (`kind`: `machine_root` or `project`). Read-only discovery; Safe asks, Balanced/Full allow. |
| workspace_register | WRITE | parentWorkspaceId, path, optional displayName | Registers an existing project directory below a machine root (idempotent; any drive root in unrestricted mode) |

The extension still validates the parent ID, canonical path, and reparse points.
**Secret and hidden files are intentionally readable in the default unrestricted
mode** (including `.env`, keys, and credentials) on every fixed drive when read
policy permits them. Image and other binary files are returned as base64 with no
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
`id_ed25519*`, `.ssh/**`, `.aws/**`, and `credentials.json` may be readable on
registered fixed-drive roots when the active read policy permits them. This read
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
| skills_list | READ | Lists discovered skills from Cursor/Claude/Agents/workspace roots |
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

Unrestricted mode expands **read/discovery visibility and machine-root
registration** for compatibility. It does **not** lift the host-selected Active
Project mutation boundary, shared command/Git policy, independent host approval,
or hard blocks. Enable the visibility mode either way:

- Settings → Unrestricted mode (checkbox; restart the app to apply), or
- `$env:LNWJUD_UNRESTRICTED = '1'` before launching lnwjud (the tunnel script
  below sets this automatically for the stdio runtime).

When enabled:

- Every fixed drive (C:, D:, E:, …) can be registered as a machine root for
  read/discovery and `workspace_register` can select a project under those roots.
- Secret files (.env, *.key, id_rsa, .ssh/**, .aws/**, credentials.json) may be
  readable on registered roots when the active read policy permits them; binary
  files are returned as base64 by the file reader.
- Capability discovery can see the configured fixed-drive roots, but mutation-
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

Use git diff --check before committing.

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
