# lnwjud — สรุปความสามารถทั้งหมด

สถานะเอกสาร: สรุปจาก source และ runtime contract ปัจจุบันของ lnwjud v4.31.0 (มีทั้งหมด 231 definitions; advertise 195 tools โดยปริยาย และ 201 tools เมื่อเปิด Codex delegation)
ขอบเขต: ความสามารถของ gateway, MCP tools, การเชื่อมต่อ AI, สิทธิ์, Live Logs และข้อจำกัดในการใช้งาน
เอกสารนี้ถูกติดตามใน repository และต้องสอดคล้องกับ source, runtime contract และ release ปัจจุบัน

## สรุปสั้น

lnwjud ไม่ใช่ AI model และไม่ใช่ provider API aggregator แต่เป็น Windows-first local development gateway ที่เปิดความสามารถของเครื่องและ workspace ให้ AI host ที่พูดภาษา Model Context Protocol (MCP) ได้

ความสามารถหลักใน v4.31.0 คือ:

- เปิด workspace และ machine roots ให้ AI อ่าน ค้นหา วิเคราะห์ และแก้ไขไฟล์ได้
- ใช้ Context Economy Engine ลด I/O/token จากการค้นหาอัตโนมัติ โดยยังอ่าน .env, .git, dist และ node_modules ได้เมื่อร้องขอแบบ explicit และอยู่ในขอบเขตที่ workspace/path policy อนุญาต
- ค้นหาแบบตรง, อ่านหลายไฟล์, อ่านแบบแบ่งหน้า, continuation และ persistent index
- วิเคราะห์ symbol, definition, reference, implementation, call hierarchy, import และ dependency graph
- ตรวจ Git status, diff, log, history, blame และรัน Git subcommands ผ่าน argument array
- รัน project dev/test/lint/typecheck/build และจัดการ process พร้อม bounded logs
- เรียกใช้ local Codex CLI แบบมี task id, status, logs, stop และ audit
- ทำ compound/batch/parallel work โดยอ่านแบบขนานได้ และ serialize งาน mutation
- ใช้ recipe, dry-run, execution plan, route intent, dev_context และ affected-test context
- ควบคุม browser/UI/Windows/media/Office/scheduler ผ่าน capability facade
- ต่อ child MCP servers และ local skills ผ่าน bridge
- มี task/delegation/session/checkpoint/handoff สำหรับงานต่อเนื่องและหลาย agent
- มี Permission v2, lifecycle hooks, audit, Live Logs v2, telemetry, Context Ledger/diff/dedupe, recovery และ capability discovery
- รองรับ visual adapter สำหรับ screenshot, DOM/layout, Excel และ PDF

ทุกการทำงานวิ่งบน Windows เครื่องเดียวกับ lnwjud ยกเว้นชั้นเชื่อมต่อที่ส่ง MCP ผ่าน tunnel หรือ transport ที่ client ใช้

## สถาปัตยกรรมและทางเชื่อมต่อ

lnwjud ใช้ MCP เป็นสัญญากลาง ดังนั้น AI แต่ละตัวไม่ได้ต้องมี adapter เฉพาะในตัว lnwjud ถ้า host/client ของ AI รองรับ MCP อยู่แล้ว ให้เลือก transport ที่ host รองรับ แล้วชี้มาที่ MCP server เดียวกัน

~~~mermaid
flowchart LR
  A["ChatGPT web / remote MCP host"] --> B["OpenAI Secure MCP Tunnel"]
  B --> C["tunnel-client"]
  C --> G["Desktop 127.0.0.1:<port>/mcp"]
  E["Codex CLI / local IDE / local MCP client"] --> D["lnwjud-mcp-stdio.cmd"]
  F["Local HTTP MCP client"] --> G
  G --> H["lnwjud MCP server"]
  D --> H
  H --> I["ToolRegistry"]
  I --> J["workspace, files, Git, process, Codex, Windows, browser, logs"]
  H --> K["child MCP bridge"]
~~~

### ChatGPT web

วิธีหลักคือ OpenAI Secure MCP Tunnel:

1. ChatGPT Developer App เลือก OpenAI tunnel
2. tunnel-client เปิด outbound HTTPS ไปยัง control plane
3. Desktop lnwjud เปิด loopback Streamable HTTP MCP ตาม port ที่ตั้งไว้
4. tunnel profile ชี้ `mcp.server_urls` ไปยัง Desktop `/mcp` endpoint นั้น
5. ChatGPT เห็น tools/list และเรียก tool ผ่าน tunnel โดยใช้ Active Project, permission profile และ native approval ของ Desktop runtime ชุดเดียวกัน

เครื่องไม่ต้องเปิด inbound firewall หรือ public port ต้องมี Tunnel ID, runtime key ที่มีสิทธิ์ Tunnels Read + Use และการผูก tunnel เข้ากับ ChatGPT workspace ตามข้อกำหนดของ OpenAI

`lnwjud-mcp-stdio.cmd` ใช้สำหรับ **direct local STDIO client** เช่น Codex CLI/IDE เท่านั้น ไม่ใช่ transport ของ Secure Tunnel ปัจจุบัน ส่วน `lnwjud.exe --mcp-stdio` เป็น compatibility path และไม่ใช่คำสั่งที่ UI แนะนำให้ copy

### Codex

Codex ที่ทำงานบนเครื่องเดียวกันเชื่อมแบบ local stdio ได้โดยตรง จึงไม่จำเป็นต้องใช้ tunnel:

~~~powershell
$launcher = Join-Path $env:LOCALAPPDATA 'Programs\lnwjud\lnwjud-mcp-stdio.cmd'
codex mcp add lnwjud -- $launcher --workspace E:\lnwjud
codex mcp list
~~~

ถ้า Codex หรือ AI host อยู่ในบริบท remote ที่เข้าถึงเครื่องไม่ได้ ให้ใช้เส้นทาง Secure MCP Tunnel แทน:

~~~text
Codex/remote host -> Secure Tunnel -> tunnel-client -> Desktop loopback HTTP MCP -> lnwjud
~~~

ดังนั้น “Codex ใช้ tunnel” และ “Codex ใช้ stdio” ไม่ขัดกัน แต่เป็นคนละ deployment mode: local Codex ใช้ stdio, remote Codex/host ใช้ tunnel

### Claude, IDE และ MCP client อื่น

ถ้า client รองรับ MCP stdio ให้ตั้ง command เป็น packaged launcher และส่ง workspace argument แบบเดียวกับ Codex ถ้า client รองรับ Streamable HTTP ให้ใช้ endpoint loopbackของ lnwjud:

~~~text
http://127.0.0.1:<port>/mcp
~~~

Claude Desktop, IDE extension หรือ agent host อื่นจะใช้ได้ก็ต่อเมื่อ client รุ่นนั้นเปิดใช้ MCP transport ที่ตรงกัน การมีชื่อ “Claude”, “Gemini” หรือ provider อื่นไม่ได้ทำให้ provider API ต่อกับ lnwjud โดยอัตโนมัติ

### Gemini, Ollama, model API หรือ AI ที่ไม่มี MCP

โมเดลหรือ provider ที่มีเพียง chat/completions API ยังต่อ lnwjud โดยตรงไม่ได้ เพราะ lnwjud ไม่ได้แปลง provider API ให้เป็น MCP และไม่ได้รับ API key ของ provider มาเป็นทางเชื่อมต่อ

วิธีรองรับคือใช้ agent host หรือ adapter ที่:

- เรียก model/provider ที่ต้องการ
- ทำหน้าที่เป็น MCP client
- ต่อ lnwjud ผ่าน stdio, loopback HTTP หรือ remote tunnel
- แปลงผล MCP tools ให้เป็น tool/function ของ host นั้น

ถ้า host ไม่มี MCP client ต้องเพิ่ม bridge ภายนอกก่อน ไม่ใช่เพิ่ม tool ใน lnwjud แต่ละตัวสำหรับทุก provider

### OpenAI Responses API และโปรแกรมเรียกใช้งานอื่น

OpenAI surface หรือโปรแกรมที่รองรับ remote MCP ใช้ Secure MCP Tunnel หรือ private HTTP MCP ได้ โดยต้องรักษา authentication และ network boundary ของ host นั้นเอง lnwjud ไม่ได้เปิด public HTTP server เป็นค่าเริ่มต้น

### lnwjud เรียก MCP server อื่น

เป็นคนละทิศทางกับการให้ AI มาเรียก lnwjud:

- mcp_list ค้นหา child MCP servers จาก configuration ที่รองรับ
- mcp_describe อ่านชื่อและ schema ของ child server
- mcp_call ส่งต่อคำขอไปยัง child server
- mcp_discover, mcp_health และ mcp_resources ตรวจ discovery, health และ resources

Bridge นี้ทำให้ lnwjud เป็น MCP gateway ได้ แต่ child tools ยังคงอยู่ภายใต้นโยบายและสิทธิ์ของ child server ไม่ได้ถูกทำให้ปลอดภัยขึ้นโดยอัตโนมัติ

## การตรวจว่าเชื่อมจริง

การเห็นชื่อ lnwjud ใน config หรือเห็น tools ในเอกสารยังไม่ใช่หลักฐานว่า client เชื่อมสำเร็จ การตรวจที่เชื่อถือได้ควรทำตามลำดับนี้:

1. ส่ง MCP initialize
2. ส่ง initialized notification
3. เรียก tools/list และตรวจ catalog ที่ client ได้รับ
4. เรียก tool จริง เช่น workspace_list หรือ workspace_info
5. ตรวจผลใน Live Logs, process logs หรือ tunnel log

สำหรับ runtime contract ปัจจุบัน full registry มี 231 tool definitions; ค่า default โฆษณา 195 tools และ 201 tools เมื่อเปิด `codex_*` 6 tools แบบ opt-in. การเห็น catalog เป็นหลักฐานของ runtime ที่ทดสอบ ไม่ได้ยืนยันว่า tunnel หรือ client ภายนอกกำลังเชื่อมอยู่ในขณะนั้น

ถ้า Start Tunnel เชื่อมแล้วหลุดวน:

- ตรวจว่า Desktop MCP ทำงานและ endpoint `http://127.0.0.1:<configured-port>/mcp` ตอบจาก lnwjud
- ตรวจว่า tunnel profile ใช้ `mcp.server_urls` ชี้ endpoint Desktop เดียวกัน ไม่ใช่ direct STDIO launcher
- รัน tunnel-client doctor
- ตรวจ log ที่ %APPDATA%\tunnel-client\lnwjud-tunnel.log
- ใช้ connection_max_ttl: 168h0m0s
- Persistent Tunnel Runtime จะ retry ด้วย capped backoff ต่อเนื่องจนกว่าผู้ใช้กด Stop/ปิด persistent runtime; failure ล่าสุดต้องแสดงใน Dashboard/Doctor แทนการเงียบหาย

## การแบ่งความสามารถตามระบบ

| ระบบ | ความสามารถ |
| --- | --- |
| Workspace | ลงทะเบียน workspace, machine roots, canonical path, tree, snapshot, multi-workspace context |
| Filesystem | อ่านไฟล์, อ่านหลายไฟล์, เขียน, patch, ย้าย, คัดลอก, ลบ, checkpoint และอ่านแบบแบ่งหน้า |
| Search/index | ค้นชื่อไฟล์/ข้อความ, exhaustive scan, persistent index, watcher, symbol และ dependency graph |
| Git | status, diff, log, generic Git arguments, history, blame, change context และ changed symbols |
| Project/process | dev, test, lint, typecheck, build, process start/status/logs/stop และ affected tests |
| Codex | discover executable, status, run task, task status/logs/stop, quota-safe audit boundary |
| Compound work | tool_batch, dependency waves, timeout, cancel, partial results, parallel read และ serialized mutation |
| Context intelligence | route intent, context ranking, debug/review/change/symbol/test/dependency/frontend/backend context, dev_context, Context Economy, ledger, diff/reference delivery, quota telemetry |
| Automation | recipe catalog/list/describe/run, dry-run, execution plan, lifecycle hooks และ recovery |
| Agent lifecycle | managed tasks, delegates, parallel delegation, session context/checkpoint/resume/history และ handoff bundle |
| Windows | environment, service, process, port, registry, event log, runtime, path และ startup context |
| Browser/UI | CDP, DOM, accessibility, input events, managed window, screenshot, UI state, form/network/console context |
| Desktop/media | shell capability, system health/info, notification, file dialog, clipboard, web fetch, audio, screen record |
| Office/visual | Excel/Word automation, workbook inspection/layout comparison/preview, PDF inspection/page comparison |
| Extensions | skills discovery/read/match/load, plugin lifecycle และ child MCP discovery/describe/call |
| Observability | ActivityTracker, NDJSON audit, Live Logs, telemetry dashboard, progress heartbeat, bounded process/tunnel/MCP streams |
| Discovery | capabilities, tool categories, tool search, tool function finder, tool schema registry, stable aliases |
| Quality | benchmark_run, regression_report, cache stats/clear/invalidate และ release compatibility gates |
| Project profile | อ่าน/ตั้ง project intelligence profile เพื่อเสริม context โดยไม่ลดสิทธิ์การเข้าถึง |

## Workspace, filesystem และ full visibility

### ขอบเขตการมองเห็น

สัญญา full visibility ของ lnwjud อนุญาตให้ read/search/index/watch ไฟล์ที่อยู่ใน workspace/path ownership รวมถึง:

- .env และไฟล์ environment
- .git และ metadata ของ Git
- dist, build และ generated output
- node_modules และ dependency trees
- hidden files, ignored files และไฟล์ขนาดใหญ่ที่ระบบอ่านได้

คำว่า full access หมายถึงไม่ใช้ automatic ignore เป็น access denial: discovery/index/watcher จะข้าม vendor/build/cache, binary และ generated artifacts เพื่อประหยัด I/O/token แต่ read_file, read_many_files, full scan และ explicit includeIgnored ยังเข้าถึง path ที่ policy อนุญาตได้ การ debounce, event coalescing และ concurrency queue เป็นการควบคุมแรงกดดันด้าน I/O/CPU ไม่ใช่การตัดสิทธิ์อ่าน

ผลลัพธ์ transport ยังมีการแบ่งหน้าและ byte bound เพื่อไม่ให้ response ใหญ่เกินไป นี่เป็นข้อจำกัดของการส่งข้อมูล ไม่ใช่การลดสิทธิ์ในการอ่านข้อมูล เครื่องมือที่เกี่ยวข้องได้แก่ workspace_context, workspace_full_scan, search_all, read_many_files, read_file_page และ continuation tools

### Index และ watcher

workspace_index สร้าง persistent index สำหรับค้นหา symbol, definition, reference, import, dependency และ module relationship ส่วน workspace_index_watch ติดตาม changed paths โดยมี debounce และ concurrency ที่กำหนดได้

index สามารถ rebuild ได้ เมื่อ continuation เก่าหรือข้อมูลใน index stale ระบบมี stale detection, rebuildable index และ safe retry boundary

### File mutation

write_file, apply_patch, move_file, copy_file และ delete_file ผ่าน path guard, same-workspace check, permission decision และ checkpoint ตามประเภทงาน ไม่ได้เปิด arbitrary recursive write ให้กับ compound tool เอง

## Search, code intelligence และ context

ความสามารถด้าน code intelligence เป็น deterministic local computation ไม่ต้องเรียก LLM เพื่อ:

- ค้น symbol และ type
- หา definition, reference และ implementation
- ดู call hierarchy
- สร้าง import/dependency/module graph
- trace symbol
- จัดอันดับ context และส่ง continuation สำหรับผลลัพธ์ที่อยู่ลำดับถัดไป

context facade รวมข้อมูล debug, review, change, symbol, test, dependency, Git, frontend และ backend ให้ AI ใช้ในรอบ MCP น้อยลง แต่ primitive tools ยังคงเรียกได้เสมอ

## Git, project commands และ process

Git adapter ใช้ argument array และให้ข้อมูล structured สำหรับ status, diff, log, history, blame และ generic git operation ตาม policy ของ workspace

Project tools ใช้ detected project profile และไม่รับ arbitrary shell string:

- project_dev
- project_test
- project_lint
- project_typecheck
- project_build

Process manager สร้าง process handle ที่เป็นเจ้าของ, เก็บ stdout/stderr เป็น bounded buffer, เปิด process_status/process_logs และหยุดเฉพาะ process tree ที่ lnwjud เป็นเจ้าของ

## Codex และ agent orchestration

codex_status ตรวจเฉพาะ executable, codex --version และ codex --help ไม่อ่าน credential files, tokens หรือ account state

codex_run สร้าง codexTaskId แล้วให้ client ติดตามด้วย codex_task_status และ codex_task_logs ก่อนตรวจ git_diff และรัน test ของ project งานที่ถูก delegate มี audit metadata และ process ownership

parallel_delegate และ tool_batch อนุญาต read-only parallelism เป็นค่าเริ่มต้น งาน mutation ต้องระบุ dependency/serialization metadata และจะไม่ถูกทำพร้อมกันโดยอัตโนมัติ เพื่อลด file collision แบบ cascade

handoff_context ทำ structured cross-agent handoff ส่วน session_checkpoint/session_resume ทำให้กลับมาทำงานต่อได้โดยใช้ metadata ที่ redacted

## Recipes, planner, cache และ lifecycle

recipe_list, recipe_catalog, recipe_describe และ recipe_run ทำให้ workflow bugfix, review, frontend และ release เป็น recipe ที่ตรวจสอบได้

dry_run แสดง permission decision และ mutation list โดยไม่ทำ side effect execution_plan เลือก execution path จาก route, cache และ index state ส่วน dev_context รวม route, operation และ continuation เป็น facade เดียว

cache_stats, cache_clear และ cache_invalidate ใช้ content identity และมี hit/miss telemetry ไม่ใช้ cache หรือ ranking เป็น authorization

hook_list, hook_register และ hook_remove รองรับ lifecycle before/after events ผลของ hook อาจ allow, deny หรือ modify ตาม contract โดยทุก event ที่มี side effect ต้องไปต่อใน audit/Live Logs

## Windows, browser, UI และ visual tools

### Windows capability facade

lnwjud มี facade สำหรับ environment, service, process, port, registry, event log, installed runtime, path และ startup context รวมถึง shell capability ที่รับ executable กับ argument array

### Browser และ desktop UI

dom_cdp, accessibility, input_event, vision และ window ทำงานกับ managed browser/desktop session:

- inspect DOM และ page state
- อ่าน accessibility tree
- ส่ง input event
- capture visual state
- ตรวจ window และ UI state
- ดู form, network, console และ browser debug context

browser automation ผูกกับ local CDP/managed browser และแยกจาก file guard

กติกา target ของ browser เป็นแบบ fail-closed: ให้ `dom_cdp list_tabs` ก่อน แล้วเลือก exact `tab_id` จาก ID ที่คืนมาพร้อมตรวจ URL/title; ถ้าไม่มีแท็บที่ปลอดภัยให้ `new_tab` และเก็บ ID ที่คืนมา จากนั้นส่ง top-level `tab_id` เดิมกับทุก target-scoped call หรือทั้ง `steps` batch หาก target หายให้หยุดและ list ใหม่ ห้ามสลับไป first tab หรือ OS-active tab เอง และห้ามใช้ `computer_use` / `accessibility` / `input_event` พิมพ์ URL ลง address bar เป็น fallback สำหรับ web navigation

การ mutate แท็บ ChatGPT ต้องมีทั้ง `allow_protected_tab_action: true` และ `userConfirmed: true` จากผู้ใช้จริง แม้เปิด Full Bypass ก็ไม่ถือว่าแทน explicit-user confirmation นี้ได้

### Media, Office และ visual adapter

มี notification, native file dialog, clipboard, web_fetch แบบ HTTP(S) bounded, audio record/play, screen_record, Office COM สำหรับ Excel/Word และ Windows scheduler

visual adapter เพิ่ม:

- capture_screenshot
- compare_screenshot
- dom_snapshot
- layout_metadata
- visual_context
- inspect_workbook
- compare_workbook_layout
- render_excel_preview
- inspect_pdf
- compare_pdf_pages

Office ต้องมี Microsoft Office ติดตั้ง ส่วน screen recording ต้องมี ffmpeg ตาม operation ที่ใช้

## Live Logs, audit, telemetry และ recovery

Live Logs v2 มีสาม stream หลักใน desktop:

- Tunnel: tail log ของ tunnel-client
- MCP activity: ทุก tool call และ child activity ที่รับผ่าน MCP
- Processes: state และ output ล่าสุดของ managed process

live_logs_query และ live_logs_status ใช้อ่านสถานะ/ข้อมูลแบบ bounded ActivityTracker เชื่อม correlation id ระหว่าง MCP request, compound child, recipe, hook, delegate, process และ tunnel event

Audit ถูกเก็บแบบ NDJSON ที่ redacted และไม่เก็บ file contents, credential หรือ prompt/output เต็มเป็น audit metadata ระบบมี progress heartbeat สำหรับงานยาว, telemetry dashboard, session checkpoint และ recovery status

การ log แยกจากความสามารถในการอ่านไฟล์: AI ที่ได้รับสิทธิ์อ่าน .env อาจอ่านข้อมูลนั้นได้ แต่ audit/Live Logs ไม่ควรบันทึกเนื้อหา credential ลง log และไม่ควรนำ credential ไปใส่ใน commit หรือ public issue

## Permission และ security boundary

| ชั้น | หน้าที่ |
| --- | --- |
| Workspace/path guard | ตรวจ canonical path, workspace ownership และ same-workspace boundary |
| Permission class | แยก filesystem.read/write/delete, shell, Git, process, browser, network และ system operation |
| Profile | safe, balanced, full หรือ custom กำหนดค่าเริ่มต้นของ READ/WRITE/EXECUTE/DANGEROUS |
| Standard-mode hard block | เมื่อ Full Bypass ปิด ปฏิเสธ action ที่ policy ของ lnwjud ห้ามแม้ full profile จะอนุญาต เช่น disk format หรือ shutdown/reboot |
| Full Bypass | toggle แยก Desktop/STDIO ที่ใช้ได้เฉพาะ profile full; ข้าม approval, host prompt, profile/command policy, Active Project/roots/protected path และ `goalLease` ของ lnwjud |
| Audit | บันทึก operation metadata ที่ผ่าน redaction และเชื่อมกับ Live Logs |

ค่า profile โดยสรุป:

| Profile | READ | WRITE | EXECUTE | DANGEROUS |
| --- | --- | --- | --- | --- |
| safe | allow | ask | ask | deny |
| balanced | allow | allow | allow | ask |
| full | allow | allow | allow | allow; standard-mode hard blocks ยังมีผลจนกว่าจะเปิด Full Bypass |
| custom | host-defined | host-defined | host-defined | host-defined |

Desktop HTTP MCP และ Secure Tunnel ใช้ Desktop profile/Full Bypass เดียวกัน ส่วน packaged direct STDIO ใช้ STDIO profile/Full Bypass แยกต่างหาก โดย default profile ยังคงเป็น `full` เพื่อ backward compatibility และสามารถเลือก `safe`, `balanced`, `full`, `custom` พร้อม Strict Roots ได้. Full Bypass ทั้งสองตัวเริ่ม OFF และไม่เปิดเองจากการเลือก Full.

เมื่อ Full Bypass ปิด การลบไฟล์และคำสั่ง destructive ต้องผ่าน confirmation/operation policy. เมื่อเปิด lnwjud จะข้าม application approval, always-confirm families, host approval, command/scope/protected-path/`goalLease` checks และยอมรับ explicit absolute outside path โดยไม่ปลอม `userConfirmed`. Schema/input, relative traversal, process/task/worktree ownership, Windows ACL/UAC, provider/runtime, remote service และ child MCP policy ยังมีผล; งานนอก workspace อาจไม่มี Recovery Trash.

## Capability discovery และ extensibility

tool_schema_list และ tool_schema_register เก็บ schema version, input/output contract, risk, stream support, parallel safety และ plugin owner

capabilities, tool_categories, tool_search, tool_describe, tool_function_find และ tool_aliases ช่วยให้ AI หาเครื่องมือที่ต้องใช้แบบ on-demand ได้ แต่ไม่ได้ซ่อนหรือลบ primitive tools จาก MCP contract

plugin_install, plugin_list, plugin_enable, plugin_disable และ plugin_remove ใช้กับ LnwjudPlugin SDK และ extension lifecycle

skill_match และ skill_load โหลด local skill ตาม intent ผ่าน skill bridge

## รายชื่อ MCP tools ใน runtime snapshot

runtime contract ปัจจุบันมีทั้งหมด 231 tool definitions; ค่า default ส่งกลับ 195 tools และส่งกลับ 201 tools เมื่อเปิด `codex_*` 6 tools. Planned และ feature-disabled definitions ยังคงอยู่ใน complete inventory แต่ไม่ถูก advertise. รายชื่อ full registry ตามลำดับ canonical มีดังนี้:

~~~text
workspace_list
workspace_register
workspace_info
workspace_tree
project_snapshot
read_file
read_files
search_files
search_text
git_status
git_diff
git_log
git
write_file
apply_patch
edit_file
move_file
copy_file
delete_file
list_recovery_items
restore_deleted_file
list_checkpoints
restore_checkpoint
process_start
process_list
process_status
process_logs
process_stop
project_dev
project_test
project_lint
project_typecheck
project_build
codex_status
codex_run
codex_task_list
codex_task_status
codex_task_logs
codex_stop
shell
dom_cdp
computer_use
accessibility
input_event
vision
vision_annotated_capture
ui_target_action
window
health
system_info
notification
file_dialog
clipboard
web_fetch
audio
screen_record
office
scheduler
wsl_exec
wsl_fs
skills_list
skills_read
mcp_list
mcp_describe
mcp_call
workspace_context
workspace_context_continue
workspace_full_scan
workspace_full_scan_continue
workspace_snapshot
search_all
read_many_files
read_file_page
read_file_page_continue
workspace_index
workspace_index_status
workspace_index_watch
workspace_index_stop
session_handoff
verify_incremental
run_goal
get_goal
checkpoint_goal
finish_goal
cancel_goal
list_goals
prepare_scheduled_continuation
record_scheduled_continuation_receipt
claim_scheduled_continuation
get_scheduled_continuation
expedite_scheduled_continuation
cancel_scheduled_continuation
symbol_search
find_definition
find_references
find_implementations
call_hierarchy
import_graph
dependency_graph
module_graph
type_search
trace_symbol
context_ranking
debug_context
review_context
change_context
symbol_context
test_context
dependency_context
git_context
frontend_context
backend_context
route_intent
recipe_list
recipe_describe
recipe_run
dry_run
review_changes
changed_symbols
affected_modules
git_history_context
git_blame_context
discover_tests
run_affected_tests
test_failures
coverage_context
test_history
cache_stats
cache_clear
cache_invalidate
hook_list
hook_register
hook_remove
skill_match
skill_load
plugin_install
plugin_list
plugin_enable
plugin_disable
plugin_remove
session_context
session_checkpoint
session_resume
session_history
response_mode
inspect_web_app
debug_ui
capture_ui_state
form_context
network_context
console_context
browser_debug_context
windows_environment
service_context
process_context
port_context
registry_context
event_log_context
installed_runtime_context
path_context
startup_context
mcp_discover
mcp_health
mcp_resources
task_create
task_status
task_cancel
task_result
task_list
delegate
delegate_status
delegate_cancel
delegate_result
parallel_delegate
permission_check
permission_profile
live_logs_query
live_logs_status
telemetry_dashboard
context_economy_stats
execution_plan
repo_map
context_expand
recovery_status
tool_schema_list
tool_schema_register
capabilities
tool_search
tool_dynamic_filter
tool_describe
tool_categories
tool_function_find
tool_aliases
mcp_hub
dev_context
recipe_catalog
capture_screenshot
compare_screenshot
dom_snapshot
layout_metadata
visual_context
inspect_workbook
compare_workbook_layout
render_excel_preview
inspect_pdf
compare_pdf_pages
project_profile_get
project_profile_set
handoff_context
benchmark_run
regression_report
sandbox_exec
event_watch
crash_trace
lsp_diagnostics
lsp_rename
debug_attach
debug_step
git_worktree_spawn
git_worktree_remove
db_inspect
db_query
office_ppt
office_outlook
pdf_extract_tables
docx_merge
self_heal_plan
self_heal_apply
skills_import
agent_swarm_run
tool_batch
~~~

## การตั้งค่าที่เกี่ยวข้อง

ค่าที่ใช้บ่อยอยู่ใน [.env.example](../.env.example):

| ค่า | หน้าที่ |
| --- | --- |
| LNWJUD_UNRESTRICTED | เปิด full local capability mode เมื่อเป็น 1 |
| LNWJUD_DATA_PATH | ตำแหน่ง SQLite และ activity data ที่ desktop/stdio ใช้ร่วมกันได้ |
| LNWJUD_TUNNEL_CLIENT_PATH | path ของ tunnel-client.exe |
| LNWJUD_PATH | path ของ lnwjud desktop executable สำหรับ viewer/dashboard |
| LNWJUD_MCP_PORT | port ที่ใช้ใน local MCP HTTP mode (default 18765) |
| LNWJUD_LOG_LEVEL | ระดับ log |

อย่าอ่านค่าจริงจาก .env มาใส่ในเอกสาร, audit หรือ commit ค่าในตารางเป็นเพียงชื่อ configuration ไม่ใช่ credential

## วิธีใช้งานตาม workflow

### Read, change, verify

workspace_info หรือ workspace_context -> read_file/read_file_page/search_all -> apply_patch/write_file -> git_diff -> project_test/project_lint/project_typecheck

### Start project

project_dev หรือ process_start -> process_status -> process_logs -> browser/UI context ตามความจำเป็น -> process_stop เมื่อจบ

### Delegate ให้ local Codex

codex_status -> codex_run -> codex_task_status/codex_task_logs -> git_diff -> test -> codex_stop หากต้องยกเลิก

### ใช้ AI หลายตัว

ให้ read-only agents ใช้ context/search/Git/test analysis แบบ parallel ได้ จากนั้น serialize งาน write/apply_patch/delete ผ่าน mutation boundary แล้วส่ง handoff_context ให้ agent ถัดไป

## ข้อจำกัดที่ต้องเข้าใจ

- lnwjud ไม่สร้างคำตอบของ AI เองและไม่ใช่ model provider
- AI host ต้องรองรับ MCP หรือมี bridge ที่ทำหน้าที่เป็น MCP client
- local stdio ต้องใช้ direct launcher ที่คุย JSON-RPC บน stdin/stdout
- local HTTP เป็น loopback-only ที่ 127.0.0.1 และตรวจ Host/Origin ไม่ควร port-forward ออกสาธารณะ
- Secure MCP Tunnel ต้องมี tunnel-client, profile, runtime key และ association ที่ถูกต้อง
- เปิด Start Tunnel แล้วไม่ได้แปลว่า ChatGPT connector refresh แล้ว ต้องตรวจ handshake และเรียก tool จริง
- tool catalog ที่โหลดได้ไม่พิสูจน์ว่า workspace path หรือ process ของเครื่องปลายทางพร้อมใช้งาน
- full visibility ทำให้ trusted AI อ่าน environment/metadata ได้ จึงต้องถือว่า AI host ที่เชื่อมอยู่เป็นผู้มีสิทธิ์ระดับสูง
- audit/logs มีการ redaction และ bounded output แต่ไม่ได้ทำให้ข้อมูลที่ AI อ่านถูกทำให้ปลอดภัยโดยอัตโนมัติ
- child MCP servers, skills, shell, browser input, Office, scheduler และ network เป็น capability ที่มี side effect หรือ risk สูง
- Codex discovery ไม่อ่าน credential files และการไม่มี Codex ติดตั้งไม่ใช่เหตุผลให้สร้างผลลัพธ์ปลอม

## แหล่งอ้างอิงใน repository

- [README.md](../README.md) — quick setup, connection modes, tunnel, Live Logs และ troubleshooting
- [ROADMAP_PHASE_STATUS.md](architecture/ROADMAP_PHASE_STATUS.md) — สถานะ Phase 00–40
- [TOOL_CONTRACT.md](architecture/TOOL_CONTRACT.md) — schema, permission class และ compatibility contract
- [UPGRADE_ARCHITECTURE.md](architecture/UPGRADE_ARCHITECTURE.md) — runtime topology และ invariants
- [MCP_TOOL_CATALOG.md](mcp/MCP_TOOL_CATALOG.md) — รายละเอียด narrative ของ core tools
- [PHASE-05.md](benchmarks/PHASE-05.md) — historical runtime benchmark ของ foundation catalog
- [CODEX_INTEGRATION.md](development/CODEX_INTEGRATION.md) — Codex discovery/delegation boundary
- [LOCAL_DESKTOP.md](development/LOCAL_DESKTOP.md) — local HTTP และ desktop workflow
- [PACKAGING_WINDOWS.md](development/PACKAGING_WINDOWS.md) — installer และ packaged runtime
- [mcp-stdio.ts](../apps/cli/src/bin/mcp-stdio.ts) — direct stdio entrypoint
- [http.ts](../packages/mcp-server/src/http.ts) — loopback Streamable HTTP boundary
- [stdio.ts](../packages/mcp-server/src/stdio.ts) — stdio MCP boundary
- [permission-v2.ts](../packages/permissions/src/permission-v2.ts) — read visibility และ Permission v2 decision
- [start-lnwjud-tunnel.ps1](../scripts/start-lnwjud-tunnel.ps1) — tunnel runner, TTL, retry และ log alignment
