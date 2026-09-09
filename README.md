<p align="center">
  <img src="assets/logo/logo-256x256.png" width="160" alt="lnwjud logo" />
</p>

<h1 align="center">lnwjud</h1>

<p align="center">
  <strong>Cross-platform local AI-agent runtime and MCP gateway</strong><br />
  <em>232 total tool definitions for local files, Git, processes, Windows automation, WSL, browser control, durable goal continuation, indexing, observability, and extensibility; 225 are advertised by default and all 232 when Codex delegation plus Agent Swarm is enabled.</em>
</p>

<p align="center">
  <em>อ่านที่เหลือใน Readme ได้เลยครับ ติดปัญหาทักมาได้ใน FB: Adisorn NM ได้ตลอดครับ / กำลังพัฒนาให้เรื่อยๆครับ ท่านที่ถามหาช่องสนับสนุนค่ากาแฟ แปะลิงก์ไว้ให้แล้วครับ ขอบคุณครับ — <a href="https://easydonate.app/abcz"><strong>Donate</strong></a> · <a href="https://url.in.th/rEZiG"><strong>Line</strong></a></em>
</p>

<p align="center">
  <a href="https://github.com/engasnm111/lnwjud/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/engasnm111/lnwjud" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4" />
  <img alt="Node" src="https://img.shields.io/badge/Node.js-24.x-339933" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-232%20tools-6f42c1" />
</p>

---

## Current version: v4.60.0

`v4.60.0` is the current source/release-candidate version. The latest public build is always available from [GitHub Releases](https://github.com/engasnm111/lnwjud/releases/latest). Development artifacts from `dev` are for testing before the public release is published.

### What's new in v4.60.0

- **External MCP compatibility:** child MCP servers auto-negotiate their protocol version, covering legacy/2025-era servers such as Serena as well as current MCP `2026-07-28`, while lnwjud's own inbound MCP contract remains unchanged.
- **Cross-platform hardening:** Windows, macOS, and Linux now use explicit host/architecture capability gates instead of Windows-shaped fallbacks. Unsupported OS/architecture combinations fail closed.
- **macOS package verification:** release checks stage the app from the actual DMG, launch it through macOS LaunchServices, verify nested code signing, and distinguish Developer ID Team-ID requirements from development ad-hoc signing.
- **Runtime dependencies:** target-native assets are selected by exact `(platform, architecture)` tuples. Current pins include OpenAI `tunnel-client 0.0.14`, `ripgrep 15.2.0`, and Windows Poppler `26.07.0-0`, with checksum/provenance/version checks before packaging.
- **Remote MCP / ngrok:** ngrok discovery now works across Windows, macOS, and Linux. Automatic installation is shown only when the host has a supported installer path; unsupported installer actions are hidden instead of pretending they work.
- **PDF providers:** PDF tooling can use a configured native `pdftotext` where supported; the bundled Poppler auto-installer remains Windows x64-only and is hidden on unsupported hosts.
- **Recovery and persistence:** MCP settings, backup/checkpoint/recovery paths, secret-storage boundaries, tunnel state, cross-host restore metadata, and data-root selection were audited for Windows/macOS/Linux semantics.
- **Unified timestamps:** Thai UI uses Bangkok time with 24-hour display; English uses the host timezone with AM/PM presentation, while machine timestamps remain absolute internally.
- **Responsiveness:** heavy ripgrep output and Live Log traffic are bounded/batched to reduce Electron `Not Responding` hangs and runaway memory churn.
- **Regression coverage:** the release audit now enforces a growing cross-platform scenario baseline (currently 350+ deterministic scenarios) in addition to the full workspace, packaging, release-gate, and native CI suites.

> Public `v4.60.0` should be tagged only after the native Windows/macOS/Linux release matrix and packaged-app smoke checks are green for the exact commit.

## Install

### Windows 10 / 11

1. Open [GitHub Releases](https://github.com/engasnm111/lnwjud/releases/latest).
2. Download `lnwjud-Setup-<version>.exe` for the normal installer, or `lnwjud-Portable-<version>.exe` if you prefer a portable executable.
3. Launch lnwjud, add the project/workspace you want to use, then configure the MCP connection method you need.

Windows-only features such as WSL, Registry, Windows Sandbox, Windows OCR and Outlook/COM remain available only where the Windows provider is supported.

### macOS 13+

Download the artifact that matches the Mac architecture (`arm64` for Apple silicon or `x64` for Intel). Do not swap architectures just because both filenames contain the word “Mac”. Computers remain unusually literal about this.

See [Install lnwjud on macOS](docs/INSTALL_MACOS.md) for DMG/ZIP installation, permissions, MCP launcher paths, Gatekeeper/signing expectations, and troubleshooting.

### Linux

Choose the release artifact that matches the Linux architecture and package type. Ubuntu 24.04 LTS x64 is the primary Linux release target; arm64 remains architecture-specific and evidence-gated.

See [Install lnwjud on Linux](docs/INSTALL_LINUX.md) for AppImage/DEB installation, Wayland/X11 behavior, secure storage, MCP, and platform limits.

## What can lnwjud do?

lnwjud exposes **232 first-party tool definitions** through one local runtime and MCP gateway. The default advertised set is 225; the remaining Codex delegation and Agent Swarm definitions are opt-in.

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
- **OpenAI Secure MCP Tunnel:** outbound-only OpenAI tunnel path using the verified target-native bundled `tunnel-client`.
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

ติดปัญหา อยากแชร์วิธีใช้ หรือเจอบัค สามารถเข้ากลุ่มพูดคุยได้ที่ [Line](https://url.in.th/rEZiG). หากต้องการสนับสนุนค่าใช้จ่ายของโปรเจกต์ ใช้ลิงก์ [Donate](https://easydonate.app/abcz).

## License

[MIT](LICENSE)
