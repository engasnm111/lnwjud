# คู่มือใช้งาน lnwjud v5.8.0 (ภาษาไทย)

lnwjud คือ cross-platform local AI-agent runtime / MCP gateway สำหรับให้ ChatGPT, Codex และ MCP client อื่นทำงานกับเครื่องของคุณ เช่น อ่าน/ค้น/แก้ไฟล์, Git, รันโปรเซส และเครื่องมือพัฒนาอื่น ๆ โดยงานจริงยังทำบนเครื่องของคุณ ความสามารถ Windows-only เช่น WSL, Registry และ Windows Sandbox จะไม่แสดงเป็นพร้อมใช้งานบน macOS/Linux

คู่มือนี้อัปเดตตาม source `v5.8.0`; public release `v5.7.4` คือรุ่นที่เผยแพร่แล้วบน [GitHub Releases](https://github.com/engasnm111/lnwjud/releases/tag/v5.7.4)

> สำหรับผู้ใช้ package ของ lnwjud **ไม่ต้องติดตั้ง Node.js และไม่ต้องดาวน์โหลด `tunnel-client` เอง** ตัว build จาก source `v5.8.0` รวม official OpenAI `tunnel-client v0.0.16` ที่ตรงกับ OS/architecture พร้อม SHA-256/provenance ส่วน release รุ่นก่อนหน้าอาจ bundle เวอร์ชันต่างกัน ให้ยึดหลักฐานของไฟล์ที่ดาวน์โหลดจริง

คู่มือ target ใหม่:

- [ติดตั้งบน macOS 13+](INSTALL_MACOS.md) (arm64/x64)
- [ติดตั้งบน Linux](INSTALL_LINUX.md) (Ubuntu 24.04 LTS x64; arm64 เป็น preview ที่ใช้ artifact ตรงสถาปัตยกรรม)

ทั้งสามระบบใช้ core MCP/Workspace ชุดเดียวกันและเลือก provider ตาม host ตอน
เริ่มโปรแกรม ส่วน WSL, Registry, Windows Sandbox, Windows PDF installer และ
Outlook/COM ยังคงเป็น Windows-only และจะรายงาน `unsupported_platform` บนระบบอื่น
อย่างชัดเจน

---

## 1. สิ่งที่ต้องมี

สำหรับผู้ใช้ทั่วไป ให้เลือก package ให้ตรงกับ host:

- Windows 10/11 x64
- macOS 13+ arm64/x64
- Linux x64 บน Ubuntu 24.04 LTS (Linux arm64 มี artifact แยก แต่ยังเป็น preview)

สำหรับ v4.11.0 ตัวโปรแกรมแยก compatibility profile ตามระบบ: Windows 10 x64 ใช้ software rendering เป็นค่าเริ่มต้นเพื่อลดปัญหาหน้าจอ Electron/Chromium ค้าง, วาดไม่ครบ หรือบาง control กดไม่ได้บน GPU/driver รุ่นเก่า ส่วน Windows 11 x64 ยังใช้ hardware acceleration ตามปกติ

งานภายในโปรแกรมที่ต้องเรียก PowerShell ใช้ `powershell.exe` ที่มากับ Windows ไม่บังคับให้ติดตั้ง PowerShell 7 และ child process ภายในถูกเปิดแบบซ่อนหน้าต่าง console. ใน v5.4.2 native input bridge รองรับ Windows PowerShell 5.1 โดยตรงทั้งการพิมพ์ข้อความหลายตัวอักษรและการปล่อย modifier ของ hotkey แบบย้อนลำดับพร้อม `finally` cleanup (Issue #114). ระบบยังจำกัด durable background task พร้อมกันไว้ 16 งาน และ managed process พร้อมกันไว้ 24 งาน เพื่อกันกรณีหลายแชทสั่งงานพร้อมกันจนเกิด `conhost.exe` จำนวนมาก/CPU เต็ม
- public release ล่าสุด `lnwjud-Setup-5.7.4.exe` หรือ `lnwjud-Portable-5.7.4.exe`
- OpenAI Platform tunnel ที่ผูกกับ ChatGPT workspace ที่จะใช้
- Credential ตามโหมดที่เลือก: **OAuth** เมื่อ provider รองรับ Tunnel provisioning หรือ **Runtime API key** ที่มีสิทธิ์ **Tunnels Read + Use** สำหรับโหมดเดิม/สำรอง
- อินเทอร์เน็ตขาออก HTTPS สำหรับ Secure MCP Tunnel

ไม่ต้องมี:

- Node.js แยกบนเครื่อง
- pnpm / Corepack สำหรับการใช้งานปกติ
- การโหลด ZIP `tunnel-client` เอง
- การพิมพ์ `tunnel-client init` ใน PowerShell เอง

Windows release ปัจจุบันเป็น **x64 เท่านั้น** ไม่รองรับ Windows 32-bit และไม่ได้ทำ target สำหรับ Windows 7/8/8.1. macOS มี package arm64/x64 และ Linux มี package x64 พร้อม Linux arm64 preview ที่ต้องเลือก artifact ให้ตรงสถาปัตยกรรม

Node.js, pnpm และ Git จำเป็นเฉพาะกรณีพัฒนา/build จาก source ตามหัวข้อท้ายเอกสาร

## 2. เลือกแบบติดตั้งหรือ Portable

### แบบแนะนำ: Installer

1. ดาวน์โหลด public release ล่าสุด `lnwjud-Setup-5.7.4.exe` จาก GitHub Releases
2. ติดตั้งตามปกติ
3. เปิด **lnwjud Agent Control Center**
4. เพิ่ม Project/Workspace ที่ต้องการใช้งาน
5. ถ้าทำงานพร้อมกันหลายแชท/หลายโปรเจกต์ ให้ตั้ง Active Projects ได้มากกว่า 1 โปรเจกต์ และเลือก Primary Project สำหรับงานที่ต้องมีค่า default

### แบบไม่ต้องติดตั้ง: Portable EXE

1. ดาวน์โหลด public release ล่าสุด `lnwjud-Portable-5.7.4.exe`
2. วางไว้ในโฟลเดอร์ที่ต้องการแล้วเปิดไฟล์ได้ทันที ไม่ต้องรัน installer
3. เพิ่ม Project/Workspace และตั้ง Tunnel เหมือนเวอร์ชันติดตั้ง

Portable ของ lnwjud หมายถึง **ตัวโปรแกรมเปิดได้โดยไม่ต้องติดตั้ง** แต่ตั้งใจใช้ข้อมูล/Settings ต่อผู้ใช้ Windows ชุดเดียวกับตัวติดตั้ง จึงไม่ใช่โหมดที่เก็บ database/settings ทุกอย่างไว้ข้างไฟล์ EXE ถ้าเคยใช้ตัวติดตั้งใน Windows account เดียวกัน Portable จะเห็นการตั้งค่าชุดเดียวกัน

ทั้ง Installer และ Portable รวม `tunnel-client` target-native ไว้ใน package โดย lnwjud จะเลือก path ภายใน package เองเมื่อช่อง Tunnel Client Override ว่าง

### เปิดครั้งแรกและยังไม่มี Project

หน้า Doctor จะแจ้งเตือนว่า “ยังไม่มี Project” แต่ไม่ล็อกหน้าแอป: เปิด **Projects** หรือกด **Add Project** จาก Doctor แล้วเพิ่ม path ได้ทันที. ถ้าเพิ่มไม่สำเร็จ ข้อความ path จะยังอยู่เพื่อแก้และลองใหม่. ถ้า Dashboard/Workspace bootstrap บางส่วนล้ม โปรแกรมจะแสดง error พร้อม **Retry** แทนการค้างที่ Loading. Doctor ตรวจ identity ของ MCP ที่ port ตั้งค่าไว้ จึงแยกได้ว่า listener นั้นเป็น lnwjud หรือโปรแกรมอื่น.

### Auto Update แยกตามชนิดที่ใช้อยู่

- ถ้ากำลังใช้ **Installer** โปรแกรมจะอ่าน `latest.yml` และดาวน์โหลด/ติดตั้ง `lnwjud-Setup-<version>.exe` รุ่นใหม่
- ถ้ากำลังใช้ **Portable** โปรแกรมจะอ่าน `portable.yml` และดาวน์โหลด `lnwjud-Portable-<version>.exe` รุ่นใหม่เท่านั้น
- macOS ใช้ `latest-mac.yml` ซึ่งรวม zip ของ Intel และ Apple silicon แล้วเลือกไฟล์ตามสถาปัตยกรรมของเครื่อง
- Linux AppImage ใช้ `latest-linux.yml` สำหรับ x64 และ `latest-linux-arm64.yml` สำหรับ arm64; DEB ยังคงให้ package manager จัดการ
- Portable updater จะรอให้โปรแกรมเดิมปิด, สำรอง EXE เดิม, วาง EXE ใหม่ทับ **path เดิมที่ผู้ใช้เปิดอยู่**, เปิดโปรแกรมใหม่ และ rollback กลับ EXE เดิมถ้าการ replace ล้มเหลว
- Auto Update จะ **ไม่เปลี่ยนชนิดให้เอง**: Portable จะไม่กลายเป็น Installer และ Installer จะไม่ถูกเปลี่ยนเป็น Portable
- ไฟล์ update ถูกตรวจตาม SHA-512/size ใน update manifest ก่อนเข้าสู่ขั้นตอน install/replace

ดังนั้นผู้ใช้เลือกแบบไหนตอนดาวน์โหลดครั้งแรก ก็จะได้รับ update ของแบบนั้นต่อไป ข้อมูล/Settings ต่อผู้ใช้ Windows ยังคงใช้ชุดเดิมตามปกติ

## 3A. Remote MCP ผ่าน ngrok + OAuth (ค่าเริ่มต้น/รองรับผู้ใช้เดิม)

ใน v4.52.0 วิธีที่ง่ายที่สุดสำหรับ ChatGPT เว็บคือ **Remote MCP — ngrok + OAuth** ซึ่งแยกจาก OpenAI Secure MCP Tunnel เดิมอย่างชัดเจน. งาน Remote MCP/OAuth ที่พัฒนาระหว่างเลขเวอร์ชันภายใน 4.50/4.51 (ซึ่งไม่เคยเผยแพร่เป็น Release) ถูกรวมส่งมอบใน v4.52.0 ชุดเดียว. Local MCP ของ lnwjud ยังคง bind เฉพาะ loopback เช่น `http://127.0.0.1:18765/mcp`; lnwjud จะสร้าง OAuth-protected loopback gateway อีกชั้น แล้วให้ ngrok เปิดเฉพาะ gateway นั้นออกเป็น HTTPS public URL ที่ลงท้าย `/mcp`.

ขั้นตอนใช้งานปกติ:

1. เปิด **Settings → Remote MCP & Tunnel**
2. ดูสถานะ ngrok ก่อน: ถ้าขึ้น **READY / ✓ ngrok พร้อมใช้งาน** แปลว่า lnwjud ตรวจ binary ด้วย `ngrok version` แล้ว ไม่ต้องติดตั้งซ้ำ. ถ้ายังเป็น **NOT READY** หน้า Settings จะแสดงวิธีติดตั้งที่รองรับตาม host เท่านั้น: Windows ใช้ช่องทาง Microsoft Store/WinGet, macOS สามารถใช้ Homebrew เมื่อ Homebrew พร้อม, ส่วน Linux หรือ host ที่ lnwjud ไม่มีวิธีติดตั้งอัตโนมัติที่พิสูจน์แล้วจะซ่อนปุ่ม auto-install และเปิดลิงก์ดาวน์โหลด ngrok ทางการแทน. lnwjud ไม่เอา binary ของ OS/architecture อื่นมาติดตั้งข้ามระบบและไม่แอบใช้ `sudo`/แก้ package repository ให้เอง
3. เปิดหน้า ngrok Authtoken จากปุ่มใน lnwjud แล้ววาง token ครั้งเดียว; lnwjud เก็บ token ผ่าน secure storage ของ host (Windows DPAPI / macOS Keychain / system keyring ที่รองรับบน Linux) และส่งให้ process ผ่าน `NGROK_AUTHTOKEN` เท่านั้น ไม่ใส่ใน command line หรือ config plaintext. ถ้า secure storage ของ host ใช้งานไม่ได้ ระบบจะ fail closed แทนการลดระดับไปเก็บ plaintext
4. กด **Start Remote MCP**
5. เมื่อสถานะเป็น RUNNING ให้กด **Copy MCP URL**. ถ้าสร้างแอปส่วนตัวใน ChatGPT ให้เปิด **Plugins → + → URL ของเซิร์ฟเวอร์** แล้ววาง URL `https://...ngrok.app/mcp` (รวม `/mcp`) เลือก **OAuth**. ใน **การตั้งค่า OAuth ขั้นสูง** ให้เลือก **Dynamic Client Registration (DCR)** แทน **User-Defined OAuth Client**; lnwjud มีระบบออก Client ID ให้อัตโนมัติ จึงไม่ต้องกรอก OAuth client ID/secret หรือ URL ต่าง ๆ ด้วยมือ. สำหรับ ChatGPT Business ให้ Admin/Owner สร้างแอปใน Workspace Settings → Apps แล้ว Publish ให้สมาชิก
6. เมื่อเชื่อมครั้งแรก ChatGPT จะพาเบราว์เซอร์ไปยังหน้ารับรองของ lnwjud บน `127.0.0.1`; ตรวจชื่อ ChatGPT และ callback แล้วกด **Approve connection** หนึ่งครั้ง จากนั้นระบบจะกลับไปยัง ChatGPT และใช้งานต่อได้. ต้องเปิด lnwjud บนเครื่องเดียวกับเบราว์เซอร์ที่รับรอง. หากหน้ารับรองไม่เปิด ให้ตรวจว่า Remote MCP ยัง RUNNING และลองเชื่อมใหม่. public ngrok endpoint ใช้ localhost ticket นี้แทนไม่ได้; OAuth client ที่ไม่ตรง callback ที่รองรับจะถูกปฏิเสธแบบ fail closed ด้วย `403 access_denied`

ตั้งแต่ v4.62.0 **ไม่ต้องซื้อหรือจดโดเมนเองเพื่อให้ Public MCP URL คงที่**: บัญชี ngrok มี development domain ที่ระบบกำหนดให้ และเมื่อ lnwjud เปิด Remote MCP สำเร็จครั้งแรก lnwjud จะจำ HTTPS origin นั้นไว้ใน encrypted Remote MCP state. ครั้งถัดไป/หลังอัปเดต lnwjud จะส่ง origin เดิมกลับให้ ngrok ผ่าน `--url` และจะหยุดพร้อมแจ้งเตือนแทนการเปลี่ยน URL ของ ChatGPT แบบเงียบ ๆ หาก ngrok ไม่สามารถใช้ URL เดิมได้. Custom domain ยังเป็นทางเลือกเสริม ไม่ใช่ข้อบังคับ. ถ้าตั้งใจเปลี่ยนบัญชี ngrok หรือโดเมน ให้บันทึก ngrok Authtoken ใหม่หนึ่งครั้งเพื่อ reset URL ที่จำไว้ แล้ว Start Remote MCP เพื่อเรียนรู้ URL ใหม่

Remote MCP gateway รองรับ OAuth discovery, Dynamic Client Registration, Authorization Code + PKCE S256, access token และ refresh token. คำขอ `/mcp` ที่ไม่มี bearer token ที่ถูกต้องจะถูกปฏิเสธ และ Authorization header จากอินเทอร์เน็ตจะไม่ถูกส่งต่อเข้า local MCP โดยตรง.

### 3A.1 LNWJUD Watcher — ดูสถานะแบบ read-only จาก Web/มือถือ

ตั้งแต่ **v5.6.0** Desktop จะเปิด Watcher API แบบอ่านอย่างเดียวให้อัตโนมัติ แยกจาก MCP command surface และใน **v5.6.1** snapshot เดียวรองรับทุก Active Project พร้อม active Durable Goal หลายงานต่อโปรเจกต์, active operations, Agent/activity และ Git แยก workspace โดย Watcher ไม่มีสิทธิ์สั่ง shell, แก้ไฟล์ หรือเรียก MCP mutation.

บนเครื่อง LNWJUD เปิด pairing URL:

```text
http://127.0.0.1:17891/api/v1/pair
```

นำ `endpoint` และ Watcher `token` ไปกรอกใน Watcher. ถ้าจะดูจากมือถือ/เครื่องอื่น ให้ expose เฉพาะ Watcher API port **17890** ผ่าน HTTPS provider เช่น zrok, Cloudflare, Tailscale หรือ ngrok; **ห้าม expose pairing port 17891**. รายละเอียดเต็มอยู่ที่ [WATCHER.md](WATCHER.md).

Realtime จะถือว่าเชื่อมต่อสำเร็จหลัง runtime ยืนยัน token ด้วย `ready` เท่านั้น และ Watcher จะ re-sync authoritative snapshot เมื่อมี live activity/reconnect; หาก WebSocket ใช้งานไม่ได้ client จะ fallback เป็น snapshot refresh ทุก 5 วินาทีขณะหน้าจอเปิดอยู่.

## 3B. Remote MCP ผ่าน Cloudflare

โหมด **Cloudflare** เป็นตัวเลือกเพิ่มใน v5.5.0 และไม่เปลี่ยนผู้ใช้เดิมจาก ngrok อัตโนมัติ. ใช้เมื่อคุณมี Cloudflare Tunnel/reverse proxy ของตัวเองอยู่แล้ว:

1. เลือก Transport = **Cloudflare** ใน Settings.
2. lnwjud จะเปิด OAuth-protected gateway บน loopback แบบ stable และแสดง **Local gateway target** ให้คัดลอก.
3. ตั้ง Cloudflare Tunnel/reverse proxy ของคุณให้ forward มาที่ gateway target ที่ lnwjud แสดง — ไม่ใช่ raw Local MCP URL.
4. ใส่ public HTTPS origin ของคุณ เช่น `https://mcp.example.com` แล้วบันทึก.
5. กด Start Remote MCP; lnwjud จะตรวจว่ public origin วิ่งกลับมาถึง gateway จริงก่อนรายงาน RUNNING.

lnwjud **ไม่ได้สร้าง Cloudflare Tunnel ให้เอง** ในโหมดนี้ และจะไม่ติดตั้ง/รัน ngrok. การจัดการ Cloudflare token/domain/tunnel เป็นของผู้ใช้หรือระบบภายนอก.

### 3C. Remote MCP ผ่าน Custom URL

โหมด **Custom URL** ใช้กับ reverse proxy HTTPS ที่คุณจัดการเอง เช่น proxy/gateway ขององค์กร. พฤติกรรมเหมือน Cloudflare ในส่วน security boundary: lnwjud เปิด stable protected loopback gateway, ไม่ต้องใช้ ngrok authtoken และจะ verify public HTTPS origin ก่อนขึ้น RUNNING. Proxy ต้องชี้มาที่ gateway target ที่ Settings แสดง ไม่ใช่ raw Local MCP listener.

### 3D. Local MCP โดยไม่ใช้ ngrok

โหมด **Local MCP** เปิดเฉพาะ listener บน loopback สำหรับ MCP client ในเครื่อง/เครือข่ายที่เข้าถึง loopback ผ่านกลไกของตัวเอง. โหมดนี้:

- ไม่ติดตั้งหรือรัน ngrok;
- ไม่มี public gateway/public MCP URL;
- ไม่ต้องมี ngrok token หรือ public OAuth;
- แสดง Local MCP URL ชัดเจน;
- ไม่แสดงปุ่ม Reconnect ChatGPT หรือขั้นตอนสร้าง ChatGPT Plugin ที่ไม่เกี่ยวข้อง.

Local MCP เป็นตัวเลือกเพิ่ม ไม่ได้แทน OpenAI Secure MCP Tunnel หรือ Remote MCP OAuth สำหรับ ChatGPT ระยะไกล.

### 3E. เลือกวิธียืนยันตัวตนของ OpenAI Secure MCP Tunnel

หน้า **Settings → Secure Tunnel Authentication** แสดงวิธีที่กำลังใช้อยู่เป็น `OAUTH` หรือ `API KEY` และทุกหน้าหลัก/Logs/Doctor จะอิงค่านี้เหมือนกัน. เมื่ออยู่โหมด OAuth หน้าหลักจะแสดง OAuth account/status และไม่พาเข้า wizard สำหรับวาง Runtime API key; ฟอร์ม Runtime API key ยังอยู่เฉพาะส่วน Advanced ในฐานะ legacy fallback/troubleshooting. Transport ยังคงเป็น **OpenAI Secure MCP Tunnel** ไม่ว่า auth mode จะเป็นแบบใด.

OAuth จะเปิดให้กด Sign in เฉพาะเมื่อ provider ที่ติดตั้งรองรับ Secure MCP Tunnel provisioning จริง; ถ้า capability ยัง unavailable โปรแกรมจะ fail closed และไม่เอา ChatGPT/Codex browser token มาใช้แทน runtime credential.

### โหมดเดิม / Legacy: สร้าง OpenAI Tunnel และ Runtime API key

1. เปิด OpenAI Platform → Tunnels
2. สร้างหรือเลือก Tunnel ที่ต้องการใช้กับ lnwjud
3. ผูก Tunnel กับ organization / ChatGPT workspace ที่ต้องการ
4. จด `tunnel_id`
5. สร้าง Runtime API key ที่มีสิทธิ์ **Tunnels Read + Use**
6. เก็บ key ไว้เป็นความลับ ห้ามใส่ Git, issue, README หรือไฟล์ที่แชร์

สิทธิ์ **Tunnels Read + Manage** ต้องใช้เฉพาะบัญชีที่สร้าง/แก้ Tunnel บน Platform ไม่ใช่สิทธิ์ขั้นต่ำของ runtime key

## 4. ตั้งค่า Secure MCP Tunnel ใน lnwjud

เปิด **Settings → Secure Tunnel Authentication**. ถ้าโหมดเป็น OAuth ให้ใช้การ์ด **การเชื่อมต่อด้วย OAuth** เป็นหน้าหลัก: ตรวจ account/session, Sign in เมื่อ capability พร้อม และ Start/Stop จากการ์ด OAuth หรือหน้า Home. ส่วน `Runtime API key` จะถูกระบุชัดว่าเป็น **Legacy fallback** เท่านั้น.

ถ้าใช้โหมด API KEY ให้ทำตามนี้:

1. ใส่ Runtime API key แล้วกด **Save key**
2. ช่อง **tunnel-client (รวมมากับโปรแกรมแล้ว)** ให้ปล่อยว่างไว้
   - lnwjud จะใช้ official OpenAI `tunnel-client v0.0.16` ที่ bundle ตาม OS/architecture target อัตโนมัติ และจะ fail closed ถ้า packaged runtime ไม่ตรง target หรือหลักฐานตรวจสอบไม่ผ่าน
   - ปุ่ม Browse / Save override ใช้เฉพาะกรณี troubleshoot หรือต้องการทดสอบ client อื่น
   - เมื่อบันทึก custom override แล้ว path นั้นเป็นตัวเลือกหลัก ถ้าไฟล์หาย lnwjud จะแจ้ง error และ **จะไม่ fallback ไป bundled เองแบบเงียบ ๆ**
   - ถ้าเคยตั้ง override แล้วอยากกลับไปใช้ตัวที่มากับโปรแกรม ให้ล้างช่องแล้วกด **ใช้ตัวที่มากับโปรแกรม / Use bundled** โดยชัดเจน
3. ใส่ **OpenAI Tunnel ID**
4. กด **Configure Tunnel**
5. lnwjud จะสร้าง/ซ่อม profile ของตัวเองและชี้ Tunnel ไปยัง Desktop loopback MCP เช่น `http://127.0.0.1:<port>/mcp`
6. ถ้ายังไม่เชื่อม ให้กด **Reconnect Tunnel เดิม** ใน Settings หรือ **Start Tunnel** จากหน้า Home

`Persistent Tunnel Identity` มีหน้าที่จำ Tunnel ID เดิม และ **ไม่ใช่คำสั่งให้ runtime ต้องเปิดตลอดเวลา**. lnwjud เก็บ desired Run/Stop state แยกจาก identity: เมื่อผู้ใช้กด **Stop Tunnel** จะบันทึกสถานะ `stopped`, ปิด reconnect supervisor/timer, หยุด runtime และตรวจยืนยันการหยุดผ่าน `tunnel-client.exe` ที่เป็น owner จริง. สถานะ Stop นี้คงอยู่แม้ปิด/เปิด lnwjud ใหม่ และ Automatic reconnect จะไม่เปิด tunnel กลับเองจนกว่าผู้ใช้จะกด **Start Tunnel** อีกครั้ง. ถ้าโปรแกรมปิดผิดปกติระหว่าง Stop แล้ว runtime เดิมยังรอดอยู่ การเปิดครั้งถัดไปจะ reconcile desired `stopped` และพยายามหยุด owner เดิมต่อแทนการเปิด client ใหม่ซ้อน.

เมื่อเปิดโปรแกรม หาก Tunnel เคยตั้งค่าและ Start ไว้แล้ว และ **Persistent Tunnel Runtime** ยังเปิดอยู่ lnwjud จะเริ่ม Tunnel ให้อัตโนมัติ; ผู้ใช้ใหม่ยังต้องตั้งค่าและกด Start ครั้งแรกเอง และหากผู้ใช้กด Stop โปรแกรมจะจำสถานะหยุดข้ามการเปิดโปรแกรมจนกว่าจะกด Start Tunnel อีกครั้ง.

ถ้าเปลี่ยน **Runtime API key**, **Tunnel ID** หรือ tunnel-client override ขณะที่ Persistent Tunnel Runtime เดิมทำงานอยู่ lnwjud จะรักษา ownership ให้ชัดเจน. สำหรับการเปลี่ยน tunnel-client โปรแกรมจะ validate path ใหม่ก่อน จากนั้นหยุดและยืนยัน runtime เดิมผ่าน executable owner ที่บันทึกไว้ **ก่อน** commit custom/bundled selection ใหม่; ถ้าหยุด owner เดิมไม่ได้ จะไม่ start client ตัวใหม่ซ้อน. สำหรับการเปลี่ยนเฉพาะ credentials การ Start แบบ manual จะ reconnect alias `lnwjud` เดิมและถือว่าสำเร็จเมื่อ Health/Ready/control-plane poll ผ่าน. แต่ถ้า Tunnel ID เปลี่ยนขณะที่ runtime เดิมยังรันอยู่ lnwjud จะไม่หยุด runtime เดิมอัตโนมัติเพื่อสลับทันที เพราะ official tunnel-client ยังไม่มี primitive ที่พิสูจน์ ready-before-retire overlap; ให้ผู้ใช้กด Stop Tunnel เดิมก่อนแล้วจึง Start Tunnel ID ใหม่. Auto reconnect จะไม่เปลี่ยนไปใช้ Tunnel ID อื่นเอง และการบันทึก key/path/profile จะไม่ override desired `stopped` ของผู้ใช้.

**หลายแชท / หลายเครื่อง:** lnwjud หนึ่ง instance + Secure Tunnel `lnwjud` หนึ่งตัวถูกออกแบบให้ใช้ร่วมกันได้หลาย ChatGPT chats/หลาย workspace พร้อมกัน จึง **ไม่ต้องและไม่ควรสร้าง profile/tunnel แยกต่อแชท**. Desktop HTTP MCP แยก concurrent MCP sessions อยู่แล้ว และตั้งแต่ v4.62.0 lnwjud จะกำหนด `MCP_MAX_CONCURRENT_REQUESTS=32` ให้ bundled tunnel-client โดยตรง พร้อม TTL 168 ชั่วโมง เพื่อให้มี headroom เมื่อหลายแชท fan-out tool calls พร้อมกัน. แต่ถ้ารัน lnwjud หลายเครื่อง เช่น Mac + Windows และต้องการให้แชทหนึ่งไป Mac อีกแชทหนึ่งไป Windows แบบแน่นอน ให้ใช้ **Tunnel ID + ChatGPT Tunnel connection แยกต่อเครื่อง**. tunnel-client รองรับ HTTP replicas ที่แชร์ Tunnel ID ได้ในเชิง transport แต่ queued work จะถูกส่งไปยัง replica ที่ poll ได้ก่อน จึงไม่ได้ผูกแชทกับเครื่องใดเครื่องหนึ่ง. Remote MCP ผ่าน ngrok + OAuth ยังเป็นวิธี Recommended และมี transport hop น้อยกว่า จึงอาจตอบสนองเร็ว/นิ่งกว่าภายใต้ burst สูงได้.

ไม่ต้องรันคำสั่ง `init`, `doctor` หรือ `run` เองในการใช้งานปกติ

Runtime key ถูกเก็บด้วย secure storage ของระบบและ profile จะอ้าง key ผ่าน `env:CONTROL_PLANE_API_KEY` แทนการเขียน key จริงลง YAML Windows legacy envelope จะ migrate ผ่าน native helper ครั้งเดียว

## 5. เชื่อม lnwjud เข้ากับ ChatGPT

1. เปิด Developer mode ของ ChatGPT ถ้า plan/workspace รองรับ
2. เปิดหน้า Plugins/Connections
3. เพิ่ม connection ใหม่
4. เลือก Connection แบบ **Tunnel**
5. เลือก Tunnel ที่สร้างไว้ หรือใส่ `tunnel_id`
6. หากใช้ Runtime API key สำหรับ Tunnel ใน lnwjud ให้เลือก **ไม่มีการยืนยันตัวตน** ในฟอร์ม ChatGPT แล้วสร้างแอป MCP; Runtime API key ใช้ยืนยันตัวตนระหว่าง tunnel-client กับ OpenAI อยู่แล้ว ไม่ใช่ OAuth client ID ของแอป MCP
7. ตรวจว่าเห็น tools ของ lnwjud หาก ChatGPT แจ้ง `Invalid MCP tool schema` ให้อัปเดต lnwjud เป็น v5.6.4 หรือใหม่กว่า

หน้า admin ของ tunnel-client ใช้ `http://127.0.0.1:<พอร์ตปัจจุบัน>/ui` ซึ่งพอร์ตเปลี่ยนได้ทุกครั้งที่ runtime เริ่มใหม่ ดู URL ของ runtime ที่กำลังรันจาก **Settings → Persistent Tunnel Runtime → Tunnel admin UI** หรือบรรทัด `WEB UI` ล่าสุดใน Tunnel Live Logs; อย่าใช้ `/ui` บนพอร์ต Local MCP (`/mcp`) หรือ URL จาก log รอบเก่า

### สำหรับคนที่เคยเปิด Tunnel ไว้ก่อนอัปเดต

1. ติดตั้ง lnwjud v5.6.4 แล้วเปิดโปรแกรมตามปกติ **ใช้ Tunnel ID เดิมได้เลย** ไม่ต้องสร้าง Tunnel ใหม่ หากเปิด Persistent Tunnel Runtime ไว้ โปรแกรมจะเริ่มเชื่อมต่อให้อัตโนมัติ
2. ดูสถานะที่ **Settings → เชื่อมต่อ ChatGPT → Persistent Tunnel Runtime** ให้ขึ้นว่า Tunnel กำลังทำงาน หากยังไม่ทำงาน ให้กด **Start Tunnel** ครั้งเดียวและรอจนปุ่มกลับมาใช้งานได้
3. ใน ChatGPT ถ้ามีแอป MCP เดิมอยู่ ให้กด **Refresh** ที่แอปนั้น หากยังไม่มี ให้สร้างแอป MCP โดยเลือก **Tunnel → Tunnel ID เดิม → ไม่มีการยืนยันตัวตน → สร้าง** ไม่ต้องกรอกช่อง OAuth แม้เคยเห็นข้อความ `Unauthorized - Access token is missing`
4. ถ้า lnwjud แจ้งว่าไม่สามารถตรวจสอบ Tunnel ตัวเก่าได้อย่างปลอดภัย ให้ **รีสตาร์ต Windows** แล้วเปิด lnwjud ใหม่ จากนั้นลองข้อ 2–3 อีกครั้ง โปรแกรมจะไม่ปิด process ที่ยืนยันไม่ได้เอง บน macOS/Linux หากสงสัยว่ามี runtime เก่าค้าง ให้รีสตาร์ตเครื่องก่อนลองใหม่เช่นกัน
5. หากยังไม่เชื่อม ให้เปิด **Live Logs → Tunnel** และดูข้อความผิดพลาดล่าสุด เมื่อติดต่อผู้ดูแล ให้ส่งเฉพาะข้อความผิดพลาดโดยปิดบัง Runtime API key และข้อมูลส่วนตัว

กรณีที่พบจริงคือมี `tunnel-client` สองตัวใช้ Tunnel ID เดียวกัน ตัวเก่าชี้ไปยัง MCP พอร์ตที่ปิดแล้ว ทำให้บางคำขอจาก ChatGPT ล้มเหลวเป็น `424 Failed Dependency` และอาจเห็น `Unauthorized - Access token is missing` ในหน้าสร้างแอป การเปลี่ยนไปเลือก OAuth ไม่แก้พอร์ตเก่าที่ค้างอยู่ lnwjud v5.6.4 บน Windows จะหยุดเฉพาะตัวเก่าที่ตรวจยืนยันว่าเป็นของโปรแกรมและใช้ Tunnel ID เดียวกัน

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

ตั้งแต่ v4.61.0 เมื่อเริ่มพิมพ์ค้นหา Work Log ระบบจะตรึงรายการเป็น snapshot ณ ตอนเริ่มค้นหา ข้อความใหม่ที่เข้ามาจะไม่แทรกหรือดันผลลัพธ์ให้กระโดดระหว่างค้นหา; เมื่อล้างคำค้นจึงกลับไปแสดง feed ล่าสุดทันที. Live Logs ทุกแท็บใช้พฤติกรรมเดียวกัน และปุ่ม **Pause** จะตรึง feed จริง ๆ; **Follow** จะกลับไปรับรายการใหม่เมื่อไม่มีคำค้นค้างอยู่. ตั้งแต่ v4.62.0 snapshot จะตรึงข้อมูล Workspace ที่ใช้กรอง/แสดงผลไปพร้อมกันด้วย จึงไม่เกิดการโหลด full-detail search ซ้ำทุกครั้งที่ dashboard refresh ขณะกำลังค้นหา

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
- lease มี timeout และ takeover หลัง expiry ตามปกติ แต่ recurring mainline สามารถกู้ still-valid stale lease ใน hourly tick เดิมได้หลัง bounded stale-heartbeat grace 60 วินาที เมื่อ trustworthy liveness ยืนยันว่าไม่มี live fenced call และไม่มี `blocking_job` ที่ running/unknown; raw lease token ไม่ถูกเก็บลงฐานข้อมูล มีเฉพาะ SHA-256 hash
- owner ผูกกับ stable MCP `clientId` จึง resume ต่อได้แม้ session/tunnel reconnect เปลี่ยนไป แต่ client อื่นไม่สามารถแย่ง goal ได้
- `get_goal_plan` แสดง authoritative plan และ `update_goal_plan` อัปเดต plan/step progress ชุดเดียวกันที่ Watcher ใช้แสดงผล ดังนั้นเมื่อสถานะ step เปลี่ยนต้องอัปเดตทันที ไม่สร้าง planner หรือ progress state แยกอีกชุด
- `trackedTasks` เป็นรูปแบบใหม่ที่เก็บความสัมพันธ์ระหว่าง goal กับงานพื้นหลัง โดยแต่ละรายการมี `taskId`, `provider` (`process`/`codex`/`shell`), `role` (`blocking_job` หรือ `supporting_service`) และ `cancelWithGoal`. เฉพาะ `blocking_job` เท่านั้นที่ใช้ตัดสิน liveness; service กลาง เช่น MariaDB ไม่ block continuation และไม่ถูกยกเลิกเว้นแต่ระบุว่า goal เป็นเจ้าของ lifecycle. `activeTaskIds` ยังรับได้เพื่อ backward compatibility และจะถูก decode เป็น legacy blocking job แบบ conservative
- `cancel_goal` เก็บ binding เดิมไว้ใน checkpoint และคืน `taskCancellations` ครบทุก task: รายการที่ `cancelWithGoal=false` จะเป็น `status=skipped` และยังทำงานต่อโดยเจตนา ส่วน provider ที่ระบุแต่ไม่มี backend หรือยืนยันการหยุดไม่ได้จะเป็น `status=failed`; ดังนั้น `allTasksStopped` จะเป็น `false` จนกว่าจะตรวจงานค้างเหล่านั้น
- `finish_goal` ปิด goal เป็น `completed`, `failed` หรือ `blocked`; ถ้ายังมี recurring Native ChatGPT watchdog ที่ต้องทำให้ non-runnable จะคืน `status=active` พร้อม `completionState=pending_native_cleanup` ก่อน และต้องทำตาม `scheduledTaskCancellation`, บันทึก host receipt แล้วเรียก `finish_goal` ซ้ำ จึงจะได้ `completionState=completed`; หลัง finish ต้องอ่าน `get_goal` ยืนยัน terminal จริง และ goal ที่จบแล้วจะไม่ถูกเปิดกลับเอง
- ข้อมูล summary/evidence ที่เข้าข่าย token/password/API key ถูก redact ก่อน persist/log

สำหรับงานยาว ให้ checkpoint **ทันที** หลัง milestone สำคัญ เช่น step/task/blocker/commit/push/hosted CI/package เปลี่ยนสถานะ และถ้าทำงานต่อเนื่องโดยไม่มี milestone ตามธรรมชาติให้ refresh อย่างน้อยทุก 10 นาที พร้อม `nextAction` และ `resumeContext` ที่ reconstruct งานต่อได้โดยไม่เดา: changed files, คำสั่งพร้อมผล pass/fail/running, decisions, failed attempts, pending validation, resume prerequisites, state facts และ artifacts. checkpoint เป็น state persistence ไม่ใช่จุดหยุดงาน; ถ้า CI/test/build/package/release validation ล้มเหลวแบบแก้ได้ ให้เปิดผลล้มเหลวจริง วิเคราะห์ root cause แก้ และ validate ต่อใน turn เดิม. Goal ที่งานเสร็จแล้วหรือถูกแทนที่/abandon แล้วต้องไม่ปล่อยค้าง `Active` ใน Watcher; ให้ reconcile/finish ตามหลักฐานจริงก่อนรายงานผู้ใช้

### ใช้ recurring Native ChatGPT watchdog ตัวเดียวต่อ durable goal

ตั้งแต่ v4.53.0 `prepare_scheduled_continuation` จะ checkpoint แล้ว **ensure recurring Native ChatGPT watchdog เพียง 1 ตัว** ต่อ active durable goal. Watchdog ใหม่ใช้ `occurrence=interval`, `intervalMinutes=60`, current chat และ request cloud execution. ถ้าไม่ระบุ `successorDelayMinutes` รอบแรกจะอยู่ที่ประมาณ 60 นาที; ค่า legacy 2–25 นาทีที่ยังส่งมาได้จะเปลี่ยนเฉพาะ **first firing** เท่านั้น แต่ cadence หลังจากนั้นยังเป็นทุก 1 ชั่วโมง. `dueAt` ของ recurring row จึงเป็นเวลารอบแรก ไม่ใช่ handoff deadline และไม่ตัด lease 600 วินาทีของ worker ที่กำลังทำงาน. ถ้ามี v4.52.x one-time watchdog เดิมที่ยัง live อยู่ ระบบจะ reuse ตัวเดิมจนเป็น historical ก่อนและห้ามสร้าง recurring ซ้อน. หลัง host สร้าง task ต้อง record native task ID กับ dueAt จริงทันที; `runsOn: cloud` ใช้ได้เมื่อ host ยืนยันจริง ส่วน host ที่ยืนยัน task/schedule แต่ไม่เปิด execution mode ให้เก็บ `unverified`. ถ้า host คืน explicit lookup/dispatch failure เช่น `Resource not found` ที่พิสูจน์ว่า create ยังไม่ dispatch ให้ re-resolve Native Scheduled Task operation จาก host surface ปัจจุบัน 1 ครั้งและ retry exact operation เดิม 1 ครั้ง; ambiguous possible-success ห้าม retry. ถ้ายังสร้างไม่ได้ให้ record `create_failed` ตามจริงและคง goal เป็น `active` เพราะ scheduler transport degradation ไม่ใช่ผลลัพธ์ของงาน. ห้าม fallback ไป lnwjud scheduler, Windows Task Scheduler, cron, shell timer, DOM/browser automation หรือ scheduler ภายนอก.

เมื่อ recurring Scheduled turn ตื่นขึ้น ต้องเรียก `claim_scheduled_continuation` เป็น **lnwjud action แรกก่อน mutation**. ตั้งแต่ v5.5.0 การอ่านสถานะ blocking task ระหว่างตรวจ worker liveness มีเวลารอแบบ bounded; ถ้า provider ไม่ตอบจะคืนสถานะ `unknown` แบบ fail-closed แทนการปล่อย `claim_scheduled_continuation` ค้างไม่มีกำหนด และจะไม่ถือว่า task หายเพื่อแย่ง lease อย่างไม่ปลอดภัย. Mainline v4.53 มีผลลัพธ์สำคัญดังนี้: `recurring_acquired` = ได้ lease ใหม่และทำงานต่อโดยใช้ native task ID เดิม; `worker_busy_noop` = มี worker/blocking work อยู่หรือ liveness ยังไม่แน่นอน ให้คืนตัวโดยไม่ mutate และไม่แตะ Scheduled Task; `already_claimed` = true concurrent/stale duplicate ที่ observation ยังตามหลัง lease acquisition เดิมอยู่เท่านั้น; การมี runKey ของ tick เดิมอย่างเดียว **ห้าม** ใช้สรุปว่ามี worker และ same-interval retry ที่เห็น lease ปัจจุบันต้องตรวจ liveness/stale recovery ต่อ; `terminal_cleanup_required` = ทำ cleanup เท่านั้น ห้าม resume งาน และต้องทำ exact recurring task ให้ non-runnable; `terminal_noop` = ไม่มีงานให้ทำ. Recurring tick ปกติ **ห้ามสร้าง successor, ห้าม consume task, ห้าม retime cadence**. ทุก mutation ที่ได้ `recurring_acquired` ต้องแนบ `goalLease` token/generation ของ run ปัจจุบัน. Full Bypass ไม่ข้าม durable-goal ownership fence. ถ้า lease ยังไม่หมดแต่ trustworthy liveness ยืนยันว่าไม่มี live fenced call และไม่มี blocking job ที่ running/unknown แล้ว และ heartbeat เก่ากว่า bounded stale-recovery grace 60 วินาที ระบบต้อง takeover เป็น `recurring_acquired`/`orphan_recovered` **ใน hourly tick เดิมทันที** ห้ามรอ lease หมด ห้ามรอ probe รอบชั่วโมงถัดไป และห้ามสร้าง native task ใหม่. `orphan_probe_noop` เหลือไว้เฉพาะ compatibility กับข้อมูล pre-hardening เท่านั้น. สำหรับ historical `occurrence=once` จึงยังคง two-probe orphan fence และ path `acquired`, `successor_required`, `reschedule_required`, consumed receipt กับ fresh one-time successor ตาม compatibility v4.52.x.

Worker ของ recurring v4.53 เป็นแบบ **work-conserving**: `checkpoint_goal` มีไว้บันทึก progress ไม่ใช่คำสั่งจบรอบ. หลัง checkpoint ปกติ worker ต้องทำงานที่ยังมีประโยชน์ต่อใน turn เดิม; transient status/log/result/poll error ต้อง retry/re-resolve ก่อน, background task ที่ terminal แล้วต้องอ่านผลและจัดการต่อทันที, และ lease 600 วินาทีไม่ใช่เวลาสูงสุดของการทำงาน—ถ้า lease หมดระหว่าง run ให้ reacquire goal เดิมอย่างปลอดภัยแล้วทำต่อเมื่อไม่มี owner ใหม่ที่ live. ChatGPT host ไม่รับประกันรอบละ 22/25 นาที แต่ worker ไม่ควรหยุดเองเพียงเพราะ checkpoint หรือ tool สะดุดชั่วคราว.

`expedite_scheduled_continuation` ใน v4.53 ใช้ได้เฉพาะ **historical `occurrence=once` ที่ยัง pending** เท่านั้น; recurring `occurrence=interval` ห้าม expedite เพราะ cadence ถูกล็อกไว้ทุก 1 ชั่วโมงและ host contract ไม่มี immediate-run operation ที่พิสูจน์ได้. ระหว่างมี `trackedTasks` ให้ bounded wait เฉพาะ `blocking_job` จนอ่าน terminal result จริง ห้ามสรุป completion จาก progress log. เมื่อ acceptance ครบจริง, durable plan ทุก step เป็น `completed`, `blockers` ว่าง, ไม่มี blocking task ค้าง และถ้า Engineering Harness มีผล required engineering gates/review findings ต้องผ่านหรือ resolve จาก evidence จริง จึงเรียก `finish_goal(status: completed)` ได้; `failed`/`blocked` ต้องเป็นผลลัพธ์ของงานจริง ไม่ใช่ทางหนีจาก `create_failed` หรือ `Resource not found`. ถ้า `finish_goal` คืน `status=active` กับ `completionState=pending_native_cleanup`, ต้องทำ **exact recurring native task เดิม** ให้ non-runnable ผ่าน host operation ที่ expose จริง: prefer true delete; ถ้ามีเพียง disable ให้ใช้ host-confirmed disable และ record operation/state ตามจริง. การที่ recurring task ยิงไปหนึ่งรอบ **ไม่ใช่** consumed cleanup proof และห้ามใช้ `consumed` เพื่อปิด interval task. ถ้า hourly wake รอบถัดไปพบ `terminal_cleanup_required` ให้ทำ cleanup อย่างเดียว ห้าม resume goal work. หลัง cleanup ถ้า lease ของ worker ที่เริ่ม completion หมดแล้ว ให้ `run_goal` ด้วย workspace/goalKey เดิมเพื่อ reacquire lease สำหรับ **administrative finalization เท่านั้น** และห้ามกลับไปทำ workspace work จากนั้นเรียก `finish_goal` ซ้ำทันทีและอ่าน `get_goal` จนยืนยัน terminal ก่อนรายงานสำเร็จ. ใช้เฉพาะ Native ChatGPT Scheduled Tasks; ห้าม lnwjud scheduler, Windows Task Scheduler, `schtasks.exe`, cron, shell timer, browser automation หรือ undocumented OpenAI API.

## 8A. Engineering Harness — Senior coding workflow

Engineering Harness เป็น workflow สำหรับงานเขียนโปรแกรมที่ **ปิดเป็นค่าเริ่มต้น (Default Off)** เพื่อไม่เปลี่ยนพฤติกรรมของผู้ใช้ทั่วไป ถ้าต้องการใช้ ให้เปิด **Settings → Engineering Harness** แล้วเลือก Preset:

- **Senior** — แนะนำ: วิเคราะห์ข้ามไฟล์เมื่อจำเป็น, ตรวจผลกระทบ, review และ validation ตามความเสี่ยง
- **Standard** — เบากว่า เหมาะกับงานทั่วไป
- **Strict** — เข้มขึ้นสำหรับงานเสี่ยง/ระบบสำคัญ
- **Custom** — เลือก Analysis, Review, Validation และ docs-impact check เอง

โดยปกติ Scope คือ **เฉพาะโปรเจกต์/งานเขียนโค้ด** และสามารถ Override ราย Workspace เป็น On/Off พร้อม Preset ของ Workspace ได้. ถ้า Workspace หรือ project profile ปิด Harness ชัดเจน ระบบต้องเคารพ opt-out และไม่เปิดกลับเอง. Project profile สามารถเพิ่มความเข้มของ policy ได้ แต่ไม่ควรใช้เพื่อลดข้อกำหนดที่ผู้ใช้ตั้งไว้โดยไม่บอก.

เมื่อ Harness เปิดอยู่สำหรับงาน coding:

1. เรียก `engineering_prepare_task` เพื่ออ่านสัญญาณโปรเจกต์, `AGENTS.md`, `.lnwjud/project-profile.json` และคำนวณ effective policy แบบ read-only
2. เรียก `engineering_start_task` เพื่อสร้าง/Resume durable Goal เดิม และรับ `engineeringTask` binding
3. แนบ `engineeringTask` binding ปัจจุบันกับ first-party development mutation ที่ถูก guard เช่น file edit/patch, Git, shell/process/project commands, verification, Codex/Agent Swarm และ worktree operations
4. ถ้า Goal revision, user-intent revision, session หรือ policy digest เปลี่ยน binding เก่าจะถูกปฏิเสธแบบ recoverable ให้ refresh ผ่าน `engineering_get_status`/`engineering_start_task`
5. Required gate จะไม่ถือว่าผ่านจนมี evidence ที่ตรงชนิด; mechanical checks เช่น test/build/package ต้องใช้ host-observed evidence ที่ตรวจสอบได้ ไม่ใช่คำยืนยันลอย ๆ
6. Requirement ใหม่จะเพิ่ม `userIntentRevision` และทำให้เฉพาะ gate ที่ได้รับผลกระทบเป็น `stale`; งานที่พิสูจน์แล้วและไม่เกี่ยวข้องยังคงอยู่
7. `finish_goal(completed)` จะถูกบล็อกถ้ายังมี required gate Pending/Running/Failed/Blocked/Stale หรือมี blocking review finding ที่ยังไม่ resolve

หน้า Settings แสดง Effective policy, เหตุผลที่ Harness inactive, Task kind, Risk, Phase, Next action และ Required checks พร้อมสถานะ **Pending / Running / Passed / Failed / Blocked / Needs re-check**. สี/สถานะ Passed ต้องมาจากหลักฐานจริง ไม่ใช่เพราะมีข้อความสรุปว่า “เสร็จแล้ว”.

**ขอบเขต enforcement ใน v5.7.0:** first-party development routes ถูก guard เชิงกล แต่ `mcp_call` ไป external MCP, Office ทั่วไป, web และ native UI routes ยังเป็น advisory ของ Engineering Harness และยังคงใช้ permission/security control เดิมของ lnwjud. Engineering Harness ไม่ได้เพิ่มสิทธิ์และไม่ข้าม Active Project, Recovery, approval, Full Bypass semantics หรือ rolling `goalLease` ownership fence.

การเปิด Harness หรือเปิด Preview ของ project profile **ไม่เขียนไฟล์โปรเจกต์, ไม่ commit/push/deploy และไม่สร้าง Scheduled Task เอง**. Scheduled continuation เป็นการตัดสินใจแยกต่างหากของผู้ใช้; ถ้าผู้ใช้ปิด scheduler ต้องทำงานต่อแบบ manual/durable โดยไม่เปิดกลับเอง.

## 9. Active Projects และหลายแชทพร้อมกัน

v4.11.0 รองรับ Active Projects หลายรายการพร้อมกัน

- แต่ละ MCP session มี session identity แยกกัน
- process/task handle ถูกแยกตาม owner/session
- file / Git / process / shell / database / Office / native-path tools ต้องทำงานได้กับ **ทุก workspace ที่อยู่ใน Active Projects set** ไม่ใช่เฉพาะ Primary Project
- ถ้า request มี absolute `path`, `cwd`, database `target` หรือ path field ที่ชี้ไปยัง Active Project ตัวอื่น runtime จะ route `workspaceId` ไปยังสมาชิกที่ครอบ path นั้นโดยอัตโนมัติ; เมื่อ Full Bypass ปิด path ที่ไม่อยู่ใน Active set ยังถูก guard ตามเดิม
- Primary Project เป็นเพียงค่า default เมื่อ client ไม่ได้ระบุ project/path ชัดเจน ไม่ใช่ขอบเขตสิทธิ์เพียงรายการเดียว
- Work Log และ Live Logs สามารถกรอง Workspace / Session ได้

อย่าเลือกทั้งไดรฟ์เป็น Active Project เพียงเพื่อความสะดวก ถ้างานจริงอยู่ใน project folder ที่เจาะจง

lnwjud จะไม่สแกนหรือลงทะเบียน filesystem root อัตโนมัติแล้ว รวมถึง mount/network path ที่ไม่ได้เลือกเอง ให้เพิ่มเฉพาะโฟลเดอร์โปรเจกต์ที่ต้องใช้ผ่านหน้า Projects หรือระบุ `--workspace` สำหรับ STDIO. รายการ legacy ที่ระบบเคยสร้างเองจะถูก archive แบบกู้กลับได้ โดยไม่ลบโฟลเดอร์หรือ project registration จริง

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

ตารางหน้า Recovery แสดงรายการล่าสุดในพื้นที่คงที่พร้อม scrollbar ส่วน retention ผู้ใช้เลือกเอง โดย **ผู้ใช้ที่ยังไม่เคยตั้งค่า retention จะเริ่มต้นที่ 30 วัน**; ถ้าเคยตั้งค่าไว้แล้ว โปรแกรมจะคงค่าของผู้ใช้เดิมไว้:

- `0` วัน = ไม่ลบอัตโนมัติ เก็บจนกว่าจะจัดการเอง
- มากกว่า `0` = ลบข้อมูล recovery ที่เก่ากว่าจำนวนวันที่ตั้งไว้

เมื่อเปลี่ยนจากไม่ลบอัตโนมัติไปเป็น retention ที่สั้นลง โปรแกรมจะเตือนก่อน เพราะข้อมูลเก่าอาจถูก cleanup ทันที

## 12. Live Logs

Live Logs ใช้ดูสถานะ realtime ของ:

- Tunnel/runtime lifecycle
- MCP activity
- managed processes/tasks

ถ้างาน fail ให้ดู Live Logs และหน้า Doctor ก่อน ไม่จำเป็นต้องเปิด PowerShell เพื่อรัน tunnel-client เอง

External MCP/Serena จะถูกปิดเมื่อ idle ตามค่าที่ตั้งไว้ โดยไม่ตัด call ที่กำลังทำงานอยู่. เมื่อปิดโปรแกรม, เปลี่ยน command, ปิดใช้งาน หรือลบ server ระบบจะ abort การเชื่อมต่อที่รออยู่และปิด process tree ที่ lnwjud เป็นเจ้าของ (process group บน macOS/Linux และ `taskkill /T /F` บน Windows). ถ้าตรวจไม่ได้จริงจะแสดง `termination_unverified` ใน `mcp_list` และ Doctor แทนการรายงานว่าสำเร็จ.

การสร้างไฟล์ภาพ/ไฟล์ไบนารีจาก ChatGPT แล้วส่งเข้าโฟลเดอร์โดยตรงไม่ใช่ความสามารถอัตโนมัติของ MCP bridge: ใช้เครื่องมือสร้างภาพของ ChatGPT แล้วดาวน์โหลดไฟล์ จากนั้นให้ lnwjud `copy_file` ไปยังโฟลเดอร์ที่อนุญาต หรือใช้ `write_file` เฉพาะข้อความ UTF-8. lnwjud ไม่รับ file-id จากหน้า ChatGPT เพื่อเขียนลงดิสก์เองโดยไม่มีการสั่ง copy ที่ชัดเจน.

## 13. Doctor / Troubleshooting

อาการที่พบบ่อย:

| อาการ | ตรวจสอบ |
|---|---|
| ไม่พบ `agent_swarm_run` ใน ChatGPT | ใน lnwjud ไปที่ **ตั้งค่า → เครื่องมือ** เปิด **Codex delegation** และบันทึก จากนั้นไปหน้า **เครื่องมือ** เปิด `agent_swarm_run` การเปลี่ยนแปลงมีผลกับ MCP/Tunnel ที่เปิดอยู่ทันที หาก ChatGPT ยังแสดงรายการเก่า ให้รีเฟรชหรือสแกนเครื่องมือของแอปที่เชื่อมต่อใน ChatGPT แล้วลองใหม่ |
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

**หมายเหตุ Agent Swarm:** ต้องเปิดทั้งสวิตช์ Codex delegation และเครื่องมือ `agent_swarm_run` การเปิด Full Bypass หรือการอนุญาต EXECUTE อย่างเดียวไม่ทำให้เครื่องมือที่ปิดไว้ปรากฏขึ้น การดูรายการ/สถานะเป็นการอ่านข้อมูล ส่วนการเริ่มหรือยกเลิก Agent Swarm ยังต้องผ่านการอนุมัติจากเครื่องที่รัน lnwjud

## 13A. ฟีเจอร์ใน source v5.8.0 — Workflows, Doctor และ CSV/XLSX

- **เวิร์กโฟลว์ 6 แบบ:** เลือกโครงการ, รีวิวโค้ด, ตรวจความพร้อม Release, ตรวจการเชื่อมต่อ, ตรวจข้อมูล และสร้างรายงานต้นแบบได้ทั้งภาษาไทย/อังกฤษ ระบบตรวจช่องที่จำเป็นก่อนเตรียมงานและแสดงตำแหน่งที่ต้องแก้ โดย **เตรียมร่างไม่เท่ากับเริ่ม Goal** และไม่สร้าง Scheduled Task อัตโนมัติ
- **Doctor:** แท็บ Checks/Calls/Results/Resources แสดงข้อมูลที่ระบบวัดหรือพบจริง เช่น Goal และเครื่องมือที่เลือกได้จากรายการ ไม่ต้องจด ID; เลือกทั้งหมดเป็นค่าเริ่มต้น บางข้อมูลอาจแสดง `unknown`/`unavailable` เมื่อระบบยังไม่มีหลักฐาน ห้ามตีความเป็นศูนย์หรือสถานะปกติ
- **ผลลัพธ์/Recovery:** ดูหลักฐานตาม Goal และ preview การเปลี่ยนแปลงที่มีขอบเขต ก่อนเรียก restore ต้องตรวจ Project, Goal revision, สิทธิ์และ hash ตามจริง ไม่ใช่คำสั่ง Undo ที่ปลอดภัยโดยอัตโนมัติ
- **CSV/XLSX:** เลือกไฟล์ผ่าน Browse ของระบบเพื่อตรวจโครงสร้าง/ข้อมูล เปรียบเทียบเซลล์ และสร้างรายงาน; ไฟล์ต้นฉบับไม่ถูกเขียนทับเป็นค่าเริ่มต้น ความสามารถ native Office ขึ้นกับ OS, โปรแกรมและ provider ที่ติดตั้ง; ถ้าไม่พร้อมจะแสดง `needs_setup`/`unsupported` ตามจริง
- **การค้นหาและหน้าจอ:** dropdown/Settings ใช้รูปแบบเดียวกัน, Git เปิดโฟลเดอร์ที่มีการเปลี่ยนแปลงและยังพับได้, Work Log เริ่มที่ทุกโปรเจกต์, การค้นหาจะแสดงสถานะกำลังโหลดเมื่อจำเป็น
- **การตรวจสอบก่อนเผยแพร่:** ต้องผ่าน release gates ของ commit บน `main` สำหรับ Windows/macOS/Linux, package provenance และ SHA256 พร้อมเปิดไฟล์ติดตั้งทดลองใน host ที่รองรับ; ผล unit tests บนเครื่องหนึ่งไม่ใช่หลักฐานว่า native provider อีกระบบใช้ได้

คู่มือนี้แยก **source v5.8.0** ออกจาก **public release ล่าสุด** ในหัวเอกสารจนกว่า GitHub จะเผยแพร่ artifact ของ v5.8.0 จริง

---

## 14. Local STDIO สำหรับ Codex/IDE

Secure Tunnel สำหรับ ChatGPT web ใช้ **Desktop HTTP MCP** และ bundled tunnel-client

ส่วน Codex CLI หรือ MCP host ที่อยู่บนเครื่องเดียวกันใช้ packaged STDIO launcher ได้โดยตรง:

```text
lnwjud-mcp-stdio.cmd --workspace E:\projects\my-app
```

ครั้งแรกต้องระบุ `--workspace` (หรือเพิ่มโปรเจกต์ไว้ก่อน) ระบบจะไม่เดา drive เริ่มต้นจาก `C:`/home/current directory

launcher ใช้ packaged Electron host และไม่ต้องลง Node.js system-wide

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

`package:windows`, `package:macos` และ `package:linux` จะเลือกและดาวน์โหลด official OpenAI tunnel-client v0.0.16 สำหรับ **OS/architecture target นั้น** เท่านั้น ตรวจ SHA-256/provenance/version ที่ pin ไว้ แล้ว bundle binary เข้า package อัตโนมัติ ถ้า target tuple ไม่ตรงหรือหลักฐานไม่ผ่าน build จะหยุดทันที End user ที่ใช้ release ไม่ต้องทำขั้นตอนนี้

ไฟล์ที่ได้จะอยู่ที่:

```text
apps/desktop/dist/installers/lnwjud-Setup-5.8.0.exe
apps/desktop/dist/installers/lnwjud-Portable-5.8.0.exe
apps/desktop/dist/installers/latest.yml
apps/desktop/dist/installers/portable.yml
```

ดูรายละเอียด architecture/tool catalog เพิ่มเติมที่ `README.md`, `docs/mcp/MCP_TOOL_CATALOG.md` และ `docs/architecture/`
