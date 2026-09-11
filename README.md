<p align="center">
  <img src="assets/logo/logo-256x256.png" width="160" alt="lnwjud logo" />
</p>

<h1 align="center">lnwjud</h1>

<p align="center">
  <strong>Cross-platform local AI-agent runtime and MCP gateway</strong><br />
  <em>233 total tool definitions for local files, Git, processes, Windows automation, WSL, browser control, durable goal continuation, indexing, observability, and extensibility; 226 are advertised by default and all 233 when Codex delegation plus Agent Swarm is enabled.</em>
</p>

<p align="center">
  <em>อ่านที่เหลือใน Readme ได้เลยครับ ติดปัญหาทักมาได้ใน <a href="https://url.in.th/rEZiG"><strong>Line</strong></a> ได้ตลอดครับ / กำลังพัฒนาให้เรื่อยๆครับ ท่านที่ถามหาช่องสนับสนุนค่ากาแฟ แปะลิงก์ไว้ให้แล้วครับ ขอบคุณครับ — <a href="https://easydonate.app/abcz"><strong>Donate</strong></a></em>
</p>

<p align="center">
  <a href="https://github.com/engasnm111/lnwjud/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/engasnm111/lnwjud" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4" />
  <img alt="Node" src="https://img.shields.io/badge/Node.js-24.x-339933" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-233%20tools-6f42c1" />
</p>

---

## Current version: v4.62.0

`v4.62.0` is the current source/release-candidate version. The latest public build is always available from [GitHub Releases](https://github.com/engasnm111/lnwjud/releases/latest). Development artifacts from `dev` are for testing before the public release is published.

### What's new in v4.62.0

- **Image payload delivery:** native Vision captures now return the screenshot as first-class MCP `image` content without duplicating the full Base64 payload into text/structured metadata, preventing successful captures from being lost behind oversized tool-result JSON.
- **Image integrity guard:** Windows Vision validates the encoded PNG before returning it and attaches byte-length/SHA-256 metadata; the MCP result mapper rejects truncated, malformed, dimension-mismatched, or checksum-mismatched image payloads instead of silently handing a corrupted image to the model.
- **Stable search during live refresh:** Work Log and Live Logs now freeze workspace metadata together with the visible log snapshot, so background dashboard polling cannot restart full-detail search or flash between results, loading, and empty states while a query is active. New activity resumes when search is cleared.
- **External MCP image passthrough:** `mcp_call` now preserves child MCP `image` and `text` content blocks instead of flattening the child `CallToolResult` into JSON text, so screenshots from Serena/custom MCP servers can reach the model as images.
- **Window capture targeting:** `vision:capture_window` now accepts natural `app.name` selectors, prefers a visible non-minimized matching HWND when apps expose several helper windows, and reports minimized/hidden-window states directly instead of collapsing them into generic `Operation failed` errors.
- **Manual Tunnel stop precedence:** an explicit **Stop Tunnel** persists the desired stopped state and now stays visually stopped even when an external liveness probe is temporarily unverifiable; Auto Reconnect does not override that operator stop, while the next explicit Start still fails closed if duplicate-process liveness cannot be proven.
- **Calmer Tunnel startup UX:** transient managed-runtime readiness retries stay internal while the Home card simply shows the normal starting state; only genuine Tunnel failures are surfaced as red alerts.
- **Zero-click ChatGPT OAuth:** Business custom apps using supported `chatgpt.com` OAuth callbacks—including newly created Plugin/App callbacks shaped as `/connector/oauth/<redirect_id>`—complete DCR + Authorization Code + PKCE through a one-time browser handoff to an ephemeral `127.0.0.1` Desktop approval listener, so workspace members press **Connect** without copying a PIN. The public gateway never grants trust from the callback URI alone; the 6-digit PIN remains only as a fail-closed fallback for non-ChatGPT OAuth clients.
- **Simpler Home UX:** Home now presents one **ChatGPT Connection** area with Remote MCP OAuth as the primary path and Secure MCP Tunnel as an advanced option, moves Desktop Agent stop/restart/incident actions behind an overflow menu, labels the sidebar **Desktop Agent · Windows/macOS/Linux**, and removes the redundant `MODE / WORK` status card.
- **Stable Remote MCP public URL:** ngrok Free already provides an assigned development domain. lnwjud now remembers the first successful HTTPS origin in encrypted Remote MCP state and reuses that origin through ngrok `--url` on later starts/updates, refusing to silently switch the ChatGPT endpoint if it drifts. Users do not need to buy/register their own domain; custom domains remain optional, and re-saving the ngrok authtoken intentionally resets the remembered origin for account/domain changes.
- **Secure Tunnel multi-chat headroom:** one lnwjud Desktop + one Secure Tunnel can serve multiple simultaneous ChatGPT chats without creating a profile per chat. v4.62.0 raises the bundled tunnel transport's active MCP-request allowance from tunnel-client's default 10 to 32 and adds a real 3-session/12-request concurrency regression. Multi-host routing is separate: Mac/Windows hosts that must be independently selectable should use distinct Tunnel IDs/ChatGPT connections because replicas sharing one Tunnel ID consume queued work from whichever host polls first.
- **macOS 26 / Apple silicon launch fix:** community ad-hoc packages now normalize Electron's nested frameworks/helpers to the same ad-hoc signing identity before sealing the app, and target-native verification rejects any mixed ad-hoc/certificate Team ID state that newer dyld versions refuse to load.
- **Regression coverage:** mapper, External MCP bridge, MCP HTTP transport, and Windows native bridge tests cover image delivery and reliable window targeting.

### Historical: What's new in v4.61.0

- **Stable log search and pause:** Work Log and every Live Logs tab freeze the visible feed while a search is active, so newly arriving events cannot jump into or reorder the result list while you type or inspect matches. Clearing search resumes the current live feed. Live Logs **Pause** now freezes the feed itself, and **Follow** resumes only when no search is holding the snapshot.
- **Durable background-task lifecycle:** shell tasks finalize from the direct command's terminal state instead of being stranded by detached descendants that keep inherited stdio handles open.
- **External MCP lifecycle hardening:** pending child connections are fenced during shutdown, so a late Serena/custom MCP connection cannot resurrect a session after the session manager has closed.
- **Windows and WSL correctness:** Windows Event Log runtime-contract checks use deterministic runtime evidence, while WSL translates supported Windows working directories before Linux execution.
- **Persistence and diagnostics:** secret recovery, SQLite close ownership, tunnel restart/terminal handling, Doctor applicability, and bounded/path-guarded Git diff behavior are hardened for the release.
- **External MCP compatibility:** child MCP servers auto-negotiate their protocol version, covering legacy/2025-era servers such as Serena as well as current MCP `2026-07-28`, while lnwjud's own inbound MCP contract remains unchanged. External MCP definitions saved in Settings are applied live, so adding or changing Serena/custom servers does not require restarting lnwjud.
- **Cross-platform hardening:** Windows, macOS, and Linux now use explicit host/architecture capability gates instead of Windows-shaped fallbacks. Unsupported OS/architecture combinations fail closed.
- **Native Ponytail coding policy:** optional `OFF / LITE / FULL / ULTRA` modes default to OFF, resolve `Current Goal > Workspace > Global`, and use exact bundled Ponytail skills rather than relying on discovery ranking. Active modes require the exact bundled primary skill before code mutation; FULL/ULTRA durable coding goals additionally require a fresh bundled Ponytail review before completion. Full Bypass does not bypass this correctness gate, while explicit session suppression remains available without changing persisted policy.
- **macOS package verification:** release checks stage the app from the actual DMG, launch it through macOS LaunchServices, verify nested code signing, and distinguish Developer ID Team-ID requirements from development ad-hoc signing.
- **Runtime dependencies:** target-native assets are selected by exact `(platform, architecture)` tuples. Current pins include OpenAI `tunnel-client 0.0.14`, `ripgrep 15.2.0`, and Windows Poppler `26.07.0-0`, with checksum/provenance/version checks before packaging.
- **Remote MCP / ngrok:** ngrok discovery now works across Windows, macOS, and Linux. Automatic installation is shown only when the host has a supported installer path; unsupported installer actions are hidden instead of pretending they work.
- **PDF providers:** PDF tooling can use a configured native `pdftotext` where supported; the bundled Poppler auto-installer remains Windows x64-only and is hidden on unsupported hosts.
- **Recovery and persistence:** MCP settings, backup/checkpoint/recovery paths, secret-storage boundaries, tunnel state, cross-host restore metadata, and data-root selection were audited for Windows/macOS/Linux semantics.
- **Unified timestamps:** Thai UI uses Bangkok time with 24-hour display; English uses the host timezone with AM/PM presentation, while machine timestamps remain absolute internally.
- **Responsiveness:** heavy ripgrep output and Live Log traffic are bounded/batched to reduce Electron `Not Responding` hangs and runaway memory churn.
- **Release verification:** v4.61.0 is gated by full workspace tests, Electron acceptance/E2E, packaging and release-gate suites, plus exact-commit target-native Windows/macOS/Linux CI before tagging.

> Public `v4.61.0` should be tagged only after the exact-main Windows/macOS/Linux release matrix, SHA-scoped artifacts, and packaged-app smoke checks are green for the exact commit.

## Install

### Windows 10 / 11

1. Open [GitHub Releases](https://github.com/engasnm111/lnwjud/releases/latest).
2. Download `lnwjud-Setup-<version>.exe` for the normal installer, or `lnwjud-Portable-<version>.exe` if you prefer a portable executable.
3. Launch lnwjud, add the project/workspace you want to use, then configure the MCP connection method you need.

Community Windows artifacts may be unsigned when production code-signing credentials are not configured. Release verification still checks the declared signing mode, SHA-256 manifests, runtime provenance, and packaged-app smoke evidence; verify the release assets if Windows shows an unknown-publisher warning.

Windows-only features such as WSL, Registry, Windows Sandbox, Windows OCR and Outlook/COM remain available only where the Windows provider is supported.

### macOS 13+

Download the artifact that matches the Mac architecture (`arm64` for Apple silicon or `x64` for Intel). Do not swap architectures just because both filenames contain the word “Mac”. Computers remain unusually literal about this.

See [Install lnwjud on macOS](docs/INSTALL_MACOS.md) for DMG/ZIP installation, permissions, MCP launcher paths, Gatekeeper/signing expectations, and troubleshooting.

### Linux

Choose the release artifact that matches the Linux architecture and package type. Ubuntu 24.04 LTS x64 is the primary Linux release target; arm64 remains architecture-specific and evidence-gated.

See [Install lnwjud on Linux](docs/INSTALL_LINUX.md) for AppImage/DEB installation, Wayland/X11 behavior, secure storage, MCP, and platform limits.

### Local data vs workspace metadata

Installed lnwjud keeps per-user runtime data outside your source repository: `%APPDATA%\lnwjud` on Windows, `~/Library/Application Support/lnwjud` on macOS, and `$XDG_DATA_HOME/lnwjud` (or `~/.local/share/lnwjud`) on Linux unless `LNWJUD_DATA_PATH` is explicitly set. A workspace may contain `.lnwjud/project-profile.json` for project-scoped policy such as Ponytail mode; `.lnwjud/` is local metadata and is ignored by this repository.

## What can lnwjud do?

lnwjud exposes **233 first-party tool definitions** through one local runtime and MCP gateway. The default advertised set is 226; the remaining Codex delegation and Agent Swarm definitions are opt-in.

| Area | Examples |
| --- | --- |
| Workspace & files | read/search/edit files, paging, full scans, project indexing, recovery trash |
| Git | status, diff, history, blame, guarded Git mutations |
| Processes | shell, managed processes, durable background tasks, logs, cancellation |
| MCP | local HTTP/stdio MCP, External MCP discovery/describe/call, live tool availability |
| Development | test, lint, typecheck, build, affected-test context, Codex integration |
| Browser | managed Chrome/CDP, DOM inspection, Set-of-Marks, screenshots |
| Recovery | backups, checkpoints, restore, crash/session recovery, durable-goal state |
| Observability | Work Log, Live Logs, Doctor, incident reports, trace/audit metadata |
| Native capabilities | UI/input/media/Office/scheduler providers when the current OS supports them |
| Windows-specific | WSL, Registry, Windows Sandbox, Windows Event Log/OCR, Outlook/COM |

For the complete generated catalog, see [MCP Tool Catalog](docs/mcp/MCP_TOOL_CATALOG.md). For the broader capability explanation, see [lnwjud capabilities](docs/LNWJUD_CAPABILITIES.md).

## Platform compatibility

lnwjud composes providers for the detected host instead of instantiating a Windows provider everywhere and hoping for the best.

| Feature | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Core MCP / files / Git / processes | ✅ | ✅ | ✅ |
| External MCP | ✅ | ✅ | ✅ |
| OpenAI Secure MCP Tunnel client | target-native | target-native | target-native |
| Remote MCP with ngrok | ✅ | ✅ | ✅ |
| Managed browser / CDP | dependency-gated | dependency-gated | dependency-gated |
| Native PDF text provider | dependency-gated | dependency-gated | dependency-gated |
| Automatic Poppler install | Windows x64 | hidden | hidden |
| WSL / Registry / Windows Sandbox | ✅ | unsupported | unsupported |
| Outlook COM | ✅ | unsupported | unsupported |

The authoritative matrix is [Native platform support contract](docs/architecture/PLATFORM_SUPPORT.md).

## MCP connection choices

- **Local MCP clients:** use the packaged stdio launcher or Desktop loopback MCP endpoint.
- **Remote MCP via ngrok + OAuth:** useful for a remote ChatGPT/MCP client when you want lnwjud to run the protected OAuth gateway and ngrok runtime.
- **OpenAI Secure MCP Tunnel:** outbound-only OpenAI tunnel path using the verified target-native bundled `tunnel-client`. One lnwjud tunnel endpoint is intended to serve multiple simultaneous ChatGPT chats/workspaces; do not create one tunnel/profile per chat. v4.62.0 explicitly gives the tunnel transport 32 active MCP-request slots so normal multi-chat tool fan-out does not hit tunnel-client's lower default ceiling. If several physical lnwjud hosts (for example Mac + Windows) must be independently selectable, give each host a distinct Tunnel ID/ChatGPT connection: HTTP replicas sharing one Tunnel ID are work-sharing replicas, so a request goes to whichever replica polls it first rather than to a chat-selected host.
- **External MCP servers:** lnwjud can discover supported Cursor/Claude Desktop/custom MCP definitions and keep child MCP servers separate from the first-party catalog.

See the [Thai usage guide](docs/USAGE_TH.md) and [full expanded README](FULL_README.md) for the long-form setup and architecture notes.

## Documentation

- [Full expanded README / historical detail](FULL_README.md)
- [คู่มือใช้งานภาษาไทย](docs/USAGE_TH.md)
- [macOS installation](docs/INSTALL_MACOS.md)
- [Linux installation](docs/INSTALL_LINUX.md)
- [Platform support matrix](docs/architecture/PLATFORM_SUPPORT.md)
- [Complete capabilities](docs/LNWJUD_CAPABILITIES.md)
- [MCP Tool Catalog](docs/mcp/MCP_TOOL_CATALOG.md)
- [Tool contract](docs/architecture/TOOL_CONTRACT.md)
- [Release process](docs/development/RELEASE_PROCESS.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Security boundary

lnwjud is intentionally powerful because it operates on the local machine. Tool availability does **not** bypass Active Project scope, permission policy, mutation approval, recovery, host OS permissions, or platform capability gates. Unknown/unsupported platforms and missing native providers should fail closed rather than silently substituting a different OS implementation.

## Community

ติดปัญหา อยากแชร์วิธีใช้ หรือเจอบัค สามารถเข้ากลุ่มพูดคุยได้ที่ [Line](https://url.in.th/rEZiG).

## License

[MIT](LICENSE)
