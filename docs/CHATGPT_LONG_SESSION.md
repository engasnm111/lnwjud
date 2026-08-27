# ChatGPT Chat + lnwjud: Outcome-Driven Continuity

> สถานะ: ใช้กับ lnwjud v4.11.0+ ผ่าน ChatGPT Chat + Plugins / MCP
> เป้าหมาย: ให้ ChatGPT ใช้ lnwjud ทำงานต่อเนื่องจนผลลัพธ์ที่ผู้ใช้สั่งเสร็จ และให้ Scheduled Task ปลุก turn ใหม่มารับงานเดิมต่อได้อย่างปลอดภัยเมื่อ turn ก่อนถูก platform ขัดจังหวะ
> นโยบาย: กลุ่ม `codex_*` ปิดเป็นค่าเริ่มต้นและไม่ advertise เว้นแต่ผู้ใช้เปิดเอง

## 1. กติกาหลัก: จบตามผลลัพธ์ ไม่ใช่เวลา

lnwjud ไม่มี elapsed-time cutoff และไม่เติมข้อความให้ ChatGPT หยุด, handoff หรือรอคำว่า “ทำต่อ” ตามเวลาที่ผ่านไป

เมื่อเชื่อม MCP สำเร็จ server จะประกาศกติกาให้ client ว่า:

- ใช้ tools ต่อจน requested outcome เสร็จ
- ห้ามหยุดหรือขอให้ผู้ใช้พิมพ์ `continue` เพียงเพราะเวลาผ่านไป
- หยุดเมื่อเสร็จจริง, ต้องการคำตัดสิน/สิทธิ์ใหม่จากผู้ใช้ หรือมี external blocker ที่ทำต่ออย่างปลอดภัยไม่ได้
- background task ใช้ตามธรรมชาติของ command ไม่ใช่ใช้เพื่อหนี timer

ไม่มีค่าคงที่ 22, 25 หรือ 60 นาทีสำหรับความต่อเนื่องของ run

## 2. งานโต้ตอบกับงาน background

ChatGPT ควรเรียก tools ปกติและทำ reasoning ต่อเมื่อขั้นตอนถัดไปยังต้องอาศัยผลลัพธ์ก่อนหน้า เช่น อ่านโค้ด แก้ไฟล์ รัน targeted test และแก้ failure

ใช้ durable background task เมื่อ command มีลักษณะเหมาะสม เช่น:

- full monorepo build/test ที่รันแยกได้
- installer/package
- dependency operation หรือ benchmark ที่ไม่ต้องตัดสินใจระหว่างทาง
- service/process ที่ตั้งใจให้ทำงานต่อเบื้องหลัง

เมื่อเริ่ม background task แล้ว ให้เก็บ `task_id`, ทำงานส่วนอื่นที่ไม่ชนกัน และกลับมาเช็ก `status` / `logs` / `result` จน terminal ภายใน run เดิมตราบใดที่ยังทำต่อได้ ห้ามเริ่ม command เดิมซ้ำเพียงเพราะ ChatGPT turn ใหม่ไม่เห็น process เดิมใน context

## 3. Persistent tunnel กับ durable execution

สองส่วนนี้แก้คนละเรื่อง:

- Persistent tunnel รักษา Tunnel ID เดิมและ reconnect local runtime โดยไม่ให้ผู้ใช้สร้าง connector ใหม่
- Durable execution ทำให้ command ที่เครื่องไม่ตายเมื่อ transport หลุดชั่วคราว

ทั้งสองส่วนสนับสนุน outcome-driven run แต่ไม่ควรเพิ่มคำสั่งหยุดตามเวลาเข้าไปใน tool result

## 4. Tracker ใช้เก็บสถานะ ไม่ใช่นาฬิกานับถอยหลัง

ถ้า repository มี `docs/PHASE_PROGRESS.md` ให้ใช้เป็น source of truth สำหรับงานหลาย phase:

1. อ่าน pending item ที่เกี่ยวข้องก่อน ไม่สำรวจใหม่ทั้ง repoโดยไม่จำเป็น
2. อัปเดตหลัง milestone สำคัญหรือเมื่อสถานะจริงเปลี่ยน
3. บันทึก durable `task_id` พร้อม acceptance ที่ต้องตรวจ
4. ทำ phase ถัดไปต่อทันทีเมื่อยังมีงานที่ปลอดภัยและอยู่ใน scope
5. ใช้ `session_handoff` เฉพาะเมื่อผู้ใช้ขอส่งต่องาน หรือเกิด client/platform interruption ที่หลีกเลี่ยงไม่ได้

## 5. Context economy ระหว่างงานยาว

- ไม่แน่ใจตำแหน่งโค้ด → `search_text` ก่อน
- ไฟล์ใหญ่ → `read_file_page` / `read_file_page_continue`
- ตรวจซ้ำหลัง diff เล็ก → `verify_incremental`
- project command ปกติ → `project_*`
- command ที่รันแยกได้ → durable `shell` background
- `process_status` เป็น snapshot; อย่า tight-poll

การประหยัด context มีไว้เพิ่มพื้นที่ reasoning ไม่ใช่เป็นเหตุให้หยุดงานก่อนเสร็จ

## 6. Durable Goal Continuation

Durable Goal Continuation เป็น state/coordination layer สำหรับ **ChatGPT Web turn ใหม่** ที่กลับมาทำ objective เดิมต่อ ไม่ใช่ AI worker และไม่รัน model ภายใน lnwjud

Public tools:

- `run_goal` — immediate-return create/resume + ขอ lease โดยใช้ `goalKey` คงที่
- `get_goal` — อ่าน snapshot โดยไม่ mutate และไม่คืน lease token
- `checkpoint_goal` — compare-and-swap checkpoint ด้วย `expectedRevision` + `leaseToken`
- `finish_goal` — ปิดเป็น `completed`, `failed` หรือ `blocked`
- `list_goals` — ค้น goal แบบ bounded เมื่อแชทจำ `goalId` ไม่ได้

`run_goal` **ไม่ได้สร้าง ChatGPT turn ใหม่เอง** และไม่มี foreground wait ภายใน tool. Scheduled Task ของ ChatGPT เป็นตัวปลุก turn ใหม่ ส่วน goal tools ทำให้ turn ใหม่นั้นตัดสินใจได้ว่าต้อง resume อะไรและป้องกัน writer ซ้ำ

Flow ที่ควรใช้:

1. Scheduled turn เรียก `run_goal` ด้วย `workspaceId` และ `goalKey` เดิมทุกครั้ง
2. ถ้า `acquired: false` แปลว่ามี turn อื่นถือ lease อยู่ ให้รายงานสถานะแล้ว **ห้ามเริ่ม mutation/process ซ้ำ**
3. ถ้า `acquired: true` ให้ใช้ `currentPhase`, `pendingSteps`, `nextAction`, `activeTaskIds` และ `lastCheckpoint` เป็น continuation state
4. ถ้า `activeTaskIds` มี task เดิม ให้ตรวจ task เดิมก่อนเริ่ม command ใหม่
5. หลังผลลัพธ์สำคัญเรียก `checkpoint_goal` พร้อม `expectedRevision` ล่าสุด
6. checkpoint ให้เก็บเฉพาะ bounded/redacted summary, path/hash/task ID/evidence ที่จำเป็น ห้ามเก็บ credential, source contents หรือ log ยาว
7. ถ้า turn ตายก่อน release lease รอบถัดไป takeover ได้เมื่อ lease หมดอายุ
8. เมื่อ acceptance ครบจริงจึง `finish_goal`
9. Scheduled Task เห็น terminal state แล้วต้องหยุดตัวเอง ไม่เรียก tools ต่อ

Goal state เป็น SQLite durable state และใช้ monotonic revision/CAS + append-only checkpoint history. Raw lease token ไม่ถูกเก็บใน authoritative state; repository เก็บ hash สำหรับตรวจสิทธิ์เท่านั้น และ activity logs ต้องไม่แสดง lease token

`session_checkpoint` เดิมยังเป็น summary checkpoint สำหรับ development session และ file checkpoint/Recovery Center ยังใช้กู้คืนไฟล์ ทั้งสองอย่าง backward compatible และ **ไม่ใช่ authoritative goal state**

### Owner scope และ session rotation

Goal ownership ไม่ผูกกับ transient MCP `sessionId` เพียงอย่างเดียว. Session ใหม่ของ logical client เดิมสามารถ resume goal เดิมได้ แต่ workspace อื่นหรือ stable client identity อื่นถูกปฏิเสธ

ข้อจำกัด trust boundary ปัจจุบัน: Desktop HTTP/tunnel อาจเห็น host-level logical client identity แทน authenticated per-human principal ถ้าหลายคนแชร์ endpoint เดียวกัน ดังนั้นอย่าอ้างว่า Durable Goal Continuation เป็น cryptographic tenant isolation ระหว่างมนุษย์หลายคนที่แชร์ tunnel เดียวกัน

## 7. Scheduled Task ตัวอย่าง

Scheduled Task ควรใช้ `goalKey` ที่คงที่และสั้น เช่น `release-v4.11.0-durable-goal` ไม่สร้าง key ใหม่ทุกชั่วโมง

ตัวอย่าง prompt สำหรับ Scheduled Task:

```text
ทำงาน objective เดิมต่อในแชทนี้โดยใช้ lnwjud เท่านั้น

1. เรียก run_goal ด้วย workspaceId เดิมและ goalKey="release-v4.11.0-durable-goal"
2. ถ้า acquired=false ให้รายงานว่ายังมี lease อยู่และจบรอบ ห้ามเริ่มงานซ้ำ
3. ถ้า acquired=true ให้ทำต่อจาก pendingSteps/nextAction/lastCheckpoint
4. ถ้ามี activeTaskIds ให้ตรวจ status/log/result ของ task เดิมก่อนเริ่ม command ใหม่
5. หลัง milestone หรือผลลัพธ์สำคัญทุกครั้งให้ checkpoint_goal ด้วย expectedRevision ล่าสุด
6. งานยาวให้เริ่ม background แล้ว checkpoint task_id ทันที
7. ห้ามใช้ Codex, AI CLI, OpenAI API worker หรือ browser automation เป็นสมองเพิ่มเติม
8. เมื่อ acceptance ครบจริงให้ finish_goal(status="completed")
9. ถ้า get_goal/run_goal เห็น terminal state ให้หยุด Scheduled Task นี้และไม่เรียก tools ต่อ
```

ครั้งแรกที่สร้าง goal ต้องส่ง `objective` และอาจส่ง structured `plan`; รอบหลังใช้ `goalKey` เดิมและไม่จำเป็นต้องส่ง objective ซ้ำ

## 8. การกู้คืนเมื่อ client/platform ขัดจังหวะจริง

ถ้า run ถูก client หรือ platform ขัดจังหวะจากภายนอก:

1. ใช้แชทเดิมก่อน
2. ถ้างานถูกจัดเป็น Durable Goal ให้ `run_goal` ด้วย `goalKey` เดิมก่อน mutation ใด ๆ
3. ตรวจ `activeTaskIds` และ durable task เดิมด้วย `task_id`
4. ตรวจ git status/diff เท่าที่จำเป็น
5. ทำต่อจาก pending acceptance แรก
6. Refresh connector เฉพาะเมื่อ tool schema เปลี่ยนหรือ cache ค้างจริง

`session_handoff` เป็น recovery tool ไม่ใช่ scheduled stop และไม่ควรถูกเรียกเพียงเพราะ elapsed time

## 9. Codex delegation

`codex_status`, `codex_run`, `codex_task_*`, `codex_stop` ไม่ register/advertise โดย default เพื่อไม่ใช้ Codex quota โดยไม่ได้ตั้งใจ

ChatGPT Chat สามารถอ่าน เขียน รันคำสั่ง และตรวจผลผ่าน lnwjud tools โดยตรง การเปิด `codex_*` ทำเฉพาะเมื่อผู้ใช้ตั้งใจมอบงานให้ Codex CLI แยกต่างหาก Durable Goal Continuation ไม่ต้องใช้ Codex หรือ AI CLI ใด ๆ

## 10. Prompt แนะนำสำหรับงานแบบสั่งครั้งเดียว

```text
ทำงานนี้ต่อเนื่องจน acceptance ครบทั้งหมด
อย่าหยุดหรือรอคำว่า “ทำต่อ” เพียงเพราะเวลาผ่านไป
ถ้ามี command ที่เหมาะกับ background ให้เก็บ task_id แล้วทำงานอื่นต่อ
กลับมาตรวจ task จน terminal และแก้ failure ต่อใน run เดิม
ถ้าต้อง resume ข้าม ChatGPT turn ให้ใช้ Durable Goal Continuation และ goalKey เดิม
หยุดเฉพาะเมื่อเสร็จจริง หรือต้องการข้อมูล/สิทธิ์ใหม่จากฉันอย่างหลีกเลี่ยงไม่ได้
```

## 11. Checklist

- [ ] MCP/Tunnel ออนไลน์และ workspace ถูกต้อง
- [ ] ไม่มี budget-warning/handoff instruction แบบกำหนดนาทีใน tool result
- [ ] MCP initialize มี outcome-driven instructions
- [ ] goalKey คงที่เมื่อใช้ Scheduled Task
- [ ] ถ้า lease ถูกถืออยู่ ไม่มี mutation/process ซ้ำ
- [ ] tracker ตรงกับสถานะจริง (ถ้ามี)
- [ ] background task ทุกตัวมี `task_id` และ goal checkpoint เก็บ `activeTaskIds`
- [ ] ไม่มี writer สองตัวชน workspace เดียวกัน
- [ ] terminal goal ถูก `finish_goal` แล้วและ Scheduled Task หยุด
- [ ] Codex delegation ปิด เว้นแต่ผู้ใช้ตั้งใจเปิด

## 12. Troubleshooting

| อาการ | ตรวจ/แก้ |
| --- | --- |
| ChatGPT หยุดแถว 22–25 นาที | ตรวจว่าใช้ build v4.11.0 ที่มี outcome-driven fix และ tool result ไม่มีข้อความ `ใกล้หมด budget` |
| Scheduled turn เริ่มงานเดิมซ้ำ | ต้องเรียก `run_goal` ก่อน mutation และตรวจ `acquired` + `activeTaskIds` |
| `checkpoint_goal` ได้ revision conflict | อ่าน `get_goal` ใหม่ ห้ามเขียนทับ snapshot เก่า แล้วตัดสินใจจาก revision ล่าสุด |
| Turn ตายทั้งที่ถือ lease | รอ lease expiry; Scheduled turn ถัดไปใช้ `run_goal` takeover โดย goalKey เดิม |
| Tunnel หลุด | ตรวจ persistent runtime doctor/reconnect ของ Tunnel ID เดิม |
| Background task ยังรัน | ใช้ `status` / `logs` / `result`; ห้ามเริ่ม task เดิมซ้ำ |
| Tool schema เก่า | Restart runtime ถ้าจำเป็น แล้ว Refresh connector; chat ใหม่เป็นทางเลือกสุดท้าย |
| Typecheck ซ้ำทั้งที่ diff ไม่เปลี่ยน | ใช้ `verify_incremental` และตรวจ `cache: hit` |
| Run ถูกขัดจังหวะจาก platform จริง | ใช้แชทเดิม + `run_goal`/goalKey + task ID; `session_handoff` เป็น recovery fallback |
