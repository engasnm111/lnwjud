<p align="center">
  <img src="assets/logo/logo-256x256.png" width="160" alt="lnwjud logo" />
</p>

<h1 align="center">lnwjud</h1>

<p align="center">
  <strong>Cross-platform local AI-agent runtime and MCP gateway</strong><br />
  <em>263 total tool definitions for local files, Git, processes, Windows automation, WSL, browser control, durable goal continuation, native automation, context capsules, indexing, observability, ECC integration, and extensibility; 251 are advertised by default and all 263 when Codex delegation plus Agent Swarm is enabled.</em>
</p>

<p align="center">
  <em>อ่านที่เหลือใน Readme ได้เลยครับ ติดปัญหาทักมาได้ใน <a href="https://url.in.th/rEZiG"><strong>Line</strong></a> ได้ตลอดครับ / กำลังพัฒนาให้เรื่อยๆครับ ท่านที่ถามหาช่องสนับสนุนค่ากาแฟ แปะลิงก์ไว้ให้แล้วครับ ขอบคุณครับ — <a href="https://easydonate.app/abcz"><strong>Donate</strong></a></em>
</p>

<p align="center">
  <a href="https://github.com/engasnm111/lnwjud/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/engasnm111/lnwjud" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4" />
  <img alt="Node" src="https://img.shields.io/badge/Node.js-24.x-339933" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-263%20tools-6f42c1" />
</p>

<h2 align="center">Download lnwjud</h2>
<p align="center">Choose your platform and download the current v5.3.0 release directly.</p>

<table align="center">
  <tr>
    <td align="center" width="33%">
      <a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-Setup-5.3.0.exe">
        <img src="assets/download/download-windows.svg" width="300" alt="Download lnwjud for Windows" />
      </a><br />
      <sub><a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-Portable-5.3.0.exe">Portable x64</a></sub>
    </td>
    <td align="center" width="33%">
      <a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-5.3.0-arm64.dmg">
        <img src="assets/download/download-macos.svg" width="300" alt="Download lnwjud for macOS" />
      </a><br />
      <sub><a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-5.3.0-x64.dmg">Intel x64 DMG</a> · <a href="docs/INSTALL_MACOS.md">Install guide</a></sub>
    </td>
    <td align="center" width="33%">
      <a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-5.3.0-x64.deb">
        <img src="assets/download/download-linux.svg" width="300" alt="Download lnwjud for Linux" />
      </a><br />
      <sub><a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-5.3.0-x64.AppImage">x64 AppImage</a> · <a href="docs/INSTALL_LINUX.md">Other architectures</a></sub>
    </td>
  </tr>
</table>

<p align="center"><a href="https://github.com/engasnm111/lnwjud/releases/latest"><strong>View all release files →</strong></a></p>

---

## Current published version: v5.3.0

## Current source version: v5.3.0

Latest published release: **v5.3.0**. The download buttons above point directly to the published v5.3.0 assets.

### What's new in v5.3.0

- **Issue #94 RAM leak fixed:** successful modern MCP requests now tear down their per-request `McpServer` lifecycle, unsubscribe `toolAvailabilityService` listeners, and release retained tool registries/schemas; pagination continuations are also bounded as secondary hardening.
- **Crash evidence survives hard exits:** Desktop session heartbeats distinguish clean shutdown from abrupt termination. A recent unclean previous session is reported after restart only when stronger current failure evidence is absent. Local-only Crashpad evidence adds bounded crash-dump metadata plus per-process memory diagnostics, while a bounded 6-hour runtime trend samples memory, Electron process groups, CPU/event-loop pressure, active Node resources, retained log-buffer/dedupe counters, MCP activity/errors, and tool-availability listener counts once per minute.
- **Electron 45 crash diagnostics:** Desktop v5.3.0 targets Electron `45.0.0-alpha.7` so the packaged Windows runtime includes `electron_wer.dll` in addition to local-only Crashpad/session diagnostics. Crash reports stay local and bounded; no automatic crash upload is enabled.

### Historical: What's new in v5.2.1

- **Responsive Git summaries:** untracked directories stay collapsed, and dashboard refresh no longer reads every untracked file to count lines.
- **Bounded filesystem scans:** backup and portable-scheduler discovery no longer starts an unbounded batch of file reads.
- **Generated artifacts stay out of Git and automatic context:** `artifacts/` now follows the existing generated-directory ignore policy.

### Historical: What's new in v5.2.0

- **Remote MCP reliability:** fixed ngrok restart failures and made Static/Custom Domain handling explicit and stable.
- **Better incident diagnostics:** crash and lifecycle evidence now survives app restarts, making previous failures easier to investigate.
- **Lower idle CPU and more reliable cleanup:** fixed an External MCP idle-sweeper race that could suppress later cleanup passes and leave sessions running.

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

lnwjud exposes **263 tool definitions** through one local runtime and MCP gateway. The default advertised set is 251; all 263 are available when Codex delegation plus Agent Swarm is enabled.

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
- Create or resume the same durable goal using one stable goalKey. Never create duplicate goals for the same job.
- Create exactly one recurring Native ChatGPT Scheduled Task, run it in cloud mode every 1 hour, and reuse that same scheduled continuation for this goal.
- Checkpoint the goal after every meaningful milestone. Persist the current phase, step status, next action, blockers, evidence, and any background tasks that are still running.
- When the scheduled task wakes the workflow, claim the continuation for the same goal and resume from the latest checkpoint instead of starting over.
- If CI, build, test, deployment, or another process is still running, keep tracking the same task until its terminal result is known, then record that result in the checkpoint.
- Do not finish the goal while any planned step, blocker, or blocking task remains unresolved.
- When the work is truly complete, cancel the scheduled continuation, make the exact Native ChatGPT Scheduled Task non-runnable, then call finish_goal with the final status and evidence.
```

### Prompt แนะนำ — ภาษาไทย

```text
@lnwjud

Workspace:
C:\path\to\my-project

ทำงานนี้ต่อเนื่องจนเสร็จจริง ห้ามหยุดกลางทางเพียงเพราะแชทจบรอบ

- ใช้สกิล lnwjud-scheduled-continuation
- สร้างหรือ resume durable goal เดิมด้วย goalKey ที่คงที่ ห้ามสร้าง goal ซ้ำสำหรับงานเดียวกัน
- สร้าง Native ChatGPT Scheduled Task แบบ recurring เพียง 1 ตัว ให้รันบน cloud ทุก 1 ชั่วโมง และใช้ scheduled continuation ตัวเดิมกับ goal นี้ไปตลอด
- หลังจบ milestone สำคัญทุกครั้ง ให้ checkpoint goal โดยบันทึก current phase, step status, next action, blockers, evidence และ background task ที่ยังรันอยู่
- เมื่อ scheduled task ปลุกขึ้นมา ให้ claim continuation ของ goal เดิม แล้วทำงานต่อจาก checkpoint ล่าสุด ห้ามเริ่มงานใหม่ตั้งแต่ต้น
- หากมี CI, build, test, deploy หรือ process ที่ยังรันอยู่ ให้ติดตาม task เดิมจนได้ terminal result แล้วบันทึกผลลง checkpoint
- ห้าม finish goal หากยังมี step ที่ไม่เสร็จ, blocker ที่ยังไม่เคลียร์ หรือ blocking task ที่ยังทำงานอยู่
- เมื่อทุกอย่างเสร็จจริง ให้ cancel scheduled continuation, ทำให้ Native ChatGPT Scheduled Task ตัวเดิมไม่สามารถรันต่อได้ แล้วค่อย finish_goal พร้อม final status และ evidence
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

- **Plan:** `get_goal_plan` projects the authoritative plan; `update_goal_plan` changes that same durable plan instead of creating a second planner.
- **Acceptance:** `update_goal_acceptance` records explicit completion evidence. `finish_goal(status=completed)` is rejected while any criterion is still pending or blocked.
- **Newest intent wins:** `revise_goal_intent` increments `userIntentRevision`; stale checkpoints or delivery receipts from older accepted user intent are fenced/retired rather than replayed.
- **Context Capsule:** `create_context_capsule` stores a bounded immutable objective/decision/result summary for compact/resume or handoff. It stores task state, not private chain-of-thought, and does not drive ChatGPT through browser/DOM automation.
- **Pressure + iteration:** `context_pressure` reports a local estimate when exact provider usage is unavailable, while `advance_goal_iteration` is explicitly bounded by `maxIterations` and can stop when no new evidence appears.

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
