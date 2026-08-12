# lnwjud

lnwjud is a Windows-first local development gateway that exposes an approved
development workspace through [Model Context Protocol (MCP)](https://modelcontextprotocol.io).
It lets ChatGPT, Codex, or another MCP client inspect source code, search a
project, review Git state, edit files, run approved project commands, inspect
process logs, and optionally delegate work to the local Codex CLI.

The code and commands remain on the Windows computer. ChatGPT web does not
receive a public shell and does not read the local Codex configuration. For a
ChatGPT web connection, OpenAI Secure MCP Tunnel forwards MCP requests to a
local lnwjud process; the tunnel is outbound-only.

> **Security boundary:** lnwjud is workspace-scoped and policy-checked. It is
> not an unrestricted administrator shell. Full Access changes the approval
> profile, but it does not remove operating-system hard blocks, path guards, or
> the prohibition on arbitrary shell-string execution.

## Choose a connection mode

| Client | Connection | What must be running on Windows | Best for |
| --- | --- | --- | --- |
| ChatGPT web | OpenAI Secure MCP Tunnel | tunnel-client and a packaged stdio-capable lnwjud launcher | A ChatGPT chat working on a private local project |
| ChatGPT desktop / Codex CLI / IDE | Local stdio MCP | lnwjud.exe --mcp-stdio | Lowest-latency local development |
| Desktop dashboard or a local MCP client | Loopback Streamable HTTP | The lnwjud desktop app and its local MCP connection | Debugging and local browser/UI capabilities |
| Responses API or another supported OpenAI surface | Secure MCP Tunnel or private HTTP | A running tunnel client or private HTTP MCP server | Programmatic tool calls |

### Important: the stdio launcher

The tunnel command must start the stdio MCP entrypoint, not the Electron
dashboard. A stdio-capable package must support this command:

```text
lnwjud.exe --mcp-stdio
```

If the executable opens the graphical dashboard instead of waiting for MCP
messages, it is a desktop-only build and cannot be used as a stdio tunnel
command. Use a build/release that includes the packaged stdio launcher, or use
the desktop HTTP connection.

## What must be configured

1. **Local gateway:** this repository or the Windows installer.
2. **Local policy:** registered workspaces and a permission profile.
3. **OpenAI Platform:** a tunnel, its workspace/organization associations, and a
   runtime API key with tunnel-use permission.
4. **ChatGPT developer app:** a private app that selects the tunnel and exposes
   the MCP tools to a chat.

ChatGPT web sees the remote connector only. The Windows process and the tunnel
client must remain running.

## Requirements

### Windows computer

- Windows x64.
- Node.js 24 LTS (engine range >=24.0.0 <25) when building from source.
- Git, Corepack, and the pinned package manager pnpm@10.15.0.
- PowerShell 7 is recommended; Windows PowerShell 5.1 is sufficient for the
  examples here.
- ripgrep (rg) is recommended.
- The local Codex CLI is optional. lnwjud reports its availability without
  reading Codex credential files.

### OpenAI account and workspace

For the ChatGPT web path:

- Developer mode must be enabled in the target ChatGPT workspace.
- You need an OpenAI Platform organization with tunnel access.
- Tunnels Read + Manage is required to create/edit a tunnel.
- Tunnels Read + Use is required to run tunnel-client and select a tunnel while
  creating the ChatGPT developer app.
- The tunnel must be associated with the target ChatGPT workspace, not only with
  a personal Platform organization.

Platform tunnel permissions and ChatGPT Developer mode are separate controls.
Ask the ChatGPT workspace administrator and Platform organization owner/RBAC
administrator when a control is unavailable.

### Network

The machine running tunnel-client needs outbound HTTPS to api.openai.com:443
(or mtls.api.openai.com:443 when control-plane mTLS is configured) and local
reachability to the configured MCP command or URL. It does not need an inbound
firewall rule or a public port.

## Install from source

### Clone and install dependencies

```powershell
git clone https://github.com/engasnm111/lnwjud.git
Set-Location .\lnwjud
corepack pnpm@10.15.0 install --frozen-lockfile
```

Do not silently upgrade the package manager: the lockfile is pinned to
pnpm@10.15.0.

### Build and run the desktop dashboard

```powershell
corepack pnpm@10.15.0 build
Set-Location .\apps\desktop
corepack pnpm@10.15.0 exec electron .\dist\main\main.js
```

The dashboard owns the SQLite state, workspace registry, permission profile,
audit records, and loopback MCP lifecycle.

### Build a Windows installer

```powershell
Set-Location E:\lnwjud
corepack pnpm@10.15.0 package:windows
```

The x64 NSIS installer is written to:

```text
apps/desktop/dist/installers/lnwjud-Setup-0.1.0.exe
```

The installer is per-user by default. A common installed executable path is:

```text
C:/Users/<WindowsUser>/AppData/Local/Programs/lnwjud/lnwjud.exe
```

Always use the path shown by the installed shortcut or Get-Command.

## Configure the local desktop application

### Add a workspace

1. Start lnwjud.
2. Add the project directory in the Workspace panel.
3. Save the returned workspace ID. MCP calls use this ID, not an arbitrary path.
4. Select a permission profile.
5. Run the dashboard doctor if a dependency is reported missing.

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

Desktop MCP and stdio MCP runtimes force the **full** profile so every tool
(including skills/MCP bridge meta-tools) runs with full access. Full Access is
still not an administrator bypass: path validation, secret-file policy,
shell-host blocking, process ownership, Windows privilege limits, and
destructive Git hard blocks still apply.

### Optional local capability roots

The local desktop capability layer can receive additional roots through the
semicolon-separated environment variable LNWJUD_CAPABILITY_ROOTS:

```powershell
$env:LNWJUD_CAPABILITY_ROOTS = 'E:/work;E:/projects'
```

Only configure roots under drive **E:**. Paths on other drives are ignored.
Core file tools still require a registered workspace.

### Start the local HTTP connection

In the dashboard:

1. Select a registered workspace.
2. Click Start Connection.
3. Copy the displayed URL, normally http://127.0.0.1:<port>/mcp.
4. Add it to a local Streamable HTTP MCP client.
5. Click Stop Connection when finished.

The endpoint binds to 127.0.0.1, validates origin/host, and uses the same
application services and permission checks as the dashboard. Do not expose the
loopback URL through a generic port forward.

If dom_cdp is available, the dashboard can launch managed Chrome. Browser
automation remains loopback-bound and separate from the file guard.

## Connect a local Codex client

Local Codex clients can use stdio directly; they do not need Secure MCP Tunnel.
Point the entry at the stdio-capable installed executable:

```powershell
codex mcp add lnwjud -- "$env:LOCALAPPDATA\Programs\lnwjud\lnwjud-mcp-stdio.cmd" --workspace E:\lnwjud
codex mcp list
```

The stdio launcher is the Node-based `lnwjud-mcp-stdio.cmd` shipped next to the
desktop app (not the GUI `lnwjud.exe`). It exposes the full tool catalog,
including skills/MCP bridge meta-tools. Requires Node.js 24+.

The same server can be added in ChatGPT desktop or an IDE extension under
Settings → MCP servers → Add server → STDIO. Restart the host after saving.
In Codex, /mcp lists active servers.

Example user-scoped or trusted project-scoped config.toml:

```toml
[mcp_servers.lnwjud]
command = "C:/Users/<WindowsUser>/AppData/Local/Programs/lnwjud/lnwjud-mcp-stdio.cmd"
args = ["--workspace", "E:/lnwjud"]
startup_timeout_sec = 20
tool_timeout_sec = 120
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

### 3. Download tunnel-client

Use the Platform download link or the [official tunnel-client
releases](https://github.com/openai/tunnel-client). Keep the executable at a
stable path, for example:

```text
C:/Users/<WindowsUser>/Downloads/tunnel/tunnel-client.exe
```

Verify it:

```powershell
$tc = 'C:/Users/<WindowsUser>/Downloads/tunnel/tunnel-client.exe'
& $tc --version
& $tc help quickstart
```

### 4. Create a stdio profile

Set the runtime key only in the current PowerShell process and create the
profile:

```powershell
$env:CONTROL_PLANE_API_KEY = '<runtime-key-for-this-session>'

& $tc init --sample sample_mcp_stdio_local --profile lnwjud --tunnel-id 'tunnel_0123456789abcdef0123456789abcdef' --mcp-command 'C:/Users/<WindowsUser>/AppData/Local/Programs/lnwjud/lnwjud.exe --mcp-stdio'
```

Use forward slashes in the Windows executable path inside the profile.
Backslashes can be interpreted as YAML escapes and turn C:\Users\... into
C:Users....

The generated profile is normally:

```text
C:/Users/<WindowsUser>/AppData/Roaming/tunnel-client/lnwjud.yaml
```

A minimal profile has this shape. The key remains an environment reference:

```yaml
config_version: 1
control_plane:
  base_url: "https://api.openai.com"
  tunnel_id: "tunnel_0123456789abcdef0123456789abcdef"
  api_key: "env:CONTROL_PLANE_API_KEY"
health:
  listen_addr: "127.0.0.1:0"
admin_ui:
  open_browser: false
log:
  level: info
  format: json
mcp:
  # tunnel-client defaults to 10m and tears down long ChatGPT sessions if unset
  connection_max_ttl: 24h
  commands:
    - channel: main
      command: "C:/Users/<WindowsUser>/AppData/Local/Programs/lnwjud/lnwjud.exe --mcp-stdio"
```

### 5. Run diagnostics and the tunnel

```powershell
$env:CONTROL_PLANE_API_KEY = '<runtime-key-for-this-session>'
& $tc doctor --profile lnwjud --explain
if ($LASTEXITCODE -ne 0) { throw 'tunnel-client doctor failed' }
& $tc run --profile lnwjud
```

Keep this process and the child lnwjud.exe --mcp-stdio process alive while
ChatGPT is using the connector. The optional local admin UI at /ui shows
readiness and channel health.

### 6. Verify the command locally

```powershell
$lnwjud = 'C:/Users/<WindowsUser>/AppData/Local/Programs/lnwjud/lnwjud.exe'
Test-Path $lnwjud
Test-Path $tc
```

If doctor reports a missing executable, fix the YAML path. If launching the
command opens the dashboard instead of holding a stdio MCP process, install a
stdio-capable package. Do not solve that error with shell: true or an
unrestricted PowerShell command string.

## Start the tunnel automatically at Windows logon

A scheduled task is more reliable than leaving a terminal open. This example
stores the runtime key encrypted with the current Windows user's DPAPI; the key
is not written in plain text to the profile or task command line.

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
$tc = 'C:/Users/<WindowsUser>/Downloads/tunnel/tunnel-client.exe'
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
$runner = 'C:/Users/<WindowsUser>/Downloads/tunnel/start-lnwjud-tunnel.ps1'
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

After changing tool metadata or restarting the tunnel, refresh the connector and
start a new chat.

## Complete MCP tool catalog

The current catalog contains 28 workspace/project tools, 7 local desktop
capability tools, and 5 skills/MCP bridge meta-tools (40 total).

### Workspace and project inspection

| Tool | Permission | What it does |
| --- | --- | --- |
| workspace_info | READ | Returns display name, canonical root, project profile, and Git summary |
| workspace_tree | READ | Returns a bounded directory tree; heavy folders such as .git, node_modules, dist, and coverage are ignored |
| project_snapshot | READ | Returns profile, Git counts, top-level tree, managed processes, and recent error summaries without source contents |

### Optional machine-root discovery extension

Some stdio-capable builds include a guarded machine-access extension. When the
server advertises these names in its MCP tools/list response, use them before
the workspace tools above:

| Tool | Permission | Input | What it does |
| --- | --- | --- | --- |
| workspace_list | READ | Empty object | Lists registered machine roots and project workspaces with availability |
| workspace_register | WRITE | parentWorkspaceId, path, optional displayName | Registers an existing project directory below an approved machine root |

The extension still validates the parent ID, canonical path, reparse points,
and secret policy. Machine-root discovery is limited to drive **E:** (`E:\`);
other fixed drives are not registered and existing non-E machine roots are
pruned on startup. It does not turn a path into an unrestricted filesystem
handle. If your build does not advertise these two tools, register the
workspace from the desktop dashboard and use its workspace ID.

### Files and search

| Tool | Permission | What it does |
| --- | --- | --- |
| read_file | READ | Reads bounded UTF-8 text from one workspace file; binary files are rejected |
| read_files | READ | Reads up to 20 bounded workspace files with a total output cap |
| search_files | READ | Searches workspace filenames with bounded results |
| search_text | READ | Searches text through direct ripgrep arguments; no shell string is built |
| write_file | WRITE | Writes UTF-8 text and checkpoints an existing target before overwrite |
| apply_patch | WRITE | Validates and atomically applies bounded file changes |
| move_file | WRITE | Moves a file within one authorized workspace |
| delete_file | DANGEROUS | Deletes one file or an empty directory; recursive deletion is not exposed |

Default-denied secrets include .env (except .env.example), .env.*, *.pem,
*.key, id_rsa*, id_ed25519*, .ssh/**, .aws/**, and credentials.json.

### Git inspection

| Tool | Permission | What it does |
| --- | --- | --- |
| git_status | READ | Parsed read-only working-tree status |
| git_diff | READ | Bounded read-only diff with truncation metadata |
| git_log | READ | Bounded structured commit history |

No MCP tool automatically commits changes. Destructive reset/clean operations
are not exposed.

### Processes and project commands

| Tool | Permission | What it does |
| --- | --- | --- |
| process_start | EXECUTE | Starts one policy-checked executable with separate arguments and returns a process handle |
| process_status | READ | Reads state for an owned process handle |
| process_logs | READ | Reads bounded stdout/stderr records with sequence numbers |
| process_stop | EXECUTE | Stops an owned managed process tree |
| project_dev | EXECUTE | Runs the detected project development command |
| project_test | EXECUTE | Runs the detected project test command |
| project_lint | EXECUTE | Runs the detected project lint command |
| project_typecheck | EXECUTE | Runs the detected project type-check command |
| project_build | EXECUTE | Runs the detected project build command |

process_start uses an executable plus an args array with shell false. It is not
PowerShell, CMD, or a free-form shell parser. Project commands come from the
detected ProjectProfile.

### Local Codex delegation

| Tool | Permission | What it does |
| --- | --- | --- |
| codex_status | READ | Reports local Codex installation/version/capabilities without credential inspection |
| codex_run | EXECUTE | Delegates an instruction to local Codex and returns codexTaskId |
| codex_task_status | READ | Reads state for an owned Codex task |
| codex_task_logs | READ | Reads bounded logs for an owned Codex task |
| codex_stop | EXECUTE | Stops only a Codex task launched by lnwjud |

Typical flow: codex_run → poll task status/logs → inspect git_diff → run checks.

### Local desktop capabilities

| Tool | Permission | Actions |
| --- | --- | --- |
| shell | EXECUTE | Direct executable invocation; foreground/background tasks, status, wait, logs, result, cancel, resume, approvals, timeouts, dry-run, and bounded output |
| dom_cdp | DANGEROUS | Managed Chrome launch/status/tabs/navigation/JavaScript/DOM query/click/type/wait/screenshot |
| accessibility | DANGEROUS | Windows UI Automation for app/window discovery, element inspection, focus, values, clicks, selections, and menus |
| input_event | DANGEROUS | Text, paste, keys/hotkeys, pointer movement, clicks, drag, scroll, button state, release-all, and sequences |
| vision | READ | Local display/region/window PNG capture and optional OCR; never clicks or types |
| window | DANGEROUS | Native window list/inspect/activate/close/minimize/maximize/restore/move/resize/frame operations |
| health | READ | Per-backend diagnostics with no input/browser/window side effects |

Use dom_cdp for web pages, accessibility for semantic native controls, and
input_event only as a low-level fallback. shell remains direct executable
invocation, not an unrestricted PowerShell or CMD gateway.

### Skills and local MCP bridge

These meta-tools discover local agent skills and other MCP servers on the
machine (Cursor `mcp.json`, Claude Desktop config, plus lnwjud settings). They
do not flatten every child tool into the lnwjud catalog. Default mode enables
all discovered servers except lnwjud itself (recursion guard).

| Tool | Permission | What it does |
| --- | --- | --- |
| skills_list | DANGEROUS | Lists discovered skills from Cursor/Claude/Agents/workspace roots |
| skills_read | DANGEROUS | Reads a skill `SKILL.md` or a relative file inside that skill folder |
| mcp_list | DANGEROUS | Lists discovered local MCP servers and enabled/connected state |
| mcp_describe | DANGEROUS | Connects if needed and returns child tool names/schemas |
| mcp_call | DANGEROUS | Forwards a tool call to a child MCP server |

**Security note:** These tools are available on every transport, including the
Secure MCP Tunnel. Combined with the forced full permission profile, a remote
ChatGPT session can invoke local desktop/browser MCP servers if lnwjud and the
tunnel are running. Disable individual servers through the lnwjud `extensions`
settings JSON (`disabledServers`) when needed.

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
[docs/mcp/MCP_TOOL_CATALOG.md](docs/mcp/MCP_TOOL_CATALOG.md) and
packages/mcp-server/src/tools/schemas.ts.

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
executable, use process_start with separate arguments and a workspace-relative
cwd. Save the returned process ID and use process_status, process_logs, and
process_stop.

### Delegate to Codex

Run codex_status first. If available, use codex_run, poll the returned task ID,
inspect the logs, and review git_diff yourself. Do not ask it to bypass policy
or read secret files.

### Automate Windows applications

Use health for diagnostics; dom_cdp for managed web pages; accessibility for
native controls; vision for screen/OCR fallback; input_event only when the
higher-level APIs cannot operate; and window for native window management.

## Security and operational model

### Transport

The local HTTP MCP endpoint binds to 127.0.0.1. Stdio is a child-process
transport. Secure MCP Tunnel is an outbound HTTPS bridge, not an inbound public
listener.

### Filesystem

Every client path passes the workspace path guard. It resolves relative paths,
rejects NUL bytes/traversal, handles non-existing write targets through their
nearest existing ancestor, rejects junction/symlink/reparse-point escapes, and
applies the secret policy after canonicalization.

### Process execution

The default process API is equivalent to:

```text
spawn(executable, args, { shell: false })
```

Arguments are not concatenated into a shell command. Processes have owned
handles, bounded logs, timeout/cancel support, and Windows process-tree
termination. Normal execution is as the current user; administrator privilege
requests are denied by the capability backend.

### Audit and recovery

Audit records contain timestamp, actor/client, tool/action, workspace ID,
sanitized argument summary, permission decision, result code, and duration.
They do not persist full prompts, environment variables, bearer tokens, API
keys, passwords, or unlimited terminal history. Existing-file writes checkpoint
before overwrite where supported.

### Explicitly unavailable tools

These are intentionally not in the core catalog:

```text
run_shell
powershell
cmd
git_reset
git_clean
kill_pid
read_arbitrary_path
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| mcp-command preflight shows C:Users... | Use forward slashes in the YAML command path |
| profile_load says the YAML file is missing | Run init with profile lnwjud and verify %APPDATA%/tunnel-client/lnwjud.yaml |
| doctor rejects the key | Use a runtime key with Tunnels Read + Use; do not substitute an Admin or unrelated project key |
| Tunnel is not listed in ChatGPT | Associate it with the target ChatGPT workspace and verify Tunnels Read + Use |
| ChatGPT reports no tools | Check doctor, the local stdio command, tunnel health, connector refresh, and a new chat |
| The desktop window opens when the tunnel starts | A GUI-only executable was configured; install/use the stdio launcher |
| WORKSPACE_NOT_FOUND | Use the exact registered workspace ID, not a path or display name |
| PATH_OUTSIDE_WORKSPACE | Register/select the correct root and use a workspace-relative path |
| A secret file is denied | Use a non-secret example file or an approved host-side secret workflow |
| process_start refuses PowerShell/CMD | Shell hosts are blocked; use project_* or a specific approved executable/args |
| Child process windows are visible | This is expected for the current visible-window Windows build; use handles/logs to manage them |
| codex_status is unavailable | Install Codex or continue with process_* and project_*; lnwjud does not inspect credentials |
| Tunnel disconnects with context canceled | Keep one runner alive; avoid a competing manual process and scheduled task |
| ChatGPT advertises old tools | Restart server/tunnel, Refresh the connector, and start a new conversation |

For ambiguous failures, call health locally and run tunnel-client doctor
--explain before restarting both layers.

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
docs/                  Architecture, development, MCP, testing, and release docs
```

All entrypoints are intended to call the same application services so that
validation and permissions remain consistent.

## Further reading

### Project documentation

- [MCP tool catalog](docs/mcp/MCP_TOOL_CATALOG.md)
- [Architecture](docs/architecture/ARCHITECTURE.md)
- [Local desktop development](docs/development/LOCAL_DESKTOP.md)
- [Codex integration](docs/development/CODEX_INTEGRATION.md)
- [Windows packaging](docs/development/PACKAGING_WINDOWS.md)
- [Test strategy](docs/testing/TEST_STRATEGY.md)
- [Security and architecture design](docs/superpowers/specs/2026-08-10-lnwjud-design.md)

### Official OpenAI documentation

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect and test a plugin in ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [ChatGPT MCP and Codex configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
- [OpenAI Platform API keys](https://platform.openai.com/settings/organization/api-keys)
- [OpenAI tunnel-client releases](https://github.com/openai/tunnel-client)

## License

See the repository licensing files and release metadata for applicable terms.
