<p align="center">
  <img src="assets/logo/logo-256x256.png" width="160" alt="lnwjud logo" />
</p>

<h1 align="center">lnwjud</h1>

<p align="center">
  <strong>Cross-platform local AI-agent runtime and MCP gateway</strong><br />
  <em>285 total tool definitions for local files, Git, processes, Windows automation, WSL, browser control, durable goal continuation, Engineering Harness, native Goal automation, context capsules, indexing, observability, Office semantic automation, ECC integration, and extensibility; 273 are advertised by default and all 285 when Codex delegation plus Agent Swarm is enabled.</em>
</p>

<p align="center">
  <em>อ่านที่เหลือใน Readme ได้เลยครับ ติดปัญหาทักมาได้ใน <a href="https://url.in.th/rEZiG"><strong>Line</strong></a> ได้ตลอดครับ / กำลังพัฒนาให้เรื่อยๆครับ ท่านที่ถามหาช่องสนับสนุนค่ากาแฟ แปะลิงก์ไว้ให้แล้วครับ ขอบคุณครับ — <a href="https://easydonate.app/abcz"><strong>Donate</strong></a></em>
</p>

<p align="center">
  <a href="https://github.com/engasnm111/lnwjud/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/engasnm111/lnwjud" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4" />
  <img alt="Node" src="https://img.shields.io/badge/Node.js-24.x-339933" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-285%20tools-6f42c1" />
</p>

<h2 align="center">Download lnwjud</h2>
<p align="center">Choose your platform and download the current v5.7.4 release directly.</p>

<table align="center">
  <tr>
    <td align="center" width="33%">
      <a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-Setup-5.7.4.exe">
        <img src="assets/download/download-windows.svg" width="300" alt="Download lnwjud for Windows" />
      </a><br />
      <sub><a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-Portable-5.7.4.exe">Portable x64</a></sub>
    </td>
    <td align="center" width="33%">
      <a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-5.7.4-arm64.dmg">
        <img src="assets/download/download-macos.svg" width="300" alt="Download lnwjud for macOS" />
      </a><br />
      <sub><a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-5.7.4-x64.dmg">Intel x64 DMG</a> · <a href="docs/INSTALL_MACOS.md">Install guide</a></sub>
    </td>
    <td align="center" width="33%">
      <a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-5.7.4-x64.deb">
        <img src="assets/download/download-linux.svg" width="300" alt="Download lnwjud for Linux" />
      </a><br />
      <sub><a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-5.7.4-x64.AppImage">x64 AppImage</a> · <a href="docs/INSTALL_LINUX.md">Other architectures</a></sub>
    </td>
  </tr>
</table>

<p align="center"><a href="https://github.com/engasnm111/lnwjud/releases/latest"><strong>View all release files →</strong></a></p>

---

## Current published version: v5.7.4

## Current source version: v5.8.0

Latest published release: **v5.7.4**. The download buttons above point directly to the v5.7.4 assets. The release was published after the exact tagged main commit passed the target-native release gates.

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

ภาษาไทย: v5.7.3 เน้นแก้ความต่อเนื่องของ Durable Goal/Serena, Linux AppImage, Work Log, Secure MCP Tunnel และ Portable โดยเฉพาะการกลับมาใช้ bundled `tunnel-client` หลังลบ custom path, พร้อมเพิ่มหลักฐาน release แบบ exact-SHA/cross-platform และยังรองรับ community Windows release แบบ unsigned เมื่อไม่มี production certificate โดยต้องผ่าน SHA-256/provenance checks ครบ

### What's new in v5.7.2

- **Git image diff previews:** the Git page can show before/after images at the real `HEAD → Index` and `Index → Working Tree` scopes, including added/deleted images. Preview payloads are bounded to 4 MB per side, with Fit/Actual Size controls and a clear fallback when Chromium cannot decode a particular image format.
- **Engineering Harness settings persist correctly:** the preload bridge now preserves Harness settings, workspace overrides, and diagnostics, so an enabled Harness no longer appears Off after restarting the app while the saved value is still enabled.
- **Engineering tools are discoverable and Goal-aware:** Engineering Harness primitives are exposed through the tool catalog and bind to the active Goal/lease correctly.
- **Safer rich-text typing:** CDP typing uses native `Input.insertText` for ProseMirror/contenteditable targets and verifies that the DOM actually changed instead of reporting a silent no-op as success.
- **Durable Goal progress stays fresh for Watcher:** lnwjud now instructs every connected worker to checkpoint immediately at step/task/blocker/commit/push/CI/package milestones and at least every 10 minutes during sustained work without a natural milestone, while stale superseded Goals should be reconciled instead of remaining active.
- **Secure MCP Tunnel avoids false Windows Error state:** a temporary PowerShell failure while inventorying local tunnel-client processes/listeners is retried as a transient runtime check instead of permanently flipping an otherwise healthy Tunnel to Error; duplicate/unverifiable process identity checks remain fail-closed.

ภาษาไทย: v5.7.2 เพิ่มตัวอย่างรูปก่อน/หลังในหน้า Git, แก้ Engineering Harness ให้จำสถานะเปิดหลังรีสตาร์ต, เปิดเครื่องมือ Engineering ใน catalog ให้ถูกต้อง, ตรวจผลการพิมพ์ ProseMirror/ContentEditable จริงก่อนรายงานว่าสำเร็จ, กำหนดให้ Durable Goal อัปเดต checkpoint ตาม milestone/อย่างน้อยทุก 10 นาทีระหว่างงานต่อเนื่อง เพื่อให้ lnwjud Watcher แสดงสถานะล่าสุดพร้อมปิด Goal ที่ถูกแทนที่ไม่ให้ค้างเป็นงาน active และแก้ Secure MCP Tunnel บน Windows ไม่ให้สถานะหลุดเป็น Error เพียงเพราะคำสั่ง PowerShell ตรวจ process/listener ล้มเหลวชั่วคราว โดยยังคง fail closed เมื่อยืนยัน process ซ้ำหรือ identity ไม่ได้

See the [Thai Engineering Harness guide](docs/USAGE_TH.md#8a-engineering-harness--senior-coding-workflow) for setup and workflow details.

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for previous releases and the complete release history.

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

Installed lnwjud keeps per-user runtime data outside your source repository: `%APPDATA%\lnwjud` on Windows, `~/Library/Application Support/lnwjud` on macOS, and `$XDG_DATA_HOME/lnwjud` (or `~/.local/share/lnwjud`) on Linux unless `LNWJUD_DATA_PATH` is explicitly set. A workspace may contain `.lnwjud/project-profile.json` for project-scoped policy such as Ponytail or Engineering Harness mode/profile; `.lnwjud/` is local metadata and is ignored by this repository.

### Engineering Harness (opt-in)

Engineering Harness is **Off by default**. Enable it in **Settings → Engineering Harness** when you want lnwjud to turn a substantive coding request into a durable, risk-based workflow instead of treating every request the same way.

- **Presets:** Standard, **Senior** (recommended), Strict, or Custom.
- **Scope:** coding projects/tasks by default, with an optional per-workspace On/Off + preset override.
- **Policy precedence:** explicit workspace/project opt-out wins; project policy can strengthen a preset but cannot silently weaken an explicit user opt-out.
- **Durability:** `engineering_start_task` reuses the existing durable Goal authority. Requirement changes increment the Goal intent revision and stale only affected Engineering gates instead of resetting proven work.
- **Evidence:** required checks remain Pending/Running/Failed/Stale until observed evidence satisfies them. Host-observed mechanical checks are not replaced by a model assertion.
- **Enforcement:** first-party development mutations such as guarded file edits, Git, shell/process/project commands, verification, Codex/Agent Swarm and worktree operations require the current `engineeringTask` binding when Harness is active. Existing permission, Active Project, recovery, Full Bypass and rolling `goalLease` rules still apply independently.
- **Advisory boundary:** external `mcp_call`, general Office/web/native-UI routes are not mechanically Engineering-guarded in v5.7.0; their existing security/permission controls remain authoritative.
- **No hidden writes:** project assessment and the Settings project-profile preview do not write repository files, commit, push, deploy, or create a Scheduled Task by themselves.

For the Thai setup and workflow guide, see [docs/USAGE_TH.md](docs/USAGE_TH.md#8a-engineering-harness--senior-coding-workflow).

## What can lnwjud do?

lnwjud exposes **285 tool definitions** through one local runtime and MCP gateway. The default advertised set is 273; all 285 are available when Codex delegation plus Agent Swarm is enabled.

| Area | Examples |
| --- | --- |
| Workspace & files | read/search/edit files, paging, full scans, project indexing, recovery trash |
| Git | status, diff, history, blame, guarded Git mutations |
| Processes | shell, managed processes, durable background tasks, Goal-owned native automation, logs, cancellation |
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

- **Local MCP:** use the packaged stdio launcher or Desktop loopback MCP endpoint directly. The Local transport starts the local listener without ngrok, a public URL, or Remote MCP OAuth.
- **Remote MCP via ngrok + OAuth:** remains the default/backward-compatible Remote MCP transport. lnwjud owns the protected loopback OAuth gateway and ngrok child runtime.
- **Remote MCP via Cloudflare:** opt-in for a Cloudflare Tunnel/reverse proxy that you manage. lnwjud provides a stable local OAuth-gateway target and verifies the configured public HTTPS origin; it does not claim to create or manage the Cloudflare tunnel.
- **Remote MCP via Custom URL:** opt-in for another externally managed HTTPS reverse proxy. No ngrok token/install is required; the public origin must route to the stable local protected gateway.
- **OpenAI Secure MCP Tunnel:** separate outbound-only OpenAI tunnel path using the verified target-native bundled `tunnel-client`. One lnwjud tunnel endpoint is intended to serve multiple simultaneous ChatGPT chats/workspaces; do not create one tunnel/profile per chat. v4.62.0 explicitly gives the tunnel transport 32 active MCP-request slots so normal multi-chat tool fan-out does not hit tunnel-client's lower default ceiling. If several physical lnwjud hosts (for example Mac + Windows) must be independently selectable, give each host a distinct Tunnel ID/ChatGPT connection: HTTP replicas sharing one Tunnel ID are work-sharing replicas, so a request goes to whichever replica polls it first rather than to a chat-selected host.
- **External MCP servers:** lnwjud can discover supported Cursor/Claude Desktop/custom MCP definitions and keep child MCP servers separate from the first-party catalog.

See the [Thai usage guide](docs/USAGE_TH.md) and [full expanded README](FULL_README.md) for the long-form setup and architecture notes.

## Durable goals + scheduled continuation / Goal แบบทำงานต่อเนื่อง

lnwjud can keep long-running work alive across chat turns with a **durable goal** plus the bundled `lnwjud-scheduled-continuation` skill. The intended model is simple: one stable goal, one recurring Native ChatGPT Scheduled Task, periodic checkpoints, and an explicit finish only when the work is genuinely complete.

lnwjud สามารถทำงานยาวข้ามหลายรอบแชทได้ด้วย **durable goal** ร่วมกับสกิล `lnwjud-scheduled-continuation` แนวทางที่ควรใช้คือ: 1 งาน = 1 goal ที่ใช้ `goalKey` เดิม, มี Native ChatGPT Scheduled Task แบบ recurring เพียง 1 ตัว, บันทึก checkpoint ระหว่างทาง และปิด goal เมื่อทุกอย่างเสร็จจริงเท่านั้น

The scheduled continuation should be a **Native ChatGPT Scheduled Task running in cloud mode every 1 hour**. It is a watchdog that wakes the workflow back up; the durable goal remains the source of truth for plan state, progress, blockers, evidence, and tracked background tasks. Do not create a new goal or timer on every wake.

ตัว Scheduled Task ควรเป็น **Native ChatGPT Scheduled Task ที่รันบน cloud ทุก 1 ชั่วโมง** มีหน้าที่ปลุกงานกลับมาทำต่อเท่านั้น ส่วนสถานะจริงของงานให้ยึด durable goal เป็นหลัก ห้ามสร้าง goal ใหม่หรือตัวตั้งเวลาใหม่ทุกครั้งที่ถูกปลุก

### Recommended prompt — English

```text
@lnwjud

Workspace:
C:\path\to\my-project

Continue this task until it is genuinely complete. Do not stop only because the current chat turn ends.

- Use the lnwjud-scheduled-continuation skill.
- Create or resume the same durable goal using one stable goalKey. Treat that Durable Goal as the authoritative task state and never create duplicate goals for the same job. When plan or step progress changes, use update_goal_plan so the Watcher-visible plan stays current.
- Create exactly one recurring Native ChatGPT Scheduled Task, run it in cloud mode every 1 hour, and reuse that same scheduled continuation for this goal.
- Checkpoint immediately after every meaningful milestone, and refresh active progress at least every 10 minutes when sustained work has no natural milestone. Persist current phase, step status, next action, blockers, evidence, tracked background tasks, and reconstruction-grade resumeContext: changed files, exact commands/results, decisions, failed attempts, pending validation, resume prerequisites, state facts, and artifacts. A checkpoint records progress; it is not a reason to stop useful work.
- When the scheduled task wakes the workflow, claim the continuation for the same goal and resume from the latest checkpoint instead of starting over.
- If CI, build, test, deployment, or another process is still running, keep tracking the same task until its terminal result is known. If a failure is fixable, inspect the exact failure, diagnose it, repair it, and run the relevant validation in the same turn instead of stopping at a status report.
- Do not finish the goal while any planned step, acceptance criterion, required Engineering gate/review finding, blocker, or blocking task remains unresolved. Reconcile stale duplicate/superseded/abandoned goals instead of leaving finished work Active in Watcher.
- When the work is truly complete, cancel the scheduled continuation, make the exact Native ChatGPT Scheduled Task non-runnable, then call finish_goal with final evidence and read get_goal to confirm a terminal state before reporting completion.
```

### Prompt แนะนำ — ภาษาไทย

```text
@lnwjud

Workspace:
C:\path\to\my-project

ทำงานนี้ต่อเนื่องจนเสร็จจริง ห้ามหยุดกลางทางเพียงเพราะแชทจบรอบ

- ใช้สกิล lnwjud-scheduled-continuation
- สร้างหรือ resume durable goal เดิมด้วย goalKey ที่คงที่ และให้ Durable Goal เป็น state หลักของงาน ห้ามสร้าง goal ซ้ำสำหรับงานเดียวกัน เมื่อ plan หรือสถานะ step เปลี่ยน ให้ใช้ update_goal_plan เพื่อให้ plan/progress ที่ Watcher แสดงเป็นปัจจุบัน
- สร้าง Native ChatGPT Scheduled Task แบบ recurring เพียง 1 ตัว ให้รันบน cloud ทุก 1 ชั่วโมง และใช้ scheduled continuation ตัวเดิมกับ goal นี้ไปตลอด
- หลัง milestone สำคัญทุกครั้งให้ checkpoint ทันที และถ้าทำงานต่อเนื่องโดยไม่มี milestone ตามธรรมชาติให้ refresh อย่างน้อยทุก 10 นาที โดยบันทึก current phase, step status, next action, blockers, evidence, tracked background task และ resumeContext ที่สร้างงานต่อได้จริง เช่นไฟล์ที่เปลี่ยน, คำสั่งและผลลัพธ์, การตัดสินใจ, failed attempts, pending validation, prerequisites, state facts และ artifacts การ checkpoint คือการบันทึก progress ไม่ใช่เหตุผลให้หยุดทำงาน
- เมื่อ scheduled task ปลุกขึ้นมา ให้ claim continuation ของ goal เดิม แล้วทำงานต่อจาก checkpoint ล่าสุด ห้ามเริ่มงานใหม่ตั้งแต่ต้น
- หากมี CI, build, test, deploy หรือ process ที่ยังรันอยู่ ให้ติดตาม task เดิมจนได้ terminal result ถ้าความล้มเหลวนั้นแก้ได้ ให้เปิดผลล้มเหลวจริง วิเคราะห์ root cause แก้ และรัน validation ที่เกี่ยวข้องต่อใน turn เดิม ห้ามหยุดแค่รายงานสถานะ
- ห้าม finish goal หากยังมี step, acceptance criterion, Engineering gate/review finding ที่จำเป็น, blocker หรือ blocking task ที่ยังไม่เสร็จ และให้ reconcile goal ซ้ำ/ถูกแทนที่/ถูก abandon ที่งานจบแล้วแทนการปล่อยค้าง Active ใน Watcher
- เมื่อทุกอย่างเสร็จจริง ให้ cancel scheduled continuation, ทำให้ Native ChatGPT Scheduled Task ตัวเดิมไม่สามารถรันต่อได้ แล้วค่อย finish_goal พร้อม final evidence จากนั้นเรียก get_goal ยืนยันว่าเป็น terminal ก่อนรายงานว่าเสร็จ
```

### Goal lifecycle / วงจรของ Goal

1. **Start / resume — `run_goal`**
   - English: Use one stable `goalKey`; resume the existing goal instead of creating a duplicate.
   - ไทย: ใช้ `goalKey` เดิมสำหรับงานเดียวกัน ถ้ามี goal อยู่แล้วให้ resume ห้ามสร้างซ้ำ

2. **Checkpoint — `checkpoint_goal`**
   - English: Save meaningful progress: current phase, completed/pending steps, next action, blockers, evidence, and tracked background tasks. A checkpoint records progress; it is **not** an instruction to stop working.
   - ไทย: บันทึกความคืบหน้าที่สำคัญ เช่น phase, step ที่เสร็จ/ค้าง, งานถัดไป, blocker, evidence และ task ที่กำลังรันอยู่ การ checkpoint คือการเซฟสถานะ ไม่ใช่การสั่งให้หยุดงาน

3. **Prepare + wake — `prepare_scheduled_continuation` / `claim_scheduled_continuation`**
   - English: Keep exactly one hourly Native ChatGPT recurring task for the goal. Every wake resumes the same durable goal from its latest checkpoint.
   - ไทย: ให้มี scheduled task แบบรายชั่วโมงเพียง 1 ตัวต่อ goal และทุกครั้งที่ถูกปลุกให้กลับมาทำ goal เดิมต่อจาก checkpoint ล่าสุด

4. **Stop watchdog — `cancel_scheduled_continuation`**
   - English: Once the goal is genuinely terminal, make the exact recurring Native ChatGPT task non-runnable so a completed job is not awakened again.
   - ไทย: เมื่องานจบจริง ให้ปิด scheduled continuation และทำให้ task ตัวเดิมรันต่อไม่ได้ เพื่อไม่ให้ปลุกงานที่เสร็จแล้วขึ้นมาอีก

5. **Finish — `finish_goal`**
   - English: Finish only after all planned steps are complete, blockers are cleared, blocking tasks are terminal, acceptance criteria are satisfied, and scheduled continuation cleanup is complete. Record final evidence instead of merely declaring success in chat.
   - ไทย: ปิด goal หลังจากทุก step เสร็จ, blocker ถูกเคลียร์, blocking task จบแล้ว, acceptance criteria ผ่านครบ และ cleanup ตัวตั้งเวลาเรียบร้อย พร้อมบันทึกหลักฐานสุดท้าย

### v5 Goal state / สถานะ Goal ใน v5

- **Plan + Watcher projection:** `get_goal_plan` projects the authoritative plan; `update_goal_plan` changes that same durable plan and keeps the plan/progress shown by Watcher aligned with real step state instead of creating a second planner.
- **Freshness + reconstruction:** call `checkpoint_goal` immediately after meaningful step/task/blocker/commit/push/CI/package milestones, and at least every 10 minutes during sustained work without a natural milestone. Meaningful checkpoints carry reconstruction-grade `resumeContext`; a short summary alone is not enough for reliable resume.
- **Acceptance:** `update_goal_acceptance` records explicit completion evidence. `finish_goal(status=completed)` is rejected while any criterion is still pending or blocked; Engineering Harness goals must also satisfy their required gates and blocking review findings.
- **Newest intent wins:** `revise_goal_intent` increments `userIntentRevision`; stale checkpoints or delivery receipts from older accepted user intent are fenced/retired rather than replayed.
- **Context Capsule:** `create_context_capsule` stores a bounded immutable objective/decision/result summary for compact/resume or handoff. It stores task state, not private chain-of-thought, and does not drive ChatGPT through browser/DOM automation.
- **Pressure + iteration:** `context_pressure` reports a local estimate when exact provider usage is unavailable, while `advance_goal_iteration` is explicitly bounded by `maxIterations` and can stop when no new evidence appears.
- **Completion hygiene:** after watchdog cleanup and `finish_goal`, read `get_goal` and confirm a terminal status before reporting completion. Reconcile stale duplicate, superseded, or abandoned Goal cards when authoritative evidence shows they no longer represent live work; completed work must not remain Active in Watcher.

ภาษาไทยแบบสั้น: v5 แยก **plan / acceptance / user intent / context capsule / bounded iteration** ออกจากกันชัดเจน โดย Durable Goal ยังเป็น source of truth เพียงชุดเดียว ถ้าผู้ใช้เปลี่ยนคำสั่งใหม่ งานเก่าต้องแพ้ revision ใหม่ และ Context Capsule ใช้เก็บสรุปสถานะเพื่อกลับมาทำต่อ ไม่ใช่เก็บ chain-of-thought หรือใช้ browser ไปสร้างแชทใหม่เอง

### Short prompt — English

```text
Use lnwjud-scheduled-continuation. Create or resume one durable goal for this job, keep exactly one Native ChatGPT Scheduled Task running in cloud mode every 1 hour, and resume from the latest checkpoint until the goal is genuinely complete. Checkpoint every meaningful milestone, never duplicate the goal or timer, and when all steps are complete with no blockers or blocking tasks left, cancel the scheduled continuation first and then finish_goal with final evidence.
```

### Prompt แบบสั้น — ภาษาไทย

```text
ใช้สกิล lnwjud-scheduled-continuation สร้างหรือ resume durable goal เดิมสำหรับงานนี้ และสร้าง Native ChatGPT Scheduled Task บน cloud แบบ recurring ทุก 1 ชั่วโมงเพียง 1 ตัว เพื่อกลับมาทำงานต่อจาก checkpoint ล่าสุดจน goal เสร็จจริง ระหว่างทางให้ checkpoint ทุก milestone สำคัญ ห้ามสร้าง goal หรือตัวตั้งเวลาซ้ำ และเมื่อทุก step เสร็จ ไม่มี blocker หรือ blocking task ค้าง ให้ปิด scheduled continuation ก่อน แล้ว finish_goal พร้อมหลักฐานสุดท้าย
```

This pattern is especially useful for long CI/release jobs, multi-stage refactors, deployments, packaging, migrations, or any task where “continue later” should be backed by durable state rather than wishful thinking.

รูปแบบนี้เหมาะกับงาน CI/Release ที่ใช้เวลานาน, refactor หลายขั้น, deploy, packaging, migration หรืองานใดก็ตามที่ต้องทำต่อหลายรอบ เพราะคำว่า “เดี๋ยวมาทำต่อ” ถ้าไม่มี state เก็บไว้ก็เป็นระบบ persistence ที่น่าเชื่อถือพอ ๆ กับกระดาษโน้ตที่ติดหน้าพัดลม

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
