# lnwjud v4.60.0 — Native Ponytail Skill Policy + Enforced Auto-Activation Wayfinder Plan

> Status: **PLAN ONLY — implementation not started**  
> Target version: **4.60.0**  
> Target branch: `dev`  
> Baseline inspected: `2ce5c3539f975fa94ca640d8d6cda7ca55edb7db`  
> Plan date: 2026-09-09  
> Execution map: Wayfinder-based architecture/code-path inspection

---

# 1. เป้าหมาย

ทำให้ Ponytail เป็น **Native Optional Skill Policy ของ lnwjud** ที่ใช้ skill จริง ไม่ใช่ checkbox ที่มีแต่หน้าตา และไม่ฝากความหวังทั้งหมดไว้กับ `skill_match` หรือการที่ host model จะใจดีทำตาม instruction เอง

v4.60.0 ต้องมีคุณสมบัติหลักดังนี้:

1. ฝัง Ponytail skills มากับ lnwjud แบบเดียวกับ `.agents/skills/lnwjud-scheduled-continuation`
2. โหลด skill ผ่าน skill catalog / `skill_load` ของ lnwjud จริง
3. Auto path ต้องเรียก **exact bundled skill ID โดยตรง** และ **ไม่ขึ้นกับ `skill_match`**
4. มีโหมด `OFF / LITE / FULL / ULTRA`
5. มี policy precedence ระดับ `Current Goal > Workspace > Global`
6. Global default = **OFF**
7. เมื่อเปิด Ponytail แต่ไม่ได้เลือก intensity เป็นพิเศษ ให้ใช้ upstream default = **FULL**
8. Ponytail อยู่ต่ำกว่า lnwjud governance เสมอ
9. FULL/ULTRA coding flow ต้องมี Ponytail review pass หลังแก้โค้ด
10. ต้องพิสูจน์ด้วย test ว่า mutation ถูก block จริงถ้ายังไม่ได้โหลด bundled Ponytail

สถาปัตยกรรมเป้าหมาย:

```text
User instruction
      ↓
lnwjud Core Governance
  Security / Approval
  Goal lifecycle / leases
  Durable continuation
  Tool contracts
  Recovery / compatibility
      ↓
Wayfinder / project rules
      ↓
Resolved Ponytail Policy
  Current Goal > Workspace > Global > OFF
      ↓
Bundled skill activation
  exact skill_load, no skill_match dependency
      ↓
Coding mutation gate
      ↓
Implementation
      ↓
Ponytail review gate (FULL / ULTRA)
```

---

# 2. Upstream ที่ตรวจสอบแล้ว

Repository:

```text
https://github.com/DietrichGebert/ponytail
```

Pinned upstream commit สำหรับ v4.60.0:

```text
356918eba965ee1eac64bd3a7f0dd02108350de5
```

License:

```text
MIT
Copyright (c) 2026 DietrichGebert
```

จาก Git tree ของ commit นี้ upstream มี canonical skills ใต้ `skills/` จำนวน 6 ตัว:

| Skill | Upstream path | Purpose ใน lnwjud |
|---|---|---|
| `ponytail` | `skills/ponytail/SKILL.md` | primary coding policy |
| `ponytail-review` | `skills/ponytail-review/SKILL.md` | post-change simplicity review |
| `ponytail-audit` | `skills/ponytail-audit/SKILL.md` | architecture/simplicity audit |
| `ponytail-debt` | `skills/ponytail-debt/SKILL.md` | technical-debt cleanup |
| `ponytail-gain` | `skills/ponytail-gain/SKILL.md` | estimate/explain complexity savings |
| `ponytail-help` | `skills/ponytail-help/SKILL.md` | Ponytail help/status guidance |

Upstream ยังมี hooks, adapters และ `ponytail-mcp` แต่ v4.60.0 **ไม่ vendor runtime/plugin/MCP เหล่านั้นเป็นกลไกหลัก** เพราะ lnwjud มี skill catalog, MCP control plane, goal lifecycle, permissions และ activity tracking ของตัวเองอยู่แล้ว

หลักสำคัญจาก upstream main skill:

- ใช้กับ coding task
- YAGNI ก่อน
- reuse code เดิมก่อนเขียนใหม่
- stdlib/native platform ก่อน dependency ใหม่
- minimum correct diff
- root-cause fix แทน patch symptom
- intensity `lite`, `full`, `ultra`
- upstream default = `full`
- ห้าม simplify ทิ้ง security, validation, error handling ที่ป้องกัน data loss, accessibility basics หรือ requirement ที่ผู้ใช้สั่งชัดเจน
- ต้องเข้าใจ flow จริงก่อนเลือก solution ที่สั้นที่สุด

---

# 3. Architectural findings จาก lnwjud ปัจจุบัน

## 3.1 Bundled skill pipeline มีอยู่แล้ว

precedent:

```text
.agents/skills/lnwjud-scheduled-continuation/SKILL.md
```

packaging:

```yaml
- from: ../../.agents/skills/lnwjud-scheduled-continuation
  to: agent-skills/lnwjud-scheduled-continuation
```

`packages/extensions/src/create-local-extensions.ts` เพิ่ม packaged root `resources/agent-skills` เข้า SkillCatalog อยู่แล้ว

ดังนั้น Ponytail ต้อง reuse pipeline นี้ ไม่สร้าง plugin loader ใหม่

## 3.2 SkillCatalog โหลด exact ID ได้จริงโดยไม่ต้องใช้ skill_match

`packages/extensions/src/skill-catalog.ts` รองรับ:

```text
skills_list / list()
skills_read / read()
skill_load -> extensions.readSkill()
```

รูปแบบ bundled source ปัจจุบัน:

```text
source = bundled:agent-skills
```

ดังนั้น exact IDs ของ v4.60.0 ต้องเป็น:

```text
bundled:agent-skills/ponytail
bundled:agent-skills/ponytail-review
bundled:agent-skills/ponytail-audit
bundled:agent-skills/ponytail-debt
bundled:agent-skills/ponytail-gain
bundled:agent-skills/ponytail-help
```

`SkillCatalog.read()` จะเลือก exact ID ก่อน name lookup อยู่แล้ว จึงสามารถ fail-closed ต่อ source collision ได้

### สำคัญ: ห้าม nest 6 skills ไว้ใต้โฟลเดอร์ Ponytail เดียว

`walkForSkills()` ปัจจุบันมี behavior:

```text
ถ้า directory ปัจจุบันมี SKILL.md -> push skill แล้ว return
```

ดังนั้นรูปแบบนี้ **ผิด**:

```text
.agents/skills/ponytail/
  SKILL.md
  review/SKILL.md
  audit/SKILL.md
```

เพราะ walker จะหยุดที่ `ponytail/SKILL.md` แล้วไม่ลง child folders

รูปแบบที่ถูกต้องคือ sibling directories:

```text
.agents/skills/
├── ponytail/
├── ponytail-review/
├── ponytail-audit/
├── ponytail-debt/
├── ponytail-gain/
└── ponytail-help/
```

## 3.3 `skill_match` เป็น discovery helper ไม่ใช่ activation contract

ปัจจุบัน:

- `skill_match` ค้นชื่อ/description ตาม intent
- `skill_load` โหลด skill จริงผ่าน extension service

Auto Ponytail ต้องใช้:

```text
exact skill_load("bundled:agent-skills/ponytail")
```

โดยตรง

`skill_match` ใช้ได้สำหรับ manual discovery หรือ generic skill suggestions แต่ **ไม่เป็น dependency ของ Native Ponytail Auto Mode**

ถ้า `skill_match` เสีย, คืน 0 result หรือ ranking เพี้ยน แต่ bundled exact ID ยัง load ได้ ฟีเจอร์ Ponytail ต้องยังทำงาน

## 3.4 ToolRegistry.invoke คือ enforcement boundary ที่เหมาะสม

`packages/mcp-server/src/tool-registry.ts` เป็น central invocation path สำหรับ:

- direct MCP tool call
- permission/profile checks
- Active Project mutation scope
- goal mutation fence
- host approval
- mutation classification
- `tool_batch` children

เอกสารของ lnwjud ระบุชัดว่า `tool_batch` ส่ง child ทุกตัวกลับผ่าน `ToolRegistry.invoke`

ดังนั้น Ponytail activation gate ที่อยู่ใน registry จะปิดช่อง bypass direct/batch ได้โดยไม่ต้องเขียน guard ซ้ำทุก tool

## 3.5 Goal ปัจจุบันยังไม่มี policy metadata

`GoalRecord` / `GoalSnapshot` / SQLite `goals` table ไม่มี Ponytail mode หรือ generic policy metadata

ถ้าจะรองรับ `Current Goal > Workspace > Global` แบบ native จริง ต้องเพิ่ม field durable ให้ goal ไม่ใช่เก็บ state ลอย ๆ ใน memory

## 3.6 Workspace มี project profile ที่ reuse ได้

`project_profile_get/set` ใช้ไฟล์:

```text
.lnwjud/project-profile.json
```

validator รองรับ arbitrary JSON-compatible fields โดยมีขอบเขตและกัน secret-bearing keys อยู่แล้ว

Workspace Ponytail override จึงควร reuse project profile แทนสร้าง workspace-settings database ใหม่

---

# 4. Governance contract

Ponytail เป็น optimization policy ไม่ใช่ authority สูงสุด

ลำดับ precedence:

```text
1. Security / trust boundary / permission profile
2. Explicit user instruction
3. Goal lifecycle / goal lease / durable continuation
4. Recovery / checkpoint / rollback invariants
5. MCP/tool contracts and platform constraints
6. Cross-platform compatibility requirements
7. Installer / packaging / CI / release verification
8. Wayfinder / project-specific rules
9. Ponytail optimization
```

เพิ่ม first-party invariant ของ lnwjud:

> Ponytail may minimize implementation, but MUST NOT simplify away lnwjud invariants, durability, safety, recovery, compatibility, observability, required tests, release verification, or explicit user requirements.

ตัวอย่างที่ Ponytail ห้ามตัดเพราะดูเหมือน boilerplate:

- stale/ghost lease recovery
- process/task liveness verification
- durable goal checkpoint
- scheduled continuation cleanup
- Recovery Trash/checkpoint boundary
- explicit approval boundary
- Active Project mutation scope
- Windows/macOS/Linux parity
- Setup/Portable/AppImage/DMG/DEB verification
- MCP schema/input validation
- installer smoke tests
- CI/release gate
- observability/activity evidence ที่ acceptance criteria ต้องใช้

---

# 5. Ponytail policy model

## 5.1 Mode

เพิ่ม shared type:

```ts
export type PonytailMode = 'off' | 'lite' | 'full' | 'ultra';
```

Global default:

```ts
export const DEFAULT_PONYTAIL_MODE: PonytailMode = 'off';
```

Interpretation:

| Mode | Behavior |
|---|---|
| `off` | ไม่มี auto activation/gate; manual skill load ยังได้ |
| `lite` | โหลด primary Ponytail แต่ build ตาม requirement เต็ม พร้อมเสนอทางที่ง่ายกว่า |
| `full` | enforce Ponytail ladder + minimal correct diff + review pass |
| `ultra` | aggressive YAGNI/deletion-first แต่ยังอยู่ใต้ lnwjud governance + review pass |

ถ้าผู้ใช้กด “เปิด Ponytail” โดยไม่ได้เลือกระดับ ให้ UI/default selection เป็น `full`

แต่ install/upgrade ใหม่ที่ไม่มีค่าเดิมต้องเป็น `off`

## 5.2 Scope precedence

```text
Current Goal override
        ↓ if unset/inherit
Workspace override
        ↓ if unset/inherit
Global setting
        ↓
Default OFF
```

resolved object:

```ts
interface ResolvedPonytailPolicy {
  mode: PonytailMode;
  source: 'goal' | 'workspace' | 'global' | 'default';
  enabled: boolean;
  requirePrimarySkill: boolean;
  requireReviewPass: boolean;
}
```

recommended semantics:

```text
requirePrimarySkill = mode !== 'off'
requireReviewPass = mode === 'full' || mode === 'ultra'
```

---

# 6. Persistence design

## 6.1 Global

เพิ่ม:

```text
USER_SETTING_KEYS.ponytailMode = ponytail_mode
```

value:

```text
off | lite | full | ultra
```

missing/invalid key -> `off`

ไม่ต้อง DB migration เพราะ global settings เป็น key-value

## 6.2 Workspace

reuse:

```text
.lnwjud/project-profile.json
```

field:

```json
{
  "ponytail": {
    "mode": "full"
  }
}
```

missing `ponytail.mode` = inherit Global

allowed values:

```text
off | lite | full | ultra
```

ไม่เก็บ `inherit` ลงไฟล์ก็ได้; absence คือ inherit

runtime ต้องมี direct project-profile policy reader/cache ไม่เรียก `project_profile_get` ผ่าน MCP ซ้อนจาก ToolRegistry

## 6.3 Current Goal

เพิ่ม optional durable field:

```ts
ponytailMode?: PonytailMode
```

ใน:

- `GoalRecord`
- `GoalSnapshot`
- storage row/schema
- migration ใหม่ของ goals table

SQLite แนะนำ column:

```sql
ponytail_mode TEXT NULL
```

`NULL` = inherit Workspace/Global

ต้อง validate allowed values ตอน read/write; corrupt value ต้องไม่ silently เปิด aggressive mode ให้ fallback เป็น inherit/off ตาม contract ที่กำหนดและรายงาน corruption ตาม style ของ GoalRepository

`run_goal` เพิ่ม optional input:

```ts
ponytailMode?: 'off' | 'lite' | 'full' | 'ultra'
```

เมื่อสร้าง goal:

- supplied -> pin override กับ goal
- omitted -> inherit

เมื่อ resume goal เดิม:

- omitted -> preserve existing override
- supplied -> update ผ่าน repository CAS/lease-safe path เท่านั้น

ห้ามเปลี่ยน goal policy ผ่านการเขียน DB ดิบ ๆ จาก UI

---

# 7. Bundled skill layout

เพิ่ม exact upstream snapshots เป็น sibling directories:

```text
.agents/skills/ponytail/SKILL.md
.agents/skills/ponytail-review/SKILL.md
.agents/skills/ponytail-audit/SKILL.md
.agents/skills/ponytail-debt/SKILL.md
.agents/skills/ponytail-gain/SKILL.md
.agents/skills/ponytail-help/SKILL.md
```

provenance/license:

ทางเลือกที่ลด duplication:

```text
.agents/skills/ponytail/SOURCE.md
.agents/skills/ponytail/LICENSE
```

และแต่ละ sibling skill มี `SOURCE.md` สั้น ๆ ที่ชี้ pinned upstream path/commit + license location

หรือเก็บ license ซ้ำในแต่ละ directory ถ้า packaging/test contract ต้องการ skill folder self-contained

Acceptance สำคัญ:

- exact upstream `SKILL.md` content
- pin commit ไม่ fetch floating `main` ตอน build
- ไม่มี upstream hooks/runtime executables ถูกเรียกโดยอัตโนมัติ
- ไม่มี network dependency ตอน runtime

---

# 8. Packaging

แก้:

```text
apps/desktop/electron-builder.yml
```

เพิ่ม top-level resources ทั้ง 6 skill:

```yaml
- from: ../../.agents/skills/ponytail
  to: agent-skills/ponytail
- from: ../../.agents/skills/ponytail-review
  to: agent-skills/ponytail-review
- from: ../../.agents/skills/ponytail-audit
  to: agent-skills/ponytail-audit
- from: ../../.agents/skills/ponytail-debt
  to: agent-skills/ponytail-debt
- from: ../../.agents/skills/ponytail-gain
  to: agent-skills/ponytail-gain
- from: ../../.agents/skills/ponytail-help
  to: agent-skills/ponytail-help
```

ใช้ top-level `extraResources` เพื่อให้ Windows/macOS/Linux ได้ contract เดียวกัน

ห้ามทำ platform-specific skill copies ถ้าไม่มีเหตุผล

---

# 9. Real Auto Activation: ไม่พึ่ง skill_match

นี่คือส่วนที่ต่างจากแผนเดิมและเป็น requirement บังคับ

## 9.1 Exact bundled load path

เมื่อ effective Ponytail mode != `off` และเป็น coding flow:

```text
DO NOT:
  skill_match("ponytail") -> hope result is correct

DO:
  skill_load("bundled:agent-skills/ponytail")
```

ถ้า exact bundled load ล้มเหลว:

- ห้าม fallback เงียบไป workspace/user skill ชื่อเดียวกัน
- report skill unavailable
- coding mutation gate ต้องยังไม่ถือว่า activated
- user สามารถแก้ installation/package แล้ว retry

## 9.2 Session/goal activation state

เพิ่ม lightweight activation ledger ใน MCP runtime/registry scope เช่น:

```ts
interface PonytailActivationState {
  policyFingerprint: string;
  primarySkillLoaded: boolean;
  primarySkillId?: string;
  primaryLoadedAt?: string;
  codeMutationGeneration: number;
  reviewGeneration: number;
  sessionSuppressed: boolean;
}
```

key อย่างน้อยต้องแยก:

```text
sessionId + workspaceId + goalId(optional)
```

policy fingerprint ต้องเปลี่ยนเมื่อ effective mode/source เปลี่ยน เพื่อไม่ reuse activation stale จาก policy เก่า

activation ถูก mark ได้ **เฉพาะหลัง `skill_load` exact bundled Ponytail สำเร็จจริง**

ห้าม mark จาก `skill_match`, `skills_list` หรือ instruction text

## 9.3 Mutation activation gate

เพิ่ม guard ใน `ToolRegistry.invoke()` หลัง:

- tool parse
- active workspace routing
- mutation classification
- policy resolution

แต่ก่อน actual mutation execution

concept:

```ts
if (
  effectivePonytail.mode !== 'off'
  && isCodingMutation(tool.name, input)
  && !activation.primarySkillLoaded
  && !activation.sessionSuppressed
) {
  return recoverable CONFLICT:
    "Ponytail FULL is active. Load bundled:agent-skills/ponytail, then retry this mutation."
}
```

ใช้ existing `CONFLICT` recoverable contract ก่อน ไม่เพิ่ม public AppErrorCode ใหม่โดยไม่จำเป็น

### Gate ต้องไม่ถูก Full Bypass ข้าม

Full Bypass คือ authorization mode ไม่ใช่ permission ให้ bypass correctness policy

ดังนั้น:

```text
Permission Full Bypass != Ponytail policy bypass
```

ผู้ใช้ต้องปิด Ponytail policy / set goal override `off` / temporary normal mode เองถ้าต้องการไม่ใช้

## 9.4 Coding mutation classification

ห้าม block ทุก mutation เพราะการแก้ README ไม่ได้ต้องเรียก Ponytail ทุกครั้ง

สร้าง helper deterministic เช่น:

```ts
isCodingMutation(toolName, input): boolean
```

ครอบคลุมอย่างน้อย:

- `write_file`, `edit_file`, `apply_patch` เมื่อ target เป็น development artifact
- `lsp_rename`
- code-generating/refactoring tools ที่ write source
- `tool_batch` child จะถูกตรวจแยกเมื่อกลับเข้าระบบ registry

ตัวอย่าง development artifact:

```text
.ts .tsx .js .jsx .mjs .cjs
.py .go .rs .java .kt .cs
.c .cc .cpp .h .hpp
.swift .rb .php
.vue .svelte
.sql
.json/yaml/toml เฉพาะ project/build/tooling config ที่ชัดเจน
package.json
*config.*
tsconfig*.json
Dockerfile
Makefile
```

ไม่ block โดย default:

- `.md`
- `.txt`
- images/assets
- documentation-only edits

classification ต้อง conservative เพื่อไม่ทำให้ Ponytail กลายเป็นประตูเก็บค่าผ่านทางของทุกไฟล์ในโลก

---

# 10. MCP initialization instruction ยังต้องมี แต่ไม่ใช่ enforcement เดียว

แก้:

```text
packages/mcp-server/src/server.ts
```

เปลี่ยนจาก constant-only เป็น builder เช่น:

```ts
buildMcpInstructions({ ponytailPolicy })
```

Base instructions เดิมต้องยังอยู่ครบ

เมื่อ mode != off append directive สั้น ๆ:

```text
For coding tasks, the resolved lnwjud Ponytail policy is FULL. Load the exact bundled skill bundled:agent-skills/ponytail before the first code mutation and follow it at the selected intensity. Do not substitute workspace/user copies. Ponytail is subordinate to lnwjud security, approvals, durable goals, recovery, compatibility, observability, required tests, release verification, project rules, and explicit user instructions.
```

เหตุผลที่ยังมี instruction:

- ทำให้ agent proactive load skill ก่อนชน gate
- ลด failed/retry tool call
- บอก intensity/context ล่วงหน้า

แต่ correctness ไม่ฝากไว้กับ instruction เพราะ gate ตรวจซ้ำจริง

---

# 11. Temporary user opt-out / normal mode

upstream รองรับแนวคิด `stop ponytail` / `normal mode`

lnwjud ควรตีความเป็น **session-scoped suppression** ไม่แก้ persisted Global/Workspace/Goal setting อัตโนมัติ

ตัวอย่าง:

```text
Global = FULL
Goal = inherit
User: "normal mode งานนี้"
```

ผล:

```text
sessionSuppressed = true
persisted policy ยัง FULL
```

ถ้าผู้ใช้สั่ง `/ponytail full` หรือ “กลับมาใช้ Ponytail” ใน session เดิม ให้ clear suppression และ re-load exact bundled skill ถ้า policy fingerprint/mode เปลี่ยน

v4.60.0 ไม่จำเป็นต้องสร้าง slash-command parser เต็มระบบถ้า host ไม่มี command channel; instruction + session policy action ที่ tool/runtime expose อยู่แล้วพอ แต่ state ต้องมีตำแหน่งจริง ไม่ใช่หวังให้ model จำเอง

ถ้าต้องเพิ่ม tool surface ให้ prefer extension ของ existing session policy mechanism มากกว่าสร้าง generic command framework

---

# 12. Ponytail Review Pass

## 12.1 Auto review scope

`FULL` และ `ULTRA`:

- code mutation เกิดขึ้น -> `codeMutationGeneration += 1`
- review valid เฉพาะเมื่อ `reviewGeneration === codeMutationGeneration`
- ต้อง load exact:

```text
bundled:agent-skills/ponytail-review
```

แล้วใช้ diff/change context จริง เช่น:

```text
review_changes
changed_symbols / affected_modules ตามความจำเป็น
```

review ต้องเช็กอย่างน้อย:

- abstraction เกินจำเป็นหรือไม่
- dependency ใหม่ที่ไม่ต้องใช้หรือไม่
- helper/type/pattern ซ้ำของเดิมหรือไม่
- stdlib/native API ทำแทนได้หรือไม่
- code/file ไหนลบได้หรือ simplify ได้
- root-cause ถูกแก้หรือแค่ symptom
- simplification ไม่ทำลาย lnwjud invariants

`LITE`:

- primary Ponytail required
- review pass ไม่ mandatory

`OFF`:

- ไม่มี auto review requirement

## 12.2 Durable Goal completion gate

สำหรับ goal ที่ FULL/ULTRA และมี code mutation:

`finish_goal(status=completed)` ต้อง reject แบบ recoverable conflict ถ้า review generation stale/missing

ตัวอย่าง remediation:

```text
Load bundled:agent-skills/ponytail-review, review the latest diff, then retry finish_goal.
```

นี่ทำให้ long-running/release work ไม่สามารถ “ลืม review” เพราะ model รีบจบได้ง่าย ๆ

## 12.3 Non-goal limitation ที่ต้องพูดตามจริง

MCP server ไม่สามารถบังคับข้อความ final ของ host model ได้ 100% ถ้าไม่มี goal completion call

สำหรับ non-goal session เราทำได้:

- proactive instruction
- activation/review ledger
- block subsequent code mutation ตาม policy
- telemetry/activity evidence

แต่ไม่ควรอ้างว่า server สามารถป้องกัน model จากการส่ง final text โดยไม่ review ได้ทุก host

ถ้าต้องการ deterministic final-response gate ในอนาคต ต้องมี agent orchestration/proxy layer ซึ่งเป็น non-goal ของ v4.60.0

---

# 13. Secondary Ponytail skills routing

ฝังครบ 6 ตัว แต่ **ไม่ auto-load ทั้ง 6 ทุก coding request** เพราะนั่นสวนทางกับ Ponytail เองอย่างน่าขันพอสมควร

Native routing:

| Intent | Skill |
|---|---|
| coding/fix/refactor/design | `ponytail` |
| post-change simplicity review | `ponytail-review` |
| architecture/codebase simplicity audit | `ponytail-audit` |
| explicit technical-debt cleanup | `ponytail-debt` |
| explain/estimate simplification gains | `ponytail-gain` |
| Ponytail help/status/usage | `ponytail-help` |

`ponytail` + `ponytail-review` เป็น auto policy path หลัก

อีก 4 ตัวให้ route ตาม explicit intent/host instruction หรือ user request

สำหรับ secondary routing `skill_match` ใช้เป็น helper ได้ แต่ exact bundled IDs ต้องเป็น final target สำหรับ Native Ponytail family

---

# 14. Settings UI

## 14.1 Global

ตำแหน่ง:

```text
Settings > MCP & Extensions > Ponytail
```

UI:

```text
Ponytail coding policy
○ Off   (default)
○ Lite
○ Full
○ Ultra
```

TH description:

```text
ใช้ bundled Ponytail skills เพื่อให้ agent เลือกวิธีแก้ที่เรียบง่ายและลด over-engineering โดยยังคงกฎความปลอดภัย, durable goal, recovery, cross-platform และ verification ของ lnwjud ครบถ้วน
```

## 14.2 Workspace override

เมื่อมี Active Project:

```text
Workspace Ponytail override
○ Inherit Global
○ Off
○ Lite
○ Full
○ Ultra
```

persist ใน `.lnwjud/project-profile.json`

## 14.3 Current Goal override

เมื่อมี active durable goal:

```text
Current Goal Ponytail override
○ Inherit Workspace
○ Off
○ Lite
○ Full
○ Ultra
```

persist ใน GoalRecord

## 14.4 Effective state badge

แสดงค่าที่ resolve แล้ว เช่น:

```text
Effective: FULL · Current Goal
```

หรือ:

```text
Effective: OFF · Global default
```

ผู้ใช้ต้องเห็นทั้ง configured value และ effective source ไม่ใช่ต้องเดา inheritance เองเหมือน config ระบบ enterprise ยุคหิน

---

# 15. Shared/runtime implementation map

## Phase 1 — Vendor six upstream skills

New:

```text
.agents/skills/ponytail/*
.agents/skills/ponytail-review/*
.agents/skills/ponytail-audit/*
.agents/skills/ponytail-debt/*
.agents/skills/ponytail-gain/*
.agents/skills/ponytail-help/*
```

## Phase 2 — Package six skills

Modify:

```text
apps/desktop/electron-builder.yml
```

## Phase 3 — Shared Ponytail policy types

Modify/new appropriate shared module:

```text
packages/shared/src/user-settings.ts
packages/shared/src/...ponytail-policy.ts (only if reuse justifies separate file)
```

Add:

```ts
PonytailMode
DEFAULT_PONYTAIL_MODE
parsePonytailMode()
```

## Phase 4 — Global settings IPC/persistence

Modify:

```text
packages/ipc-contracts/src/index.ts
apps/desktop/src/main/desktop-services.ts
apps/desktop/src/main/main.ts
apps/desktop/src/preload/index.ts
apps/desktop/src/renderer/features/settings/UserConfigPanel.tsx
```

Replace previous boolean concept with mode enum

## Phase 5 — Workspace resolver

Add small first-party resolver around `.lnwjud/project-profile.json`

Responsibilities:

- safe read
- parse only `ponytail.mode`
- missing -> inherit
- cache by workspace + file freshness if useful
- no recursive MCP call

## Phase 6 — Goal policy persistence

Modify:

```text
packages/domain/src/goal-continuation.ts
packages/application/src/goal-continuation-service.ts
packages/storage/src/goal-repository.ts
packages/storage/src/migrations/*
packages/mcp-server/src/tools/goal-tools.ts
```

Add optional goal mode + migration + run_goal input/response

## Phase 7 — Policy resolver

Add first-party service/helper:

```text
resolvePonytailPolicy(goal, workspaceProfile, globalMode)
```

No generic policy framework yet

## Phase 8 — Skill activation ledger

Add runtime/session-scoped ledger tied to:

```text
session + workspace + optional goal
```

Mark from successful exact bundled `skill_load`

## Phase 9 — ToolRegistry activation gate

Modify:

```text
packages/mcp-server/src/tool-registry.ts
```

Block first coding mutation until exact bundled primary skill loaded

## Phase 10 — MCP instructions

Modify:

```text
packages/mcp-server/src/server.ts
```

Include resolved mode/governance + exact skill ID

## Phase 11 — Review completion gate

Integrate:

- code mutation generation
- exact `ponytail-review` load
- `review_changes` evidence
- durable `finish_goal` completion check for FULL/ULTRA coding goals

## Phase 12 — Transport parity

Ensure providers/options flow through:

```text
Desktop HTTP
Secure Tunnel
Packaged Electron STDIO
Pure Node/CLI STDIO
```

หนึ่ง policy resolver contract ต้องใช้ได้ทุก transport

---

# 16. Test plan

## 16.1 Bundling/discovery

ต้องมี tests:

- six bundled skills ถูก discover ครบ
- exact IDs ถูกต้อง
- `trustTier = bundled`
- read/load ทั้ง 6 สำเร็จ
- sibling directory contract ถูกทดสอบ
- global/workspace skill ชื่อซ้ำไม่ shadow exact bundled ID

## 16.2 No skill_match dependency

เพิ่ม explicit regression:

1. mock `skill_match` ให้ return 0 matches หรือ failure
2. direct `skill_load("bundled:agent-skills/ponytail")` ยังสำเร็จ
3. activation ledger mark success
4. code mutation retry ผ่าน

Acceptance นี้สำคัญมาก เพราะเป็น requirement ที่ผู้ใช้ระบุโดยตรง

## 16.3 Activation gate

RED/GREEN tests:

- `mode=off` -> code mutation baseline ผ่านตาม permission เดิม
- `mode=full`, primary not loaded -> code mutation returns recoverable `CONFLICT`
- exact bundled load success -> same mutation retry ผ่าน
- load workspace `ponytail` อย่างเดียว -> gate ยัง block
- `skills_list`/`skill_match` อย่างเดียว -> gate ยัง block
- docs-only edit -> ไม่โดน Ponytail gate
- `tool_batch` child code mutation -> โดน gate ผ่าน central registry
- Full Bypass -> ยังโดน Ponytail activation gate
- user/session normal mode -> gate suppressed ตาม explicit user request

## 16.4 Policy precedence

matrix:

| Global | Workspace | Goal | Effective |
|---|---|---|---|
| off | inherit | inherit | off/global |
| full | inherit | inherit | full/global |
| full | lite | inherit | lite/workspace |
| full | off | inherit | off/workspace |
| lite | ultra | full | full/goal |
| off | full | ultra | ultra/goal |

invalid workspace/goal value ต้อง fail safely ไม่เปิด ultra เอง

## 16.5 Goal durability

- goal override survive runtime restart
- resume goal preserve mode when omitted
- explicit valid update obeys CAS/lease rules
- migration old DB -> null/inherit without data loss

## 16.6 Review pass

FULL/ULTRA:

- code mutation sets review stale
- primary skill load does not satisfy review
- `ponytail-review` load before latest mutation does not satisfy later generation
- load review + review latest diff -> generation current
- another code mutation -> review stale again
- `finish_goal(completed)` rejects stale review
- after current review -> finish allowed if all other goal invariants pass

LITE/OFF:

- no mandatory review completion gate

## 16.7 Governance regression

เปิด ULTRA แล้วต้องยังไม่สามารถ:

- bypass permission
- bypass Active Project
- bypass goalLease
- skip required checkpoint/recovery contract
- bypass protected delete
- bypass cross-platform/release acceptance requirement

## 16.8 Packaging

ตรวจ all targets include:

```text
resources/agent-skills/ponytail
resources/agent-skills/ponytail-review
resources/agent-skills/ponytail-audit
resources/agent-skills/ponytail-debt
resources/agent-skills/ponytail-gain
resources/agent-skills/ponytail-help
```

## 16.9 Real host acceptance

packaged v4.60.0:

### Case A — OFF

coding request:

- no Ponytail gate/instruction activation
- no required `skill_load`

### Case B — FULL

coding request:

- agent ideally loads exact bundled skill proactively
- ถ้า agent ไม่โหลดแล้วพยายาม mutate -> registry blocks
- agent receives exact remediation
- exact `skill_load` succeeds
- retry mutation succeeds

นี่คือ proof ว่า feature “ใช้ skill จริง” ไม่ใช่แค่ prompt suggestion

### Case C — skill_match broken

- force/mock matcher unavailable/zero result
- exact bundled load path still works
- coding mutation proceeds after load

### Case D — collision

workspace contains fake:

```text
.agents/skills/ponytail/SKILL.md
```

Auto policy must still require:

```text
bundled:agent-skills/ponytail
```

### Case E — FULL review

- mutate code
- attempt complete goal before review -> blocked
- load bundled `ponytail-review` + latest diff review
- completion allowed after all normal goal checks pass

### Case F — non-coding

translation/docs-only request:

- no code activation gate
- no forced Ponytail load

---

# 17. Documentation updates

หลัง implementation ผ่าน:

```text
FULL_README.md
docs/LNWJUD_CAPABILITIES.md
docs/development/PACKAGING_WINDOWS.md
docs/architecture/UPGRADE_ARCHITECTURE.md
docs/architecture/TOOL_CONTRACT.md   # เฉพาะ activation/completion policy boundary ที่เพิ่มจริง
```

ต้องอธิบาย:

- Ponytail เป็น third-party MIT skills bundled by lnwjud
- pinned upstream commit
- six skills
- default Global OFF
- enabled default intensity FULL
- precedence Current Goal > Workspace > Global
- exact bundled load ไม่พึ่ง skill_match
- governance precedence
- review requirement FULL/ULTRA
- temporary normal mode ไม่เปลี่ยน persisted setting

---

# 18. Explicit non-goals v4.60.0

ไม่ทำ:

- vendor Ponytail MCP runtime เป็น primary mechanism
- vendor upstream hooks แล้วปล่อยให้รันโดยตรงใน lnwjud
- build-time/runtime fetch จาก GitHub main
- generic auto-skill policy framework สำหรับ skill ทุกโลก
- full chat prompt interception proxy
- auto-download/update Ponytail โดยไม่ผ่าน lnwjud release
- ให้ workspace skill ชื่อ `ponytail` override bundled native policy
- ให้ Ponytail ข้าม permission/security/durability/recovery/tests/release checks
- บังคับทั้ง 6 skills โหลดทุก coding request

---

# 19. Recommended implementation order

1. vendor six pinned skills + license/provenance
2. packaging contract + tests
3. shared `PonytailMode` + Global setting default OFF
4. Workspace project-profile override
5. Goal durable override + migration
6. policy resolver + precedence tests
7. exact skill-load activation ledger
8. ToolRegistry coding mutation gate
9. MCP proactive instruction builder
10. FULL/ULTRA review generation + goal completion gate
11. Settings Global/Workspace/Current Goal UI
12. transport parity
13. targeted tests
14. typecheck
15. lint
16. affected/full tests
17. packaging/release verification
18. build installer/portable
19. packaged host ON/OFF/matcher-failure/collision/review acceptance
20. ตรวจ diff แล้วค่อย commit/push ตาม release workflow

---

# 20. Definition of Done

- [ ] six Ponytail canonical skills ถูก vendored จาก pinned commit
- [ ] MIT attribution/provenance ครบ
- [ ] six skills ถูก ship ทุก target
- [ ] `skills_list` เห็นครบ
- [ ] exact bundled `skill_load` ทั้ง 6 ใช้ได้จริง
- [ ] Auto primary path **ไม่พึ่ง `skill_match`**
- [ ] `skill_match` failure regression ผ่าน
- [ ] Global `OFF/LITE/FULL/ULTRA` ใช้งานจริง, default OFF
- [ ] Workspace override ใช้งานจริง
- [ ] Current Goal durable override ใช้งานจริง
- [ ] precedence Goal > Workspace > Global ผ่าน tests
- [ ] effective mode/source แสดงใน Settings
- [ ] mode != off + first coding mutation + skill not loaded -> blocked จริง
- [ ] exact bundled load แล้ว retry mutation ผ่านจริง
- [ ] workspace/user fake Ponytail ไม่สามารถ satisfy native activation gate
- [ ] `tool_batch` bypass ไม่ได้
- [ ] Full Bypass bypass Ponytail correctness gate ไม่ได้
- [ ] explicit user normal mode suppress ได้เฉพาะ session โดยไม่แก้ persisted setting
- [ ] FULL/ULTRA code mutation ทำ review stale
- [ ] durable goal FULL/ULTRA complete ไม่ได้จน review ล่าสุดผ่าน
- [ ] Ponytail ไม่ลดทอน security, durability, recovery, compatibility, observability, required tests หรือ release verification
- [ ] Desktop HTTP/Tunnel/packaged STDIO/pure Node STDIO parity ผ่าน
- [ ] typecheck/lint/tests/packaging/release gates ผ่าน
- [ ] installer smoke test แสดง evidence ว่า skill ถูก load และ enforcement ทำงานจริง
- [ ] ยังไม่ merge/tag/publish public release ก่อน installer acceptance ตาม v4.60.0 release flow ปัจจุบัน

---

# 21. Final architecture

```text
                 ┌─────────────────────────┐
                 │   Global Ponytail Mode  │
                 │ OFF/LITE/FULL/ULTRA     │
                 └────────────┬────────────┘
                              │
                 ┌────────────▼────────────┐
                 │ Workspace project rule  │
                 │ inherit/off/lite/full/  │
                 │ ultra                   │
                 └────────────┬────────────┘
                              │
                 ┌────────────▼────────────┐
                 │ Current Goal override   │
                 │ inherit/off/lite/full/  │
                 │ ultra                   │
                 └────────────┬────────────┘
                              │
                 ┌────────────▼────────────┐
                 │ Resolved PonytailPolicy │
                 └────────────┬────────────┘
                              │
          ┌───────────────────▼───────────────────┐
          │ MCP instruction: proactive exact load│
          │ bundled:agent-skills/ponytail        │
          └───────────────────┬───────────────────┘
                              │
                 ┌────────────▼────────────┐
                 │ ToolRegistry mutation  │
                 │ activation gate        │
                 └────────────┬────────────┘
                              │ exact load verified
                 ┌────────────▼────────────┐
                 │ Coding implementation  │
                 └────────────┬────────────┘
                              │
                 ┌────────────▼────────────┐
                 │ FULL/ULTRA review gate │
                 │ ponytail-review        │
                 └────────────┬────────────┘
                              │
                 ┌────────────▼────────────┐
                 │ Existing lnwjud goal / │
                 │ test / release gates   │
                 └─────────────────────────┘
```

สิ่งสำคัญที่สุดของแผนนี้คือ **Ponytail เป็น skill จริงและต้องถูก load จริง** ส่วน `skill_match` กลับไปทำหน้าที่ที่มันควรทำ คือช่วยค้น ไม่ใช่เป็นเสาหลักที่ค้ำระบบทั้งหลังไว้แบบน่าหวาดเสียว

---

# 22. Additional v4.60.0 release-hardening — orphaned goal lease recovery

เพิ่มระหว่าง execution หลัง macOS baseline repair จากปัญหาที่พบจริงใน durable goal รอบนี้: lease generation ยังค้างทั้งที่ไม่มี worker/task ที่ทำงานอยู่ ทำให้ successor ต้องรอ TTL โดยไม่จำเป็น

Required behavior:

- `run_goal` ต้องเก็บ trustworthy worker-liveness evidence สำหรับ active unexpired lease ได้แม้ goal ไม่มี Scheduled Continuation
- ถ้าไม่มี live scheduled watchdog และ evidence ตรงกับ current `leaseGeneration` + `leaseActivitySeq`, `liveFencedCallCount = 0`, และ blocking tasks ทั้งหมด terminal/absent ให้ reclaim lease ได้ทันที
- ถ้ามี live scheduled watchdog ให้คง inactivity grace 60 วินาทีเดิม เพื่อไม่แย่ง rolling worker ระหว่าง tool calls
- ถ้ามี live fenced call, running/unknown blocking task, stale generation/activity evidence หรือ evidence ไม่น่าเชื่อถือ ห้าม reclaim
- lease token/generation เก่าต้องใช้ checkpoint ต่อไม่ได้หลัง recovery

Implementation touchpoints:

```text
packages/application/src/goal-continuation-service.ts
packages/storage/src/goal-repository.ts
packages/storage/src/goal-continuation.integration.test.ts
```

Acceptance:

- [x] orphan foreground lease without live watchdog reclaims immediately from trustworthy zero-worker evidence
- [x] recovery path does not require `scheduledContinuations` service injection
- [x] live fenced worker call prevents reclaim
- [x] existing rolling-watchdog 60-second grace regression still passes
- [x] durable goal integration suite passes 14/14 locally
- [ ] full repo typecheck/lint/test/release gates remain green after Ponytail integration
- [ ] cross-platform CI confirms no regression
