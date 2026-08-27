# Guided Local Tunnel Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ทำให้ผู้ใช้ที่ยังไม่เคยตั้งค่า OpenAI Secure MCP Tunnel ได้รับ Tips อัตโนมัติ ถูกนำไปหน้า Settings > Secure Tunnel และทำตามคำแนะนำภาษาไทย/อังกฤษตั้งแต่สร้าง Tunnel ID, สร้างและบันทึก Runtime API key, configure profile, Start Tunnel ไปจนถึงเปิดหน้า ChatGPT Plugins ได้ โดยไม่ใช้ Terminal และไม่ต้องแก้ไฟล์ config เอง

**Architecture:** เพิ่ม onboarding แบบ local-only สองชั้น: กล่อง Tips ครั้งแรกที่ตัดสินจากสถานะ tunnel จริง และ guided stepper ในหน้า Secure Tunnel ซึ่งเรียกใช้ `saveTunnelApiKey`, `configureTunnelProfile` และ `startTunnel` เดิมตามลำดับ ลิงก์ภายนอกเปิดผ่าน IPC ที่รับเฉพาะ enum allowlist; สถานะ UI เก็บเฉพาะ `not_started | in_progress | dismissed | completed` ใน renderer storage และห้ามเก็บ credential หรือ Tunnel ID ในสถานะ onboarding

**Tech Stack:** Electron 43, React 19, TypeScript 6, Vitest 3, Playwright 1.55, Windows DPAPI, OpenAI `tunnel-client` ที่ bundle อยู่ใน installer, pnpm 10.15.0, Node.js 24

## Global Constraints

- ทำงานเฉพาะใน `E:\lnwjud`; ห้ามสร้าง worktree, สำเนา repository หรือ artifact นอกโฟลเดอร์นี้
- ก่อนแก้ทุกไฟล์ให้เปิดอ่านเวอร์ชันปัจจุบันใหม่ เพราะ working tree มีงานอื่นค้างอยู่ ห้าม reset, checkout ทับ, format ทั้ง repository หรือ stage ไฟล์ที่ไม่เกี่ยวข้อง
- ห้ามเพิ่มชื่อ ผลิตภัณฑ์ อ้างอิง หรือหลักฐานของโปรแกรมคู่แข่งลงใน source, docs, tests, fixtures, snapshots, commit message หรือ installer metadata
- ค่าเริ่มต้นต้องฟรีและ local-first: ห้ามเพิ่ม domain, VPS, cloud gateway, OAuth server, public relay หรือ OpenAI model API usage
- ห้ามใช้ browser/UI automation, clipboard monitoring หรือการดักข้อมูลจากหน้าเว็บ ผู้ใช้เป็นคนกดเปิดลิงก์และวางค่าด้วยตนเอง
- Runtime API key ต้องส่งจาก renderer ไป main process เฉพาะตอนกดบันทึก, เข้ารหัสด้วย Windows DPAPI ตามระบบเดิม, ล้างออกจาก React state ทันทีหลังสำเร็จ และห้ามปรากฏใน log, error, telemetry, incident report หรือ test snapshot
- ห้ามเก็บ Runtime API key หรือ Tunnel ID ใน `localStorage`/`sessionStorage`; onboarding storage เก็บได้เฉพาะ enum สถานะ UI
- Renderer ห้ามส่ง URL อิสระให้ main process เปิด ให้ส่งเฉพาะ target enum ที่ main process map เป็น HTTPS URL คงที่
- ผู้ใช้เดิมที่มี `hasApiKey === true` หรือ `profileExists === true` ต้องไม่ถูกแสดง Tips อัตโนมัติ
- ถ้าผู้ใช้ตั้งค่าค้างกลางทางและ onboarding state เป็น `in_progress` ให้กลับมาทำต่อที่ขั้นที่หาได้จากสถานะจริง
- การปิด Tips ด้วย “ไว้ทีหลัง” ต้องไม่ปิดความสามารถ ผู้ใช้เปิดคู่มือใหม่ได้ตลอดจาก Settings > Secure Tunnel และจากการ์ดสถานะหน้า Home
- ห้ามเปลี่ยน timeout, tunnel lifetime, reconnect contract, MCP tool schema, permission profile หรือ release pipeline ในงานนี้
- ห้าม build/publish installer, tag, push หรือ release จากแผนนี้ เว้นแต่ผู้ใช้สั่งเพิ่มภายหลัง หากมีคำสั่ง build installer ต้องออกเฉพาะ `E:\lnwjud\apps\desktop\dist\installers`
- Commit ในแต่ละ task ทำได้เมื่อผู้ใช้อนุญาตให้ commit เท่านั้น และต้อง stage เฉพาะไฟล์ของ task นั้น; ถ้ายังไม่ได้รับอนุญาต ให้หยุดที่ verified working tree checkpoint

---

## Official Behavior Baseline (verified 2026-08-26)

- OpenAI Secure MCP Tunnel ต้องมี `tunnel_id`, Runtime API key และ MCP server ที่ local client เข้าถึงได้
- การสร้าง/แก้ tunnel ต้องมี Tunnels Read + Manage; การรัน client/เลือก tunnel ต้องมี Tunnels Read + Use
- ChatGPT developer mode อยู่ที่ Settings > Security and login > Developer mode
- การเพิ่ม connection ใน ChatGPT Plugins ให้เลือก Connection = Tunnel แล้วเลือก tunnel ที่มีอยู่หรือวาง `tunnel_id`
- ใช้ URL คงที่เหล่านี้ผ่าน allowlist กลางเพียงจุดเดียว:
  - Tunnel settings: `https://platform.openai.com/settings/organization/tunnels`
  - API keys: `https://platform.openai.com/api-keys`
  - ChatGPT Plugins: `https://chatgpt.com/plugins`
- เอกสารอ้างอิง:
  - `https://developers.openai.com/api/docs/guides/secure-mcp-tunnels`
  - `https://developers.openai.com/plugins/deploy/connect-chatgpt`

ถ้าหน้า Platform เปลี่ยน layout ในอนาคต ให้แก้เฉพาะข้อความ i18n และ URL mapping ห้ามกระจาย URL หรือคำแนะนำไว้หลาย component

---

## User Flow Contract

```text
เปิด lnwjud ครั้งแรก
  |
  |-- มี key/profile เดิมอย่างน้อยหนึ่งอย่าง --> ไม่เปิด Tips อัตโนมัติ
  |
  `-- ไม่มี key + ไม่มี profile + ไม่มี onboarding dismissal
        |
        v
    Tips: “ตั้งค่า ChatGPT ให้ใช้ lnwjud”
        |
        |-- ไว้ทีหลัง --> ปิด Tips, แสดงปุ่มเปิดคู่มือใน Home/Settings
        |
        `-- เริ่มตั้งค่า
              |
              v
        Settings > Secure Tunnel เปิดอัตโนมัติ
              |
              v
        1. เปิดหน้า OpenAI Tunnel Settings
        2. สร้าง tunnel และวาง Tunnel ID
        3. เปิดหน้า API Keys และวาง Runtime API key
        4. lnwjud บันทึก key ด้วย DPAPI + configure profile + doctor
        5. ผู้ใช้กด Start Tunnel
        6. แสดง Running และปุ่มเปิด ChatGPT Plugins
        7. อธิบาย Developer mode + Connection = Tunnel
```

### First-time eligibility

ใช้สถานะจริง ไม่ใช้เลขเวอร์ชัน installer:

```ts
fresh = !tunnel.hasApiKey
  && !tunnel.profileExists
  && (tunnel.persistent?.tunnelIdMasked ?? null) === null;
```

- `not_started + fresh` => แสดง Tips
- `in_progress + tunnel.state !== 'running'` => เปิด Settings/Tunnel และ resume guide
- `dismissed` => ไม่เปิดอัตโนมัติ แต่มีปุ่มเปิดใหม่
- `completed` => ไม่เปิดอัตโนมัติ
- `hasApiKey || profileExists` โดยไม่มี `in_progress` => ถือเป็นผู้ใช้เดิม/ตั้งค่าบางส่วน ห้าม popup อัตโนมัติ แต่แสดงสถานะและปุ่มคู่มือในหน้า Tunnel
- ถ้าข้อมูล application ถูกลบจนทั้ง key/profile/onboarding state หาย ระบบแยกจากเครื่องใหม่ไม่ได้อย่างปลอดภัย ให้แสดง Tips เหมือนเครื่องใหม่

### Completion semantics

- “Local setup configured” = `hasApiKey && profileExists`
- “Tunnel started” = top-level `tunnel.state === 'running'`
- ตั้ง onboarding state เป็น `completed` หลัง `startTunnel()` คืนสถานะ `running` เท่านั้น
- การเปิด ChatGPT Plugins เป็นขั้นสุดท้ายที่ผู้ใช้ทำเอง lnwjud แสดงคำแนะนำได้ แต่ห้ามอ้างว่า ChatGPT connection สำเร็จเพราะ local app ตรวจไม่ได้

---

## Progress Tracker

| Phase | Deliverable | Status |
|---|---|---|
| 1 | Pure onboarding state model | Done |
| 2 | Safe external-link IPC allowlist | Done |
| 3 | Complete Thai/English copy | Done |
| 4 | First-run Tips and automatic navigation | Done |
| 5 | Guided Secure Tunnel stepper | Done |
| 6 | Home/Settings recovery entry points | Done |
| 7 | Unit, IPC, renderer and E2E verification | Done |
| 8 | User docs and final gates | Done |

---

## Planned File Map

### Create

- `apps/desktop/src/renderer/features/onboarding/guided-tunnel-setup-state.ts` — pure launch/step/storage decisions; no React and no secrets
- `apps/desktop/src/renderer/features/onboarding/FirstRunTunnelTip.tsx` — first-time Tips dialog
- `apps/desktop/src/renderer/features/onboarding/GuidedTunnelSetup.tsx` — bilingual stepper and orchestration UI
- `apps/desktop/src/main/external-setup-links.ts` — strict payload parser and resolver over the shared target-to-URL allowlist
- `apps/desktop/tests/guided-tunnel-setup-state.test.ts` — decision/resume tests
- `apps/desktop/tests/guided-tunnel-setup-ui.test.ts` — SSR copy and state rendering tests
- `apps/desktop/tests/external-setup-links.test.ts` — URL allowlist tests
- `apps/desktop/e2e/guided-tunnel-setup.e2e.ts` — real fresh-user Tips/navigation smoke without live credentials
- `docs/development/GUIDED_LOCAL_TUNNEL_SETUP.md` — user-facing Thai/English setup and maintenance note

### Modify

- `packages/ipc-contracts/src/index.ts` — target enum, single public URL map, IPC request/response map and `LnwjudApi`
- `apps/desktop/src/preload/index.ts` — validated bridge method for opening allowlisted setup pages
- `apps/desktop/src/main/main.ts` — trusted IPC handler, payload parser and Electron `shell.openExternal`
- `apps/desktop/src/renderer/App.tsx` — first-load decision, Tips state, automatic settings navigation, guided callbacks
- `apps/desktop/src/renderer/features/settings/SettingsPage.tsx` — export settings section type, accept requested section, render guided setup, keep manual controls under Advanced
- `apps/desktop/src/renderer/features/home/ControlCenterPage.tsx` — incomplete-setup card and reopen action
- `apps/desktop/src/renderer/i18n/messages.ts` — all Thai/English onboarding copy
- `apps/desktop/src/renderer/settings-extra.css` — modal, stepper, progress and responsive styles
- `apps/desktop/tests/i18n.test.ts` — required onboarding key parity
- `apps/desktop/tests/production-ipc-acceptance.test.ts` — trusted sender, allowlist and `shell.openExternal` coverage

Do not create a new dependency. Use `react-dom/server` for component markup tests and the existing Playwright/CDP launch pattern for E2E.

---

### Task 1: Add the pure onboarding state model

**Files:**
- Create: `apps/desktop/src/renderer/features/onboarding/guided-tunnel-setup-state.ts`
- Test: `apps/desktop/tests/guided-tunnel-setup-state.test.ts`

**Interfaces:**
- Consumes: `TunnelStatus` from `@lnwjud/ipc-contracts`
- Produces:

```ts
export type GuidedTunnelSetupState = 'not_started' | 'in_progress' | 'dismissed' | 'completed';
export type GuidedTunnelLaunchDecision = 'none' | 'show_tip' | 'resume_settings';
export type GuidedTunnelStep = 'create_tunnel' | 'save_key' | 'configure' | 'start' | 'connect_chatgpt';

export const GUIDED_TUNNEL_SETUP_STORAGE_KEY = 'lnwjud.guided-tunnel-setup.v1';

export function isFreshTunnelSetup(tunnel: TunnelStatus): boolean;
export function isTunnelConfigured(tunnel: TunnelStatus): boolean;
export function isTunnelRunning(tunnel: TunnelStatus): boolean;
export function guidedTunnelLaunchDecision(
  tunnel: TunnelStatus,
  state: GuidedTunnelSetupState,
): GuidedTunnelLaunchDecision;
export function initialGuidedTunnelStep(tunnel: TunnelStatus): GuidedTunnelStep;
export function readGuidedTunnelSetupState(storage: Pick<Storage, 'getItem'>): GuidedTunnelSetupState;
export function writeGuidedTunnelSetupState(
  storage: Pick<Storage, 'setItem'>,
  state: GuidedTunnelSetupState,
): void;
```

- [ ] **Step 1: Write failing decision tests**

```ts
it('shows Tips only for a pristine tunnel setup', () => {
  expect(guidedTunnelLaunchDecision(pristineTunnel(), 'not_started')).toBe('show_tip');
  expect(guidedTunnelLaunchDecision({ ...pristineTunnel(), hasApiKey: true }, 'not_started')).toBe('none');
  expect(guidedTunnelLaunchDecision({ ...pristineTunnel(), profileExists: true }, 'not_started')).toBe('none');
});

it('resumes an in-progress setup until the tunnel reaches running', () => {
  expect(guidedTunnelLaunchDecision(pristineTunnel(), 'in_progress')).toBe('resume_settings');
  expect(guidedTunnelLaunchDecision({ ...pristineTunnel(), state: 'running' }, 'in_progress')).toBe('none');
});

it('never auto-opens after dismissal or completion', () => {
  expect(guidedTunnelLaunchDecision(pristineTunnel(), 'dismissed')).toBe('none');
  expect(guidedTunnelLaunchDecision(pristineTunnel(), 'completed')).toBe('none');
});

it('stores only the finite onboarding state', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  writeGuidedTunnelSetupState(storage, 'in_progress');
  expect(readGuidedTunnelSetupState(storage)).toBe('in_progress');
  expect([...values.values()]).toEqual(['in_progress']);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
corepack pnpm@10.15.0 --filter @lnwjud/desktop exec vitest run --config vitest.config.ts tests/guided-tunnel-setup-state.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal pure model**

Rules:

```ts
export function guidedTunnelLaunchDecision(
  tunnel: TunnelStatus,
  state: GuidedTunnelSetupState,
): GuidedTunnelLaunchDecision {
  if (state === 'dismissed' || state === 'completed' || isTunnelRunning(tunnel)) return 'none';
  if (state === 'in_progress') return 'resume_settings';
  return isFreshTunnelSetup(tunnel) ? 'show_tip' : 'none';
}
```

`readGuidedTunnelSetupState` ต้องคืน `not_started` สำหรับ missing/unknown/corrupt values ห้าม throw และห้ามอ่าน key อื่น

- [ ] **Step 4: Run focused test and typecheck**

```powershell
corepack pnpm@10.15.0 --filter @lnwjud/desktop exec vitest run --config vitest.config.ts tests/guided-tunnel-setup-state.test.ts
corepack pnpm@10.15.0 --filter @lnwjud/desktop typecheck
```

Expected: PASS.

- [ ] **Step 5: Checkpoint**

Review `git diff -- apps/desktop/src/renderer/features/onboarding apps/desktop/tests/guided-tunnel-setup-state.test.ts`. Commit only with explicit authorization and stage only these paths.

---

### Task 2: Add safe external setup links through IPC

**Files:**
- Create: `apps/desktop/src/main/external-setup-links.ts`
- Create: `apps/desktop/tests/external-setup-links.test.ts`
- Modify: `packages/ipc-contracts/src/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/tests/production-ipc-acceptance.test.ts`

**Interfaces:**

```ts
export type ExternalSetupTarget = 'openai_tunnels' | 'openai_api_keys' | 'chatgpt_plugins';

export interface OpenExternalSetupPageRequest {
  readonly target: ExternalSetupTarget;
}

// LnwjudApi
openExternalSetupPage(
  request: OpenExternalSetupPageRequest,
): Promise<{ readonly opened: true }>;
```

Define one public, immutable URL map in `@lnwjud/ipc-contracts` so the main process opens it and the renderer can show/copy the same fallback address without duplicating strings:

```ts
export const EXTERNAL_SETUP_URLS: Readonly<Record<ExternalSetupTarget, string>> = {
  openai_tunnels: 'https://platform.openai.com/settings/organization/tunnels',
  openai_api_keys: 'https://platform.openai.com/api-keys',
  chatgpt_plugins: 'https://chatgpt.com/plugins',
};
```

`apps/desktop/src/main/external-setup-links.ts` must import this map, parse the exact target enum and return only `EXTERNAL_SETUP_URLS[target]`. The renderer may import the map only for visible fallback/copy text; it still sends only `{ target }` over IPC.

- [ ] **Step 1: Write failing allowlist tests**

Test exact equality, HTTPS scheme, expected hostnames, and that arbitrary strings cannot resolve:

```ts
expect(resolveExternalSetupUrl('openai_tunnels')).toBe(
  'https://platform.openai.com/settings/organization/tunnels',
);
expect(Object.values(EXTERNAL_SETUP_URLS).every((value) => new URL(value).protocol === 'https:')).toBe(true);
```

- [ ] **Step 2: Add IPC contract and preload validation**

Add `ipcChannels.openExternalSetupPage`, request/response map entries, `LnwjudApi.openExternalSetupPage`, and a preload method that validates `{ opened: true }`.

The renderer sends only `{ target }`; never accept `{ url }`.

- [ ] **Step 3: Add the trusted main-process handler**

Update Electron import to include `shell`. The handler order must match nearby settings/tunnel handlers:

```ts
ipcMain.handle(ipcChannels.openExternalSetupPage, async (event, payload: unknown) => {
  assertTrustedSender(event, getMainWindow());
  const request = parseOpenExternalSetupPageRequest(payload);
  await shell.openExternal(resolveExternalSetupUrl(request.target));
  return { opened: true as const };
});
```

`parseOpenExternalSetupPageRequest` accepts only the three exact enum values and throws `Invalid IPC payload: target` for everything else.

- [ ] **Step 4: Extend production IPC acceptance tests**

Mock `electron.shell.openExternal`. Verify:

```ts
await expect(handler(trusted, { target: 'openai_tunnels' })).resolves.toEqual({ opened: true });
expect(shellOpenExternal).toHaveBeenCalledExactlyOnceWith(
  'https://platform.openai.com/settings/organization/tunnels',
);
await expect(handler(trusted, { target: 'https://evil.example/' })).rejects.toThrow(/target/);
await expect(handler(untrusted, { target: 'openai_tunnels' })).rejects.toThrow('IPC sender rejected');
```

- [ ] **Step 5: Run focused verification**

```powershell
corepack pnpm@10.15.0 --filter @lnwjud/desktop exec vitest run --config vitest.config.ts tests/external-setup-links.test.ts tests/production-ipc-acceptance.test.ts
corepack pnpm@10.15.0 --filter @lnwjud/desktop typecheck
```

Expected: PASS and no URL supplied by renderer reaches `shell.openExternal` directly.

- [ ] **Step 6: Checkpoint**

Review only the five implementation paths and two test paths from this task. Never stage other current changes in `main.ts` or repository-wide generated output.

---

### Task 3: Add complete Thai and English onboarding copy

**Files:**
- Modify: `apps/desktop/src/renderer/i18n/messages.ts`
- Modify: `apps/desktop/tests/i18n.test.ts`

**Interfaces:**
- Consumes: existing `MessageKey`, `Messages`, `createTranslator`
- Produces: all `guidedTunnel.*` keys below with identical Thai/English key sets

Use this exact copy as the source of truth:

| Key | ไทย | English |
|---|---|---|
| `guidedTunnel.tipTitle` | ตั้งค่า ChatGPT ให้ใช้ lnwjud | Connect ChatGPT to lnwjud |
| `guidedTunnel.tipBody` | ทำขั้นตอนนี้เพียงครั้งเดียว lnwjud จะพาไปสร้าง Tunnel ID และ Runtime API key แล้วตั้งค่าให้โดยอัตโนมัติ | Complete this once. lnwjud will guide you through creating a Tunnel ID and Runtime API key, then configure the connection automatically. |
| `guidedTunnel.privacy` | คีย์จะถูกเข้ารหัสด้วย Windows DPAPI และเก็บในเครื่องนี้เท่านั้น lnwjud ไม่มีเซิร์ฟเวอร์กลางรับคีย์ของคุณ | Your key is encrypted with Windows DPAPI and stored only on this PC. lnwjud has no central server that receives your key. |
| `guidedTunnel.startSetup` | เริ่มตั้งค่า | Start setup |
| `guidedTunnel.later` | ไว้ทีหลัง | Set up later |
| `guidedTunnel.openGuide` | เปิดคู่มือตั้งค่า | Open setup guide |
| `guidedTunnel.progress` | ขั้นตอนการเชื่อมต่อ | Connection setup |
| `guidedTunnel.stepTunnelTitle` | 1. สร้าง OpenAI Tunnel | 1. Create an OpenAI Tunnel |
| `guidedTunnel.stepTunnelBody` | เปิดหน้า Tunnel Settings เลือกองค์กรที่ใช้กับ ChatGPT สร้าง tunnel และคัดลอกค่าที่ขึ้นต้นด้วย tunnel_ หากสร้างไม่ได้ ให้ตรวจว่าบัญชีมี Tunnels Read + Manage | Open Tunnel Settings, select the organization used with ChatGPT, create a tunnel, and copy the value beginning with tunnel_. If creation is unavailable, verify that the account has Tunnels Read + Manage. |
| `guidedTunnel.openTunnelSettings` | เปิดหน้า Tunnel Settings | Open Tunnel Settings |
| `guidedTunnel.tunnelIdLabel` | Tunnel ID | Tunnel ID |
| `guidedTunnel.tunnelIdHint` | วาง Tunnel ID ที่คัดลอกจาก OpenAI Platform | Paste the Tunnel ID copied from OpenAI Platform. |
| `guidedTunnel.tunnelIdInvalid` | Tunnel ID ต้องขึ้นต้นด้วย tunnel_ และมีรูปแบบถูกต้อง | The Tunnel ID must begin with tunnel_ and use a valid format. |
| `guidedTunnel.next` | ขั้นตอนถัดไป | Continue |
| `guidedTunnel.back` | ย้อนกลับ | Back |
| `guidedTunnel.stepKeyTitle` | 2. สร้าง Runtime API key | 2. Create a Runtime API key |
| `guidedTunnel.stepKeyBody` | เปิดหน้า API Keys สร้าง secret key ใหม่ กำหนดสิทธิ์ Tunnels Read + Use แล้วคัดลอกทันที | Open API Keys, create a new secret key, grant it Tunnels Read + Use, and copy it immediately. |
| `guidedTunnel.openApiKeys` | เปิดหน้าสร้าง API key | Open API Keys |
| `guidedTunnel.apiKeyLabel` | Runtime API key | Runtime API key |
| `guidedTunnel.apiKeyHint` | คีย์จะแสดงเต็มเพียงครั้งเดียว วางแล้วกดบันทึก | The full key is shown once. Paste it here, then save it. |
| `guidedTunnel.apiKeyRequired` | กรุณาวาง Runtime API key | Paste a Runtime API key. |
| `guidedTunnel.saveKey` | บันทึกคีย์อย่างปลอดภัย | Save key securely |
| `guidedTunnel.keyStored` | บันทึกคีย์ใน Windows DPAPI แล้ว | Key saved with Windows DPAPI. |
| `guidedTunnel.stepConfigureTitle` | 3. ให้ lnwjud ตั้งค่าอัตโนมัติ | 3. Let lnwjud configure the connection |
| `guidedTunnel.stepConfigureBody` | lnwjud จะใช้ tunnel-client ที่มากับโปรแกรม สร้างโปรไฟล์ local และตรวจสอบการเชื่อมต่อให้ | lnwjud will use the bundled tunnel-client, create the local profile, and check the connection. |
| `guidedTunnel.configure` | ตั้งค่าและตรวจสอบ | Configure and check |
| `guidedTunnel.configuring` | กำลังสร้างโปรไฟล์และตรวจสอบ… | Creating the profile and checking it… |
| `guidedTunnel.configured` | โปรไฟล์ Tunnel พร้อมใช้งาน | Tunnel profile is ready. |
| `guidedTunnel.stepStartTitle` | 4. เริ่ม Tunnel | 4. Start the Tunnel |
| `guidedTunnel.stepStartBody` | ตรวจสอบข้อมูลด้านล่าง แล้วกด Start Tunnel เมื่อสถานะเป็น Running โปรแกรมจะ reconnect Tunnel ID เดิมให้อัตโนมัติ | Review the details below, then select Start Tunnel. Once it is Running, the app will reconnect the same Tunnel ID automatically. |
| `guidedTunnel.startTunnel` | Start Tunnel | Start Tunnel |
| `guidedTunnel.starting` | กำลังเริ่ม Tunnel… | Starting Tunnel… |
| `guidedTunnel.running` | Tunnel กำลังทำงาน | Tunnel is running |
| `guidedTunnel.stepChatGptTitle` | 5. เชื่อมต่อใน ChatGPT | 5. Connect in ChatGPT |
| `guidedTunnel.stepChatGptBody` | เปิด ChatGPT Plugins หากยังไม่เปิด Developer mode ให้ไปที่ Settings > Security and login > Developer mode จากนั้นกดเพิ่ม connection เลือก Tunnel แล้วเลือกหรือวาง Tunnel ID นี้ | Open ChatGPT Plugins. If Developer mode is off, go to Settings > Security and login > Developer mode. Add a connection, choose Tunnel, then select or paste this Tunnel ID. |
| `guidedTunnel.openChatGptPlugins` | เปิด ChatGPT Plugins | Open ChatGPT Plugins |
| `guidedTunnel.localComplete` | การตั้งค่าฝั่งเครื่องเสร็จแล้ว | Local setup is complete. |
| `guidedTunnel.done` | เสร็จสิ้น | Done |
| `guidedTunnel.dismissedHint` | ยังไม่ได้ตั้งค่า Tunnel คุณเปิดคู่มือได้ทุกเมื่อ | Tunnel is not configured yet. You can reopen the guide at any time. |
| `guidedTunnel.linkError` | เปิดลิงก์ไม่ได้ กรุณาคัดลอกลิงก์ด้านล่างไปเปิดในเบราว์เซอร์ | Could not open the link. Copy the address below into your browser. |
| `guidedTunnel.copyLink` | คัดลอกลิงก์ | Copy link |
| `guidedTunnel.retry` | ลองอีกครั้ง | Try again |
| `guidedTunnel.advanced` | การตั้งค่าขั้นสูงและแก้ปัญหา | Advanced settings and troubleshooting |

- [ ] **Step 1: Add every key to the `MessageKey` union and both maps**

Do not place new Thai/English ternaries in the onboarding components. All user-visible copy above must use `t('guidedTunnel.*')`.

- [ ] **Step 2: Extend parity tests**

Add all keys to `requiredKeys` or a dedicated `guidedKeys` list. Assert both languages are non-empty and different except intentionally identical technical labels such as `Tunnel ID`, `Runtime API key`, and `Start Tunnel`.

- [ ] **Step 3: Run i18n tests**

```powershell
corepack pnpm@10.15.0 --filter @lnwjud/desktop exec vitest run --config vitest.config.ts tests/i18n.test.ts
```

Expected: PASS with identical key sets.

- [ ] **Step 4: Checkpoint**

Review that no competitor reference, secret example longer than `sk-...`, or unlocalized onboarding sentence was added.

---

### Task 4: Add first-run Tips and automatic navigation

**Files:**
- Create: `apps/desktop/src/renderer/features/onboarding/FirstRunTunnelTip.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/renderer/settings-extra.css`
- Test: `apps/desktop/tests/guided-tunnel-setup-ui.test.ts`

**Interfaces:**

```ts
interface FirstRunTunnelTipProps {
  readonly locale: UiLocale;
  readonly onStart: () => void;
  readonly onLater: () => void;
}

// SettingsPage
export type SettingsSection = 'general' | 'security' | 'tools' | 'mcp' | 'tunnel' | 'backup';

interface SettingsPageProps {
  // existing props remain
  readonly requestedSection?: {
    readonly section: SettingsSection;
    readonly requestId: number;
  };
  readonly guidedTunnelSetupOpen: boolean;
  readonly onGuidedTunnelSetupOpenChange: (open: boolean) => void;
}
```

- [ ] **Step 1: Write the failing SSR copy test**

Render `FirstRunTunnelTip` with `locale: 'th'` and `locale: 'en'`. Assert title, privacy text, Start and Later actions are present and that API key/Tunnel ID values are not accepted as props.

- [ ] **Step 2: Implement the accessible Tips dialog**

Requirements:

- `role="dialog"`, `aria-modal="true"`, translated `aria-labelledby`
- primary action Start setup; secondary action Set up later
- no secret inputs in the Tips dialog
- Escape behaves like Set up later
- focus moves to Start setup on open and returns to the previous focused element on close
- CSS supports 1280×720 and 1672×941 without horizontal scrolling

- [ ] **Step 3: Wire the first-load decision in `App.tsx`**

Add state/ref without disturbing the one-second dashboard refresh:

```ts
const [firstRunTipOpen, setFirstRunTipOpen] = useState(false);
const [guidedTunnelSetupOpen, setGuidedTunnelSetupOpen] = useState(false);
const [requestedSettingsSection, setRequestedSettingsSection] = useState<{
  section: SettingsSection;
  requestId: number;
}>();
const settingsRequestId = useRef(0);
const onboardingLaunchHandled = useRef(false);
```

Route through one helper so repeated clicks work even when the requested section is already `tunnel`:

```ts
function openGuidedTunnelSettings(markInProgress: boolean): void {
  if (markInProgress) {
    writeGuidedTunnelSetupState(window.localStorage, 'in_progress');
  }
  setRequestedSettingsSection({
    section: 'tunnel',
    requestId: ++settingsRequestId.current,
  });
  setGuidedTunnelSetupOpen(true);
  setScreen('settings');
}
```

After the first non-null dashboard only:

```ts
const state = readGuidedTunnelSetupState(window.localStorage);
const decision = guidedTunnelLaunchDecision(dashboard.tunnel, state);
if (decision === 'show_tip') setFirstRunTipOpen(true);
if (decision === 'resume_settings') {
  setScreen('settings');
  setRequestedSettingsSection({
    section: 'tunnel',
    requestId: ++settingsRequestId.current,
  });
  setGuidedTunnelSetupOpen(true);
}
```

Do not re-trigger on each one-second refresh.

Start setup action:

```ts
setFirstRunTipOpen(false);
openGuidedTunnelSettings(true);
```

Later action writes only `dismissed` and closes the dialog.

- [ ] **Step 4: Make Settings section requests reactive**

`SettingsPage` currently reads `initialSection` only in `useState`. Add a focused effect for `requestedSection` so a request works even if the user is already on Settings:

```ts
useEffect(() => {
  if (props.requestedSection !== undefined) {
    setActiveSection(props.requestedSection.section);
  }
}, [props.requestedSection]);
```

Keep ordinary manual Settings navigation behavior unchanged. The request ID is UI-only and is not persisted.

- [ ] **Step 5: Run focused tests and renderer build**

```powershell
corepack pnpm@10.15.0 --filter @lnwjud/desktop exec vitest run --config vitest.config.ts tests/guided-tunnel-setup-state.test.ts tests/guided-tunnel-setup-ui.test.ts
corepack pnpm@10.15.0 --filter @lnwjud/desktop build:renderer
```

Expected: PASS; no horizontal overflow in the built renderer smoke.

- [ ] **Step 6: Checkpoint**

Confirm existing configured tunnel status does not produce the Tips dialog in the pure decision tests.

---

### Task 5: Build the guided Secure Tunnel stepper

**Files:**
- Create: `apps/desktop/src/renderer/features/onboarding/GuidedTunnelSetup.tsx`
- Modify: `apps/desktop/src/renderer/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/settings-extra.css`
- Modify: `apps/desktop/tests/guided-tunnel-setup-ui.test.ts`

**Interfaces:**

```ts
interface GuidedTunnelSetupProps {
  readonly locale: UiLocale;
  readonly tunnel: TunnelStatus;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenExternal: (target: ExternalSetupTarget) => Promise<void>;
  readonly onSaveApiKey: (apiKey: string) => Promise<void>;
  readonly onConfigureProfile: (tunnelId: string) => Promise<string>;
  readonly onStartTunnel: () => Promise<TunnelStatus>;
  readonly onRefresh: () => Promise<void>;
  readonly onLocalComplete: () => void;
}
```

- [ ] **Step 1: Write failing rendering tests for all five steps**

Use `renderToStaticMarkup` with pristine, key-saved, profile-configured and running `TunnelStatus` fixtures. Assert:

- Thai and English titles/actions render
- Start Tunnel is disabled before `hasApiKey && profileExists`
- running state shows local-complete text and ChatGPT Plugins action
- raw API key is never rendered in status/summary markup
- only masked Tunnel ID from `tunnel.persistent?.tunnelIdMasked` may appear after configuration

- [ ] **Step 2: Implement Step 1 — create and paste Tunnel ID**

- Open only target `openai_tunnels`
- Validate locally with `/^tunnel_[A-Za-z0-9_-]{8,128}$/`
- Keep the full draft only in component memory
- Do not write draft to storage, log or error output
- Preserve the draft while link opening, validation, key saving or configure calls fail

- [ ] **Step 3: Implement Step 2 — create and save Runtime API key**

- Open only target `openai_api_keys`
- Password input defaults hidden; Show/Hide must be localized or use existing translated labels
- Disable Save for blank/whitespace-only value
- Await `onSaveApiKey(apiKey.trim())`
- Immediately after a successful `await onSaveApiKey(apiKey.trim())`, set API key React state to `''` and reset Show to false
- Also clear the API key draft when the guide unmounts, closes or leaves the key step; never persist it for resume
- Never include the key in caught error text or interpolation
- If `tunnel.hasApiKey` is already true, show Key stored and allow skipping directly to configure/start as appropriate

- [ ] **Step 4: Implement Step 3 — configure and doctor**

Call only the existing production path:

```ts
await onConfigureProfile(tunnelIdDraft.trim());
await onRefresh();
```

Do not duplicate `tunnel-client init`, DPAPI, YAML repair or doctor logic in renderer. The main process remains the authority through `TunnelController.configureProfile()`.

Success requires the refreshed dashboard to report `profileExists === true`. If IPC resolves but the profile is absent, keep the user on Configure and show a retryable error.

- [ ] **Step 5: Implement Step 4 — Start Tunnel**

Create a status-returning helper in `App.tsx` without breaking existing Home callbacks:

```ts
async function startTunnelWithStatus(): Promise<TunnelStatus> {
  setTunnelBusy(true);
  try {
    const status = await window.lnwjud.startTunnel();
    await refresh();
    return status;
  } finally {
    setTunnelBusy(false);
  }
}
```

The existing `startTunnel(): Promise<void>` may delegate to it for Home. Guided success requires returned `status.state === 'running'`; `error`, `stopped` or `starting` remains on the step and displays the sanitized status message.

When running:

```ts
writeGuidedTunnelSetupState(window.localStorage, 'completed');
onLocalComplete();
```

- [ ] **Step 6: Implement Step 5 — connect ChatGPT**

- Show that local setup is complete; do not claim ChatGPT is verified
- Open only target `chatgpt_plugins`
- Show the exact translated sequence: enable Developer mode if needed, add connection, choose Tunnel, select/paste Tunnel ID
- Done closes the guide but does not stop the tunnel

- [ ] **Step 7: Integrate into Settings and retain manual controls**

Render the guide first in the Secure Tunnel section. Keep existing API key/path/profile/persistent runtime controls under a collapsed `<details>` labeled `guidedTunnel.advanced`.

Existing users must still be able to:

- replace Runtime API key
- override bundled `tunnel-client` path for troubleshooting
- reconfigure profile
- reconnect same tunnel
- stop tunnel
- inspect persistent runtime status

- [ ] **Step 8: Add error-specific UX without swallowing evidence**

| Failure | Guided response |
|---|---|
| External link open rejected/fails | Show translated link error, exact allowlisted URL and Copy link action using existing `copyTextToClipboard` |
| Invalid Tunnel ID | Inline validation; do not invoke IPC |
| Empty API key | Inline required message; do not invoke IPC |
| Authentication/doctor failure | Stay on configure; tell user to verify key and Tunnels Read + Use; preserve Tunnel ID draft |
| Bundled client missing | State that installation is incomplete and offer Doctor/Advanced; do not send a first-time user to download random binaries |
| Tunnel liveness unverifiable/duplicate ownership | Show original sanitized main-process message and offer Live Logs; never spawn or kill a guessed process |
| Start returns non-running status | Keep Start enabled for retry after busy clears; do not mark onboarding complete |

- [ ] **Step 9: Run focused tests**

```powershell
corepack pnpm@10.15.0 --filter @lnwjud/desktop exec vitest run --config vitest.config.ts tests/guided-tunnel-setup-state.test.ts tests/guided-tunnel-setup-ui.test.ts tests/i18n.test.ts
corepack pnpm@10.15.0 --filter @lnwjud/desktop typecheck
```

Expected: PASS.

- [ ] **Step 10: Checkpoint**

Inspect rendered markup and diff. Search the diff for `sk-`, `apiKey`, URLs and competitor references; only expected input/state identifiers and allowlisted URLs may remain.

---

### Task 6: Add recovery entry points for Later and partial setup

**Files:**
- Modify: `apps/desktop/src/renderer/features/home/ControlCenterPage.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/tests/guided-tunnel-setup-ui.test.ts`

**Interfaces:**

```ts
// ControlCenterPageProps
readonly onOpenTunnelSetup: () => void;
```

- [ ] **Step 1: Add a Home card/button when local tunnel setup is incomplete**

Condition:

```ts
const tunnelConfigured = dashboard.tunnel.hasApiKey && dashboard.tunnel.profileExists;
```

When false, show `guidedTunnel.dismissedHint` and `guidedTunnel.openGuide`. Do not show a red error merely because setup is optional and unfinished.

- [ ] **Step 2: Add a permanent Open setup guide action in Settings > Secure Tunnel**

The action must work for `dismissed`, partial and configured states. Call `openGuidedTunnelSettings(tunnel.state !== 'running')` so manual opening writes `in_progress` only when the tunnel is not currently running; do not replace `completed` for a healthy configured tunnel.

- [ ] **Step 3: Resume from actual state**

Verify `initialGuidedTunnelStep` behavior:

```text
profileExists + running       -> connect_chatgpt
profileExists + not running   -> start
hasApiKey + no profile        -> create_tunnel (then configure; skip key save)
no key + existing profile     -> save_key (then start; do not recreate profile unless doctor requires it)
fresh                         -> create_tunnel
```

- [ ] **Step 4: Add regression tests**

Assert configured users do not receive auto Tips, dismissed users can reopen manually, and partial `in_progress` state returns `resume_settings`.

- [ ] **Step 5: Run focused tests**

```powershell
corepack pnpm@10.15.0 --filter @lnwjud/desktop exec vitest run --config vitest.config.ts tests/guided-tunnel-setup-state.test.ts tests/guided-tunnel-setup-ui.test.ts
```

Expected: PASS.

---

### Task 7: Add real desktop E2E smoke without live OpenAI credentials

**Files:**
- Create: `apps/desktop/e2e/guided-tunnel-setup.e2e.ts`

**Interfaces:**
- Consumes: built Electron main/preload/renderer, isolated `LNWJUD_DATA_PATH`, CDP launch pattern from existing desktop E2E
- Produces: evidence that a fresh local profile shows Tips and routes into Secure Tunnel correctly

- [ ] **Step 1: Launch an isolated fresh user-data directory**

Create the disposable test root only under `E:\lnwjud\.local-artifacts\e2e-guided-setup\<unique>` and always remove that exact verified child path in `finally`. Set `LNWJUD_DATA_PATH` and `--user-data-dir` to that same isolated root. Do not use `os.tmpdir()`, do not create a repository/worktree copy, and do not reference real `%APPDATA%\tunnel-client` credentials in this test.

- [ ] **Step 2: Verify the fresh-user path in Thai**

```ts
await expect(page.getByRole('dialog', { name: 'ตั้งค่า ChatGPT ให้ใช้ lnwjud' })).toBeVisible();
await page.getByRole('button', { name: 'เริ่มตั้งค่า' }).click();
await expect(page.getByRole('heading', { name: /Secure Tunnel/i })).toBeVisible();
await expect(page.getByText('1. สร้าง OpenAI Tunnel')).toBeVisible();
await expect(page.getByRole('button', { name: 'เปิดหน้า Tunnel Settings' })).toBeVisible();
```

Do not click external-link buttons in E2E; IPC allowlist tests cover the URL.

- [ ] **Step 3: Verify language switching**

Switch to English and assert the currently active step changes to the English copy without resetting drafts or navigating away.

- [ ] **Step 4: Verify Later and manual reopen in a second isolated launch**

Click Set up later, assert dialog closes, Home shows Open setup guide, click it and assert Settings/Tunnel opens.

- [ ] **Step 5: Run the E2E file**

```powershell
corepack pnpm@10.15.0 --filter @lnwjud/desktop test:e2e -- guided-tunnel-setup.e2e.ts
```

If the package script does not forward a filename to Playwright, run after the build command:

```powershell
corepack pnpm@10.15.0 --filter @lnwjud/desktop exec playwright test --config playwright.config.ts e2e/guided-tunnel-setup.e2e.ts
```

Expected: PASS; no real browser page, key, tunnel or external process is created.

---

### Task 8: Document the flow and run final gates

**Files:**
- Create: `docs/development/GUIDED_LOCAL_TUNNEL_SETUP.md`
- Modify only if conflict-free and still accurate: `README.md`, `docs/USAGE_TH.md`

- [ ] **Step 1: Write the user-facing guide**

Include:

- who sees Tips automatically
- exact five steps in Thai and English
- the three allowlisted URLs
- DPAPI/local-only credential boundary
- how to reopen the guide
- how to replace a revoked key
- how to run Doctor and inspect Live Logs
- clear statement that the local app can prove Tunnel Running but cannot prove the ChatGPT plugin was added

Do not duplicate unstable page screenshots. Text and URLs are easier to maintain when OpenAI changes UI.

- [ ] **Step 2: Run targeted Desktop tests**

```powershell
corepack pnpm@10.15.0 --filter @lnwjud/desktop exec vitest run --config vitest.config.ts tests/guided-tunnel-setup-state.test.ts tests/guided-tunnel-setup-ui.test.ts tests/external-setup-links.test.ts tests/i18n.test.ts tests/production-ipc-acceptance.test.ts tests/tunnel-controller.test.ts tests/tunnel-continuity-acceptance.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run static gates**

```powershell
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 --filter @lnwjud/desktop build
git diff --check
```

Expected: all exit code 0. If an unrelated dirty change fails a repository-wide gate, isolate and report the exact pre-existing failure; do not edit or commit that unrelated work.

- [ ] **Step 4: Perform manual bilingual acceptance**

Use a disposable Desktop data directory, not the real user profile:

1. Fresh state shows Tips once.
2. Start setup opens Settings > Secure Tunnel automatically.
3. Both external link buttons open only the intended official HTTPS pages.
4. Invalid Tunnel ID never reaches IPC.
5. Blank API key cannot be saved.
6. Language switch updates every visible instruction.
7. Later closes Tips and Home/Settings can reopen it.
8. Existing configured state does not auto-open Tips.
9. No plaintext key appears in logs, DevTools markup, incident export or storage.
10. A mocked/controlled successful configure and start reaches Running and shows ChatGPT Plugins instructions.

- [ ] **Step 5: Final secret and naming audit**

Inspect only the feature diff:

```powershell
git diff -- packages/ipc-contracts/src/index.ts apps/desktop/src docs/development/GUIDED_LOCAL_TUNNEL_SETUP.md
git diff --check
```

Confirm:

- no plaintext secret
- no arbitrary URL opening
- no competitor reference
- no cloud service/domain/OAuth addition
- no changes to release/timeout/tunnel lifecycle contracts

- [ ] **Step 6: Optional path-scoped commit, only when authorized**

If the user explicitly authorizes a commit, stage only the reviewed feature paths and use:

```powershell
git commit -m "feat(desktop): guide first-time tunnel setup"
```

Never use `git add .` in the current dirty working tree. Do not push.

---

## Definition of Done

- [ ] A pristine user sees bilingual Tips without opening Terminal
- [ ] Start setup automatically navigates to Settings > Secure Tunnel
- [ ] The guide explains and links every required OpenAI/ChatGPT step
- [ ] Tunnel ID and Runtime API key inputs validate locally
- [ ] Runtime API key uses the existing DPAPI path and is cleared from renderer state after save
- [ ] Configure uses the existing `TunnelController.configureProfile()` and doctor path
- [ ] Start Tunnel is available only after key/profile readiness and completes only on `running`
- [ ] Existing configured users are not interrupted
- [ ] Later/manual reopen/partial resume work
- [ ] External links are exact allowlisted HTTPS targets opened from trusted IPC only
- [ ] Thai/English keys are complete and parity-tested
- [ ] Focused tests, E2E smoke, lint, typecheck, Desktop build and diff-check pass
- [ ] No installer, release, push or unrelated working-tree mutation occurred

## AI Execution Notes

1. Execute tasks in order; do not start UI work before the state and IPC tests pass.
2. Re-read every target file immediately before patching because several files may change concurrently.
3. After each task, update the Progress Tracker in this file only if the user asked the implementing AI to maintain progress.
4. If official URLs or OpenAI permission wording differ at implementation time, verify against the two official docs above, update the centralized URL/copy only, and record the evidence in the final report.
5. Stop and ask the user only if a required official action cannot be represented without cloud infrastructure, browser automation, or broader permissions; do not silently expand scope.
