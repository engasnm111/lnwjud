# คู่มือใช้งาน lnwjud v4.31.0 (ภาษาไทย)

lnwjud คือ Windows-first local AI-agent runtime / MCP gateway สำหรับให้ ChatGPT, Codex และ MCP client อื่นทำงานกับเครื่อง Windows ของคุณ เช่น อ่าน/ค้น/แก้ไฟล์, Git, รันโปรเซส, Windows UI automation, WSL, Office และเครื่องมือพัฒนาอื่น ๆ โดยงานจริงยังทำบนเครื่องของคุณ

> สำหรับผู้ใช้ Windows x64 ที่ใช้ `lnwjud-Setup-4.31.0.exe` หรือ `lnwjud-Portable-4.31.0.exe` **ไม่ต้องติดตั้ง Node.js และไม่ต้องดาวน์โหลด `tunnel-client.exe` เอง** ตัว release รวม private Node.js runtime และ official OpenAI `tunnel-client v0.0.12` มาให้แล้ว

---

## 1. สิ่งที่ต้องมี

สำหรับผู้ใช้ทั่วไปที่ใช้ Windows release:

- Windows 10/11 x64

สำหรับ v4.11.0 ตัวโปรแกรมแยก compatibility profile ตามระบบ: Windows 10 x64 ใช้ software rendering เป็นค่าเริ่มต้นเพื่อลดปัญหาหน้าจอ Electron/Chromium ค้าง, วาดไม่ครบ หรือบาง control กดไม่ได้บน GPU/driver รุ่นเก่า ส่วน Windows 11 x64 ยังใช้ hardware acceleration ตามปกติ

งานภายในโปรแกรมที่ต้องเรียก PowerShell ใช้ `powershell.exe` ที่มากับ Windows ไม่บังคับให้ติดตั้ง PowerShell 7 และ child process ภายในถูกเปิดแบบซ่อนหน้าต่าง console. ระบบยังจำกัด durable background task พร้อมกันไว้ 16 งาน และ managed process พร้อมกันไว้ 24 งาน เพื่อกันกรณีหลายแชทสั่งงานพร้อมกันจนเกิด `conhost.exe` จำนวนมาก/CPU เต็ม
- `lnwjud-Setup-4.31.0.exe` หรือ `lnwjud-Portable-4.31.0.exe`
- OpenAI Platform tunnel ที่ผูกกับ ChatGPT workspace ที่จะใช้
- Runtime API key ที่มีสิทธิ์ **Tunnels Read + Use**
- อินเทอร์เน็ตขาออก HTTPS สำหรับ Secure MCP Tunnel

ไม่ต้องมี:

- Node.js แยกบนเครื่อง
- pnpm / Corepack สำหรับการใช้งานปกติ
- การโหลด ZIP `tunnel-client` เอง
- การพิมพ์ `tunnel-client init` ใน PowerShell เอง

Release ปัจจุบันเป็น **x64 เท่านั้น** ไม่รองรับ Windows 32-bit และไม่ได้ทำ target สำหรับ Windows 7/8/8.1

Node.js, pnpm และ Git จำเป็นเฉพาะกรณีพัฒนา/build จาก source ตามหัวข้อท้ายเอกสาร

## 2. เลือกแบบติดตั้งหรือ Portable

### แบบแนะนำ: Installer

1. ดาวน์โหลด `lnwjud-Setup-4.31.0.exe` จาก GitHub Releases
2. ติดตั้งตามปกติ
3. เปิด **lnwjud Agent Control Center**
4. เพิ่ม Project/Workspace ที่ต้องการใช้งาน
5. ถ้าทำงานพร้อมกันหลายแชท/หลายโปรเจกต์ ให้ตั้ง Active Projects ได้มากกว่า 1 โปรเจกต์ และเลือก Primary Project สำหรับงานที่ต้องมีค่า default

### แบบไม่ต้องติดตั้ง: Portable EXE

1. ดาวน์โหลด `lnwjud-Portable-4.31.0.exe`
2. วางไว้ในโฟลเดอร์ที่ต้องการแล้วเปิดไฟล์ได้ทันที ไม่ต้องรัน installer
3. เพิ่ม Project/Workspace และตั้ง Tunnel เหมือนเวอร์ชันติดตั้ง

Portable ของ lnwjud หมายถึง **ตัวโปรแกรมเปิดได้โดยไม่ต้องติดตั้ง** แต่ตั้งใจใช้ข้อมูล/Settings ต่อผู้ใช้ Windows ชุดเดียวกับตัวติดตั้ง จึงไม่ใช่โหมดที่เก็บ database/settings ทุกอย่างไว้ข้างไฟล์ EXE ถ้าเคยใช้ตัวติดตั้งใน Windows account เดียวกัน Portable จะเห็นการตั้งค่าชุดเดียวกัน

ทั้ง Installer และ Portable รวม `tunnel-client.exe` และ private Node runtime ไว้ใน package โดย lnwjud จะเลือก path ภายใน package เองเมื่อช่อง Tunnel Client Override ว่าง

### เปิดครั้งแรกและยังไม่มี Project

หน้า Doctor จะแจ้งเตือนว่า “ยังไม่มี Project” แต่ไม่ล็อกหน้าแอป: เปิด **Projects** หรือกด **Add Project** จาก Doctor แล้วเพิ่ม path ได้ทันที. ถ้าเพิ่มไม่สำเร็จ ข้อความ path จะยังอยู่เพื่อแก้และลองใหม่. ถ้า Dashboard/Workspace bootstrap บางส่วนล้ม โปรแกรมจะแสดง error พร้อม **Retry** แทนการค้างที่ Loading. Doctor ตรวจ identity ของ MCP ที่ port ตั้งค่าไว้ จึงแยกได้ว่า listener นั้นเป็น lnwjud หรือโปรแกรมอื่น.

### Auto Update แยกตามชนิดที่ใช้อยู่

- ถ้ากำลังใช้ **Installer** โปรแกรมจะอ่าน `latest.yml` และดาวน์โหลด/ติดตั้ง `lnwjud-Setup-<version>.exe` รุ่นใหม่
- ถ้ากำลังใช้ **Portable** โปรแกรมจะอ่าน `portable.yml` และดาวน์โหลด `lnwjud-Portable-<version>.exe` รุ่นใหม่เท่านั้น
- Portable updater จะรอให้โปรแกรมเดิมปิด, สำรอง EXE เดิม, วาง EXE ใหม่ทับ **path เดิมที่ผู้ใช้เปิดอยู่**, เปิดโปรแกรมใหม่ และ rollback กลับ EXE เดิมถ้าการ replace ล้มเหลว
- Auto Update จะ **ไม่เปลี่ยนชนิดให้เอง**: Portable จะไม่กลายเป็น Installer และ Installer จะไม่ถูกเปลี่ยนเป็น Portable
- ไฟล์ update ถูกตรวจตาม SHA-512/size ใน update manifest ก่อนเข้าสู่ขั้นตอน install/replace

ดังนั้นผู้ใช้เลือกแบบไหนตอนดาวน์โหลดครั้งแรก ก็จะได้รับ update ของแบบนั้นต่อไป ข้อมูล/Settings ต่อผู้ใช้ Windows ยังคงใช้ชุดเดิมตามปกติ

## 3. สร้าง OpenAI Tunnel และ Runtime API key

1. เปิด OpenAI Platform → Tunnels
2. สร้างหรือเลือก Tunnel ที่ต้องการใช้กับ lnwjud
3. ผูก Tunnel กับ organization / ChatGPT workspace ที่ต้องการ
4. จด `tunnel_id`
5. สร้าง Runtime API key ที่มีสิทธิ์ **Tunnels Read + Use**
6. เก็บ key ไว้เป็นความลับ ห้ามใส่ Git, issue, README หรือไฟล์ที่แชร์

สิทธิ์ **Tunnels Read + Manage** ต้องใช้เฉพาะบัญชีที่สร้าง/แก้ Tunnel บน Platform ไม่ใช่สิทธิ์ขั้นต่ำของ runtime key

## 4. ตั้งค่า Secure MCP Tunnel ใน lnwjud

เปิด **Settings → OpenAI Secure MCP Tunnel**

ทำตามนี้:

1. ใส่ Runtime API key แล้วกด **Save key**
2. ช่อง **tunnel-client (รวมมากับโปรแกรมแล้ว)** ให้ปล่อยว่างไว้
   - lnwjud จะใช้ official OpenAI `tunnel-client v0.0.12` ที่ bundle มากับ Windows x64 package อัตโนมัติ
   - ปุ่ม Browse / Save override ใช้เฉพาะกรณี troubleshoot หรือต้องการทดสอบ client อื่น
   - ถ้าเคยตั้ง override แล้วอยากกลับไปใช้ตัวที่มากับโปรแกรม ให้ล้างช่องแล้วกด **ใช้ตัวที่มากับโปรแกรม / Use bundled**
3. ใส่ **OpenAI Tunnel ID**
4. กด **Configure Tunnel**
5. lnwjud จะสร้าง/ซ่อม profile ของตัวเองและชี้ Tunnel ไปยัง Desktop loopback MCP เช่น `http://127.0.0.1:<port>/mcp`
6. ถ้ายังไม่เชื่อม ให้กด **Reconnect Tunnel เดิม** ใน Settings หรือ **Start Tunnel** จากหน้า Home

ถ้าแก้ **Runtime API key**, **Tunnel ID** หรือ tunnel-client override ขณะที่ Persistent Tunnel Runtime เดิมยังทำงานอยู่ lnwjud จะ **ไม่ตัด runtime ทันทีตอนกำลังแก้ค่า**. เมื่อผู้ใช้กด **Start Tunnel** แบบ manual โปรแกรมจะตรวจ runtime เดิม, หยุด alias `lnwjud` แบบ controlled และยืนยันว่าหยุดแล้วก่อน reconnect ด้วยค่าที่บันทึกใหม่. Auto reconnect จะไม่เปลี่ยนไปใช้ Tunnel ID อื่นเอง. ถ้าหยุด runtime เดิมไม่ได้ UI จะแสดงข้อความให้หยุด Persistent Tunnel Runtime เดิมแล้วลอง Start ใหม่ แทนการปล่อย error `Runtime alias is attached to a different tunnel ID` แบบไม่มีทางแก้.

ไม่ต้องรันคำสั่ง `init`, `doctor` หรือ `run` เองในการใช้งานปกติ

Runtime key ถูกเก็บด้วย Windows DPAPI และ profile จะอ้าง key ผ่าน `env:CONTROL_PLANE_API_KEY` แทนการเขียน key จริงลง YAML

## 5. เชื่อม lnwjud เข้ากับ ChatGPT

1. เปิด Developer mode ของ ChatGPT ถ้า plan/workspace รองรับ
2. เปิดหน้า Plugins/Connections
3. เพิ่ม connection ใหม่
4. เลือก Connection แบบ **Tunnel**
5. เลือก Tunnel ที่สร้างไว้ หรือใส่ `tunnel_id`
6. สร้าง connection แล้วตรวจว่าเห็น tools ของ lnwjud

ถ้าเพิ่งอัปเดต lnwjud หรือ tool schema เปลี่ยน:

1. กด **Refresh connector** ใน ChatGPT ก่อน
2. ถ้ายังเห็น schema/tool เก่า ค่อยเปิดแชทใหม่

การ refresh connector สำคัญเมื่ออัปเดต build เพราะ ChatGPT อาจ cache tool schema จาก connection เดิมไว้

## 6. ทดสอบหลังเชื่อมต่อ

เริ่มจาก read-only ก่อน เช่น:

```text
Use lnwjud to list registered workspaces, report Git status for the active project, and summarize the top-level project tree. Do not modify anything.
```

ถ้าผ่าน แปลว่าเส้นทางนี้ทำงานครบ:

```text
ChatGPT → OpenAI Secure MCP Tunnel → bundled tunnel-client → lnwjud Desktop HTTP MCP → local tools
```

จากนั้นจึงลองงานเขียนไฟล์หรือ execute

## 7. Work Log / บันทึกการทำงาน

หน้า **บันทึกการทำงาน / Work Log** แสดง TASK / RESULT / ERROR พร้อม Workspace และ Session เพื่อแยกงานหลายแชท/หลายโปรเจกต์

ใน v4.11.0:

- tool call ใหม่ควรแสดง target/operation จริง แทนการเห็นแค่ `SUCCESS`
- `shell`, `git`, `process_start`, `project_*` และ process follow-up จะแสดง executable/arguments ที่รู้จริง
- file tools จะแสดง path หรือ source → destination
- capability tools จะแสดง action/operation และ target ที่ปลอดภัยต่อการ log
- secret/token/password/API key จะถูก redact จาก activity summary
- TASK ของ `project_*` จะอัปเดตเป็น resolved command จริงเมื่อ gateway resolve command แล้ว
- follow-up เช่น `process_status` จะจำ command ต้นทางของ process handle

ประวัติเก่าที่บันทึกมาตั้งแต่ build ก่อนมี target detail ไม่สามารถย้อนสร้าง command ที่ไม่เคยถูกเก็บได้ จึงจะแสดง `details unavailable (legacy log)` แทนการทำให้เข้าใจผิดว่า `SUCCESS` คือรายละเอียดคำสั่ง

## 8. Durable Goal Continuation / ทำงานต่อจากจุดเดิม

v4.11.0 เพิ่มเครื่องมือ `run_goal`, `get_goal`, `checkpoint_goal`, `finish_goal` และ `list_goals` สำหรับงานที่ต้องทำต่อหลายรอบ/หลาย session โดยไม่พึ่งข้อความแชทอย่างเดียว

- Goal ถูกเก็บใน SQLite ด้วย `workspaceId + goalKey` ที่คงที่
- checkpoint เป็นประวัติ append-only และแต่ละการแก้ state ใช้ revision compare-and-swap เพื่อกันสอง turn เขียนทับกัน
- lease มีเวลาหมดอายุและ takeover ได้หลัง expiry; raw lease token ไม่ถูกเก็บลงฐานข้อมูล มีเฉพาะ SHA-256 hash
- owner ผูกกับ stable MCP `clientId` จึง resume ต่อได้แม้ session/tunnel reconnect เปลี่ยนไป แต่ client อื่นไม่สามารถแย่ง goal ได้
- `trackedTasks` เป็นรูปแบบใหม่ที่เก็บความสัมพันธ์ระหว่าง goal กับงานพื้นหลัง โดยแต่ละรายการมี `taskId`, `provider` (`process`/`codex`/`shell`), `role` (`blocking_job` หรือ `supporting_service`) และ `cancelWithGoal`. เฉพาะ `blocking_job` เท่านั้นที่ใช้ตัดสิน liveness; service กลาง เช่น MariaDB ไม่ block continuation และไม่ถูกยกเลิกเว้นแต่ระบุว่า goal เป็นเจ้าของ lifecycle. `activeTaskIds` ยังรับได้เพื่อ backward compatibility และจะถูก decode เป็น legacy blocking job แบบ conservative
- `cancel_goal` เก็บ binding เดิมไว้ใน checkpoint และคืน `taskCancellations` ครบทุก task: รายการที่ `cancelWithGoal=false` จะเป็น `status=skipped` และยังทำงานต่อโดยเจตนา ส่วน provider ที่ระบุแต่ไม่มี backend หรือยืนยันการหยุดไม่ได้จะเป็น `status=failed`; ดังนั้น `allTasksStopped` จะเป็น `false` จนกว่าจะตรวจงานค้างเหล่านั้น
- `finish_goal` ปิด goal เป็น `completed`, `failed` หรือ `blocked`; goal ที่จบแล้วจะไม่ถูกเปิดกลับเอง
- ข้อมูล summary/evidence ที่เข้าข่าย token/password/API key ถูก redact ก่อน persist/log

สำหรับงานยาว ให้ checkpoint หลังจบ phase สำคัญหรือหลังเริ่ม durable background task แล้วใส่ `nextAction` ให้ชัดว่า turn ถัดไปต้องตรวจอะไรต่อ

### ทำ successor แบบ one-time โดยไม่ให้งานชนกัน

ถ้างานยาวและผู้ใช้เปิดใช้ rolling Scheduled Continuation, `prepare_scheduled_continuation` จะ checkpoint และคืนคำขอสำหรับ native ChatGPT Scheduled Task แบบ **one-time/cloud โดยเลือกเวลาแบบ adaptive 2–25 นาที**. ถ้าไม่ระบุ delay ระบบจะใช้ **+2 นาที** แบบ fail-safe; 5/10/25 นาทีต้องเลือกโดยเจตนาเฉพาะตอนที่ worker ปัจจุบันจะทำงานต่อจริงเท่านั้น โดย 25 นาทีเป็นเพียงเพดาน watchdog สำหรับงานที่ยังเปิดกว้าง. ถ้า host turn กำลังจะคืน control หรือหลัง response นี้จะไม่มี worker ทำงานต่อ ต้องเตรียม successor ที่ +2 โดยตรง หรือเลื่อน **task เดิมที่ยืนยันแล้ว** เป็น `now+2` ก่อนคืน. Scheduled Task มีไว้กู้ chain หาก turn หาย ไม่ใช่เหตุให้ worker ปัจจุบันหยุดทำงานก่อนเวลา. หลังสร้างต้อง record native task ID พร้อม `runsOn: cloud` ทันที และห้ามคืน control ขณะ durable continuation ยังมีแค่สถานะ `prepared`.

เมื่อ Scheduled turn ใหม่ตื่นขึ้น ต้อง `claim_scheduled_continuation` ก่อน mutation; ระบบยอมรับ native wake jitter ที่มาก่อน due ไม่เกิน 120 วินาทีเพื่อไม่ให้ one-time wake สูญหาย. ถ้า metadata จาก ChatGPT host ยืนยันภายหลังว่า native one-time task ตัวเดิมรัน/ถูก consume ไปแล้ว แต่ durable continuation ยังเป็น pending/live เพราะ claim ไม่จบ ให้บันทึก `consumed` พร้อม exact native host run receipt; สถานะนี้แปลเพียงว่า task ไม่ได้รออยู่แล้ว ไม่ได้แปลว่า goal complete และถ้า goal ยัง active ให้สร้าง successor ใหม่หลัง reconcile. ทุก rolling-mode mutation ควรแนบ `goalLease` token/generation ของ run ปัจจุบัน; เมื่อ Full Bypass ปิด token รุ่นเก่าหรือ proof ที่หายจะถูกปฏิเสธแม้ ChatGPT reuse MCP session เดิม. Full Bypass เปิดอยู่จะข้ามการบังคับ `goalLease` ที่ registry แต่ไม่ได้โอน ownership ของ scheduled goal ดังนั้น workflow แบบ scheduled ยังต้อง claim/แนบ proof เพื่อกันงานชนกัน. ถ้าชน worker จริง, lease หมดอายุแต่มี `blocking_job` running หรือหลักฐาน liveness ยังไม่แน่นอน ให้ consume wake แล้วจอง **successor ใหม่** ที่ `now+2 นาที`; ห้าม re-arm task ที่กำลัง firing. ถ้า lease ค้างแต่ไม่มี worker จริง จะ takeover ได้หลัง trustworthy no-worker probe สองรอบห่างอย่างน้อย 120 วินาทีและ CAS evidence ไม่เปลี่ยน; unknown evidence ห้าม force-unlock.

ถ้ามี handoff-risk signal ที่ระบบกำหนดไว้หรือ host turn ต้องจบทั้งที่ goal ยัง active ให้ `expedite_scheduled_continuation` ดึง **task เดิม** มา `now+2`. ระหว่างมี `trackedTasks` ให้ใช้ bounded wait เฉพาะ `blocking_job` จนอ่าน terminal result จริง ห้ามรายงานว่าเสร็จจากข้อความ log ระหว่างทาง. เมื่อ acceptance ครบ ให้ `finish_goal` และอ่าน `get_goal` ยืนยัน terminal ก่อนตอบผู้ใช้เสมอ แม้ผู้ใช้จะสั่งหยุดตั้งเวลาแล้วก็ตาม—คำสั่งนั้นยกเลิกเฉพาะ successor ไม่ได้ยกเลิกหน้าที่ปิด goal. จากนั้นลบ exact native task ที่ระบบระบุ, record `cancelled` พร้อม native host deletion receipt จาก task ID เดิม และอ่านสถานะกลับให้เป็น `cancelled` ก่อนรายงานสำเร็จ ถ้ายังไม่มีผลลบจริง ห้ามอ้างว่ายกเลิกแล้ว. ใช้เฉพาะ native ChatGPT Scheduled Tasks; ห้าม Windows Task Scheduler, `schtasks.exe`, OS cron, shell timer, recurrence, browser automation หรือ undocumented OpenAI API.

## 9. Active Projects และหลายแชทพร้อมกัน

v4.11.0 รองรับ Active Projects หลายรายการพร้อมกัน

- แต่ละ MCP session มี session identity แยกกัน
- process/task handle ถูกแยกตาม owner/session
- file / Git / process / shell / database / Office / native-path tools ต้องทำงานได้กับ **ทุก workspace ที่อยู่ใน Active Projects set** ไม่ใช่เฉพาะ Primary Project
- ถ้า request มี absolute `path`, `cwd`, database `target` หรือ path field ที่ชี้ไปยัง Active Project ตัวอื่น runtime จะ route `workspaceId` ไปยังสมาชิกที่ครอบ path นั้นโดยอัตโนมัติ; เมื่อ Full Bypass ปิด path ที่ไม่อยู่ใน Active set ยังถูก guard ตามเดิม
- Primary Project เป็นเพียงค่า default เมื่อ client ไม่ได้ระบุ project/path ชัดเจน ไม่ใช่ขอบเขตสิทธิ์เพียงรายการเดียว
- Work Log และ Live Logs สามารถกรอง Workspace / Session ได้

อย่าเลือกทั้งไดรฟ์เป็น Active Project เพียงเพื่อความสะดวก ถ้างานจริงอยู่ใน project folder ที่เจาะจง

lnwjud จะไม่สแกนหรือลงทะเบียน drive letter `A:`–`Z:` อัตโนมัติแล้ว รวมถึง mapped/network drive เช่น `Z:` ที่ชี้ไป DGX Spark. ให้เพิ่มเฉพาะโฟลเดอร์โปรเจกต์ที่ต้องใช้ผ่านหน้า Projects หรือระบุ `--workspace` สำหรับ STDIO. รายการเก่าแบบ `Local Disk X:` ที่ระบบเคยสร้างเองจะถูก archive แบบกู้กลับได้ โดยไม่ลบโฟลเดอร์หรือ project registration จริง

## 10. Permission และการลบไฟล์

Profile หลัก:

- `safe` — อ่านได้ แต่ write/execute หลายอย่างต้องอนุมัติ
- `balanced` — ใช้งานพัฒนาปกติได้สะดวกขึ้น
- `full` — สำหรับเครื่อง/โปรเจกต์ที่เชื่อถือได้
- `custom` — host-defined policy

การเลือก `full` อย่างเดียวไม่เปิด Full Bypass. ในหน้า **Settings → โหมดเต็มสิทธิ์ (Unrestricted)** มี toggle แยก 2 ตัว:

- **Desktop Full Bypass** — ใช้กับ Desktop HTTP MCP และ Secure Tunnel
- **STDIO Full Bypass** — ใช้กับ direct local STDIO เท่านั้น

ทั้งคู่เริ่มต้นเป็น OFF และเปิดได้เฉพาะเมื่อ profile ของ transport นั้นเป็น Full. เมื่อ OFF งานทั่วไปของ Full Access ไม่ถาม แต่ tool ที่กำหนดว่าต้องยืนยันเสมอ, deletion/data loss, destructive command, protected path, Active Project/Strict Roots และ `goalLease` ยังใช้ policy/approval ปกติ.

เมื่อ ON lnwjud จะไม่ถามอีกและข้าม application-level confirmation, native host approval, profile/command policy, always-confirm tools, Active Project/allowed roots/protected path และ `goalLease`. Absolute path หรือ cwd นอกโปรเจกต์ส่งต่อได้โดยไม่ถาม แต่ relative traversal ยังเป็น input ผิด. Work Log/Audit จะแสดง `FULL BYPASS ON` / `authorizationMode: full_bypass` โดยไม่ปลอมว่าผู้เรียกส่ง `userConfirmed: true`.

Full Bypass ไม่ได้ทำให้ Windows ACL/UAC, antivirus, file lock, schema/input validation, file/process existence, process ownership, runtime ที่หาย, API credential, remote service หรือ child MCP policy หายไป. การแก้/ลบนอก workspace อาจถาวรเพราะไม่มี Recovery Trash/checkpoint.

เมื่อ Full Bypass ปิด `delete_file` เป็น deletion primitive ที่ออกแบบให้ทำงานร่วมกับ Recovery Trash เมื่อ target รองรับการกู้คืน ส่วนคำสั่ง arbitrary shell/script ถือเป็น opaque execution และไม่ควรสมมติว่าสามารถกู้ผ่าน Recovery Trash ได้ทุกกรณี

## 11. Recovery Center

เปิด **Settings → Recovery Center**

มีข้อมูลหลัก:

- Recovery Trash จากไฟล์ที่ลบผ่าน supported flow
- backup ก่อน binary replacement ที่รองรับ
- encrypted checkpoints

ตารางหน้า Recovery แสดงรายการล่าสุดในพื้นที่คงที่พร้อม scrollbar ส่วน retention ผู้ใช้เลือกเอง:

- `0` วัน = ไม่ลบอัตโนมัติ เก็บจนกว่าจะจัดการเอง
- มากกว่า `0` = ลบข้อมูล recovery ที่เก่ากว่าจำนวนวันที่ตั้งไว้

เมื่อเปลี่ยนจากไม่ลบอัตโนมัติไปเป็น retention ที่สั้นลง โปรแกรมจะเตือนก่อน เพราะข้อมูลเก่าอาจถูก cleanup ทันที

## 12. Live Logs

Live Logs ใช้ดูสถานะ realtime ของ:

- Tunnel/runtime lifecycle
- MCP activity
- managed processes/tasks

ถ้างาน fail ให้ดู Live Logs และหน้า Doctor ก่อน ไม่จำเป็นต้องเปิด PowerShell เพื่อรัน tunnel-client เอง

## 13. Doctor / Troubleshooting

อาการที่พบบ่อย:

| อาการ | ตรวจสอบ |
|---|---|
| ChatGPT ยังเห็น tool/schema เก่า | Refresh connector ก่อน ถ้ายังเก่าค่อยเปิดแชทใหม่ |
| Tunnel ไม่เชื่อม | ตรวจ Runtime API key, Tunnel ID, association และกด Reconnect Tunnel เดิม |
| tunnel-client override เสีย | ล้างช่อง override แล้วกด Use bundled |
| Work Log ของรายการเก่ามี `details unavailable (legacy log)` | เป็นข้อมูลเก่าที่ไม่เคยเก็บ target จริง ไม่ใช่ error ของ tool call ใหม่ |
| งาน execute ไม่ผ่าน | ตรวจ Active Projects และ Permission profile |
| process ยังทำงาน | ใช้ process/task status/logs แทนการ tight-poll หรือเปิดคำสั่งซ้ำ |
| มีหน้าต่าง CMD/PowerShell เด้งตอนโปรแกรมทำงาน | ไม่ควรเกิดใน internal launch ปกติ; เก็บเวลา/operation ที่ทำแล้วดู Live Logs เพื่อหา regression |
| เห็น `Console Window Host (conhost.exe)` ใน Task Manager | Windows อาจสร้าง conhost แบบซ่อนสำหรับ console-subsystem child เช่น PowerShell ได้ เป็นเรื่องปกติถ้าอายุสั้น/CPU ต่ำ; ถ้า CPU สูงต่อเนื่องให้เก็บ PID/เวลาแล้วตรวจ process parent |
| Office tool ใช้ไม่ได้ | ตรวจว่า Microsoft Office ติดตั้งและไฟล์ไม่ถูก lock |
| `screen_record` ใช้ไม่ได้ | ตรวจ ffmpeg บน PATH |

หน้า Doctor ของ v4.11.0 ตรวจ Persistent Tunnel identity/runtime, readiness, health, polling, local MCP binding และ tunnel-ID mismatch ได้ด้วย

## 14. Local STDIO สำหรับ Codex/IDE

Secure Tunnel สำหรับ ChatGPT web ใช้ **Desktop HTTP MCP** และ bundled tunnel-client

ส่วน Codex CLI หรือ MCP host ที่อยู่บนเครื่องเดียวกันใช้ packaged STDIO launcher ได้โดยตรง:

```text
lnwjud-mcp-stdio.cmd --workspace E:\projects\my-app
```

ครั้งแรกต้องระบุ `--workspace` (หรือเพิ่มโปรเจกต์ไว้ก่อน) ระบบจะไม่เดา drive เริ่มต้นจาก `C:`/home/current directory

ตัว release bundle private Node.js 24 มาให้ launcher นี้แล้ว จึงไม่ต้องลง Node.js system-wide

## 15. Build จาก source

เฉพาะนักพัฒนา:

- Windows 10/11 x64
- Node.js 24.x
- Git
- Corepack
- pnpm 10.15.0 ตาม repo

```powershell
git clone https://github.com/engasnm111/lnwjud.git
Set-Location .\lnwjud
corepack enable
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 build
corepack pnpm@10.15.0 package:windows
```

`package:windows` จะดาวน์โหลด official OpenAI tunnel-client v0.0.12 สำหรับ **ขั้นตอน build Windows artifacts** เท่านั้น ตรวจ SHA-256 ที่ pin ไว้ แล้ว bundle binary เข้า Installer/Portable อัตโนมัติ End user ที่ใช้ release ไม่ต้องทำขั้นตอนนี้

ไฟล์ที่ได้จะอยู่ที่:

```text
apps/desktop/dist/installers/lnwjud-Setup-4.31.0.exe
apps/desktop/dist/installers/lnwjud-Portable-4.31.0.exe
apps/desktop/dist/installers/latest.yml
apps/desktop/dist/installers/portable.yml
```

ดูรายละเอียด architecture/tool catalog เพิ่มเติมที่ `README.md`, `docs/mcp/MCP_TOOL_CATALOG.md` และ `docs/architecture/`
