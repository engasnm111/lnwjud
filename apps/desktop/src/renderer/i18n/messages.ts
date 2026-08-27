export type MessageKey =
  | 'brand'
  | 'nav.home'
  | 'nav.projects'
  | 'nav.git'
  | 'nav.workLog'
  | 'nav.live'
  | 'nav.settings'
  | 'nav.doctor'
  | 'footer.connected'
  | 'footer.disconnected'
  | 'home.title'
  | 'home.subtitle'
  | 'agent.ready'
  | 'agent.busy'
  | 'agent.stopped'
  | 'agent.mode'
  | 'action.refresh'
  | 'action.stop'
  | 'action.restart'
  | 'action.retry'
  | 'mcp.localUrl'
  | 'mcp.stdioCommand'
  | 'mcp.copy'
  | 'mcp.copied'
  | 'tunnel.title'
  | 'tunnel.start'
  | 'tunnel.stop'
  | 'tunnel.needKey'
  | 'tunnel.needProfile'
  | 'tunnel.running'
  | 'tunnel.runningExternal'
  | 'tunnel.incompleteExternal'
  | 'tunnel.stopped'
  | 'tunnel.starting'
  | 'tunnel.error'
  | 'project.active'
  | 'project.setMain'
  | 'project.add'
  | 'project.addHint'
  | 'project.activeList'
  | 'project.archivedList'
  | 'project.systemList'
  | 'project.archive'
  | 'project.restore'
  | 'project.delete'
  | 'project.confirmDelete'
  | 'project.cancel'
  | 'project.archivedBadge'
  | 'project.systemBadge'
  | 'project.systemHint'
  | 'project.emptyActive'
  | 'project.emptyArchived'
  | 'project.deleteHint'
  | 'info.workspace'
  | 'info.activeProject'
  | 'info.mode'
  | 'workLog.title'
  | 'workLog.filterAll'
  | 'workLog.filterError'
  | 'workLog.clear'
  | 'workLog.empty'
  | 'scope.all'
  | 'scope.workspace'
  | 'scope.session'
  | 'scope.clearSession'
  | 'scope.clearWorkspace'
  | 'scope.clearAll'
  | 'settings.title'
  | 'settings.subtitle'
  | 'settings.generalTitle'
  | 'settings.securityTitle'
  | 'settings.tunnelTitle'
  | 'settings.locale'
  | 'settings.tunnelKey'
  | 'settings.saveKey'
  | 'settings.clientPath'
  | 'settings.savePath'
  | 'settings.permissions'
  | 'settings.unrestricted'
  | 'settings.unrestrictedHint'
  | 'settings.restartRequired'
  | 'settings.saved'
  | 'badge.unrestricted'
  | 'security.title'
  | 'security.summaryBroad'
  | 'security.summaryRestricted'
  | 'security.desktopProfile'
  | 'security.stdioProfile'
  | 'security.strictRoots'
  | 'security.aiDelete'
  | 'security.unrestricted'
  | 'security.workspaceScope'
  | 'security.tunnelAccess'
  | 'security.enabled'
  | 'security.disabled'
  | 'security.registeredWorkspaces'
  | 'security.allowedRoots'
  | 'security.machineRoots'
  | 'security.warningBroad'
  | 'security.strictHint'
  | 'live.title'
  | 'live.subtitle'
  | 'live.tabTunnel'
  | 'live.tabMcp'
  | 'live.tabProcess'
  | 'live.pause'
  | 'live.follow'
  | 'live.filter'
  | 'live.export'
  | 'live.clearTab'
  | 'live.captureIncident'
  | 'live.incident.localToolFailed'
  | 'live.incident.tunnelDisconnected'
  | 'live.incident.remoteTurnStopped'
  | 'live.incident.healthyOrInconclusive'
  | 'live.incident.cancelled'
  | 'live.incident.capturing'
  | 'live.waiting'
  | 'live.waitingTunnel'
  | 'live.popOut'
  | 'git.title'
  | 'git.changed'
  | 'git.staged'
  | 'doctor.title'
  | 'doctor.run'
  | 'doctor.noReport'
  | 'capabilities.title'
  | 'permission.safe'
  | 'permission.balanced'
  | 'permission.full'
  | 'permission.custom'
  | 'app.loading'
  | 'error.logBufferClear'
  | 'error.logExport'
  | 'error.logViewerOpen'
  | 'error.desktopService'
  | 'error.workspaceAdd'
  | 'error.workspaceSelect'
  | 'error.workspaceArchive'
  | 'error.workspaceDelete'
  | 'error.permissionProfileChange'
  | 'error.unrestrictedModeChange'
  | 'error.mcpStop'
  | 'error.mcpRestart'
  | 'error.workLogClear'
  | 'error.tunnelStart'
  | 'error.tunnelStop'
  | 'error.doctorRun'
  | 'guidedTunnel.tipTitle'
  | 'guidedTunnel.tipBody'
  | 'guidedTunnel.privacy'
  | 'guidedTunnel.startSetup'
  | 'guidedTunnel.later'
  | 'guidedTunnel.openGuide'
  | 'guidedTunnel.progress'
  | 'guidedTunnel.stepTunnelTitle'
  | 'guidedTunnel.stepTunnelBody'
  | 'guidedTunnel.openTunnelSettings'
  | 'guidedTunnel.tunnelIdLabel'
  | 'guidedTunnel.tunnelIdHint'
  | 'guidedTunnel.tunnelIdInvalid'
  | 'guidedTunnel.next'
  | 'guidedTunnel.back'
  | 'guidedTunnel.stepKeyTitle'
  | 'guidedTunnel.stepKeyBody'
  | 'guidedTunnel.openApiKeys'
  | 'guidedTunnel.apiKeyLabel'
  | 'guidedTunnel.apiKeyHint'
  | 'guidedTunnel.apiKeyRequired'
  | 'guidedTunnel.saveKey'
  | 'guidedTunnel.keyStored'
  | 'guidedTunnel.stepConfigureTitle'
  | 'guidedTunnel.stepConfigureBody'
  | 'guidedTunnel.configure'
  | 'guidedTunnel.configuring'
  | 'guidedTunnel.configured'
  | 'guidedTunnel.stepStartTitle'
  | 'guidedTunnel.stepStartBody'
  | 'guidedTunnel.startTunnel'
  | 'guidedTunnel.starting'
  | 'guidedTunnel.running'
  | 'guidedTunnel.stepChatGptTitle'
  | 'guidedTunnel.stepChatGptBody'
  | 'guidedTunnel.openChatGptPlugins'
  | 'guidedTunnel.localComplete'
  | 'guidedTunnel.done'
  | 'guidedTunnel.dismissedHint'
  | 'guidedTunnel.linkError'
  | 'guidedTunnel.copyLink'
  | 'guidedTunnel.retry'
  | 'guidedTunnel.externalRuntime'
  | 'guidedTunnel.showApiKey'
  | 'guidedTunnel.hideApiKey'
  | 'guidedTunnel.advanced'
  | 'language.th'
  | 'language.en';

export type Messages = Record<MessageKey, string>;

export const th: Messages = {
  brand: 'lnwjud',
  'nav.home': 'หน้าหลัก',
  'nav.projects': 'โปรเจกต์',
  'nav.git': 'Git',
  'nav.workLog': 'บันทึกการทำงาน',
  'nav.live': 'Live Logs',
  'nav.settings': 'ตั้งค่า',
  'nav.doctor': 'Doctor',
  'footer.connected': 'เชื่อมต่อแล้ว',
  'footer.disconnected': 'ยังไม่เชื่อมต่อ',
  'home.title': 'ศูนย์ควบคุม Agent',
  'home.subtitle': 'ควบคุม MCP gateway และติดตามงานแบบ realtime',
  'agent.ready': 'Agent พร้อมทำงาน',
  'agent.busy': 'Agent กำลังทำงาน',
  'agent.stopped': 'Agent หยุดทำงาน',
  'agent.mode': 'Windows Desktop Agent • WORK mode',
  'action.refresh': 'รีเฟรช',
  'action.stop': 'หยุด',
  'action.restart': 'รีสตาร์ท',
  'action.retry': 'ลองใหม่',
  'mcp.localUrl': 'MCP URL (local)',
  'mcp.stdioCommand': 'คำสั่ง MCP แบบ Local STDIO',
  'mcp.copy': 'คัดลอก',
  'mcp.copied': 'คัดลอกแล้ว',
  'tunnel.title': 'Secure MCP Tunnel สำหรับ ChatGPT',
  'tunnel.start': 'เริ่ม Tunnel',
  'tunnel.stop': 'หยุด Tunnel',
  'tunnel.needKey': 'บันทึก Runtime API key ครั้งแรกในการตั้งค่า',
  'tunnel.needProfile': 'ยังไม่มีโปรไฟล์ lnwjud.yaml',
  'tunnel.running': 'Tunnel เชื่อมต่อแล้ว (จากแอพนี้)',
  'tunnel.runningExternal': 'Tunnel เชื่อมต่อแล้ว (จากสคริปต์) — ปุ่ม Start ถูกปิดไว้แล้ว',
  'tunnel.incompleteExternal': 'พบ Tunnel process ที่ยังทำงานอยู่ แต่การตั้งค่า lnwjud ยังไม่ครบ — กดหยุด Tunnel ก่อนเริ่มตั้งค่าใหม่',
  'tunnel.stopped': 'Tunnel หยุดอยู่',
  'tunnel.starting': 'กำลังเริ่ม Tunnel',
  'tunnel.error': 'Tunnel มีข้อผิดพลาด',
  'guidedTunnel.tipTitle': 'ตั้งค่า ChatGPT ให้ใช้ lnwjud',
  'guidedTunnel.tipBody': 'ทำขั้นตอนนี้เพียงครั้งเดียว lnwjud จะพาไปสร้าง Tunnel ID และ Runtime API key แล้วตั้งค่าให้โดยอัตโนมัติ',
  'guidedTunnel.privacy': 'คีย์จะถูกเข้ารหัสด้วย Windows DPAPI และเก็บในเครื่องนี้เท่านั้น lnwjud ไม่มีเซิร์ฟเวอร์กลางรับคีย์ของคุณ',
  'guidedTunnel.startSetup': 'เริ่มตั้งค่า',
  'guidedTunnel.later': 'ไว้ทีหลัง',
  'guidedTunnel.openGuide': 'เปิดคู่มือตั้งค่า',
  'guidedTunnel.progress': 'ขั้นตอนการเชื่อมต่อ',
  'guidedTunnel.stepTunnelTitle': '1. สร้าง OpenAI Tunnel',
  'guidedTunnel.stepTunnelBody': 'เปิดหน้า Tunnel Settings เลือกองค์กรที่ใช้กับ ChatGPT สร้าง tunnel และคัดลอกค่าที่ขึ้นต้นด้วย tunnel_ หากสร้างไม่ได้ ให้ตรวจว่าบัญชีมี Tunnels Read + Manage',
  'guidedTunnel.openTunnelSettings': 'เปิดหน้า Tunnel Settings',
  'guidedTunnel.tunnelIdLabel': 'Tunnel ID',
  'guidedTunnel.tunnelIdHint': 'วาง Tunnel ID ที่คัดลอกจาก OpenAI Platform',
  'guidedTunnel.tunnelIdInvalid': 'Tunnel ID ต้องขึ้นต้นด้วย tunnel_ และมีรูปแบบถูกต้อง',
  'guidedTunnel.next': 'ขั้นตอนถัดไป',
  'guidedTunnel.back': 'ย้อนกลับ',
  'guidedTunnel.stepKeyTitle': '2. สร้าง Runtime API key',
  'guidedTunnel.stepKeyBody': 'เปิดหน้า API Keys สร้าง secret key ใหม่ กำหนดสิทธิ์ Tunnels Read + Use แล้วคัดลอกทันที',
  'guidedTunnel.openApiKeys': 'เปิดหน้าสร้าง API key',
  'guidedTunnel.apiKeyLabel': 'Runtime API key',
  'guidedTunnel.apiKeyHint': 'คีย์จะแสดงเต็มเพียงครั้งเดียว วางแล้วกดบันทึก',
  'guidedTunnel.apiKeyRequired': 'กรุณาวาง Runtime API key',
  'guidedTunnel.saveKey': 'บันทึกคีย์อย่างปลอดภัย',
  'guidedTunnel.keyStored': 'บันทึกคีย์ใน Windows DPAPI แล้ว',
  'guidedTunnel.stepConfigureTitle': '3. ให้ lnwjud ตั้งค่าอัตโนมัติ',
  'guidedTunnel.stepConfigureBody': 'lnwjud จะใช้ tunnel-client ที่มากับโปรแกรม สร้างโปรไฟล์ local และตรวจสอบการเชื่อมต่อให้',
  'guidedTunnel.configure': 'ตั้งค่าและตรวจสอบ',
  'guidedTunnel.configuring': 'กำลังสร้างโปรไฟล์และตรวจสอบ…',
  'guidedTunnel.configured': 'โปรไฟล์ Tunnel พร้อมใช้งาน',
  'guidedTunnel.stepStartTitle': '4. เริ่ม Tunnel',
  'guidedTunnel.stepStartBody': 'ตรวจสอบข้อมูลด้านล่าง แล้วกด Start Tunnel เมื่อสถานะเป็น Running โปรแกรมจะ reconnect Tunnel ID เดิมให้อัตโนมัติ',
  'guidedTunnel.startTunnel': 'Start Tunnel',
  'guidedTunnel.starting': 'กำลังเริ่ม Tunnel…',
  'guidedTunnel.running': 'Tunnel กำลังทำงาน',
  'guidedTunnel.stepChatGptTitle': '5. เชื่อมต่อใน ChatGPT',
  'guidedTunnel.stepChatGptBody': 'เปิด ChatGPT Plugins หากยังไม่เปิด Developer mode ให้ไปที่ Settings > Security and login > Developer mode จากนั้นกดเพิ่ม connection เลือก Tunnel แล้วเลือกหรือวาง Tunnel ID นี้',
  'guidedTunnel.openChatGptPlugins': 'เปิด ChatGPT Plugins',
  'guidedTunnel.localComplete': 'การตั้งค่าฝั่งเครื่องเสร็จแล้ว',
  'guidedTunnel.done': 'เสร็จสิ้น',
  'guidedTunnel.dismissedHint': 'ยังไม่ได้ตั้งค่า Tunnel คุณเปิดคู่มือได้ทุกเมื่อ',
  'guidedTunnel.linkError': 'เปิดลิงก์ไม่ได้ กรุณาคัดลอกลิงก์ด้านล่างไปเปิดในเบราว์เซอร์',
  'guidedTunnel.copyLink': 'คัดลอกลิงก์',
  'guidedTunnel.retry': 'ลองอีกครั้ง',
  'guidedTunnel.externalRuntime': 'พบ Tunnel ที่กำลังรันจากภายนอก แต่ยังไม่ใช่ Tunnel ที่ lnwjud Desktop เป็นเจ้าของ ให้หยุด Tunnel เดิมก่อน แล้วกด Start Tunnel อีกครั้ง',
  'guidedTunnel.showApiKey': 'แสดง',
  'guidedTunnel.hideApiKey': 'ซ่อน',
  'guidedTunnel.advanced': 'การตั้งค่าขั้นสูงและแก้ปัญหา',
  'project.active': 'โปรเจกต์ที่ใช้งาน',
  'project.setMain': 'ตั้งเป็นโปรเจกต์หลัก',
  'project.add': 'เพิ่มโปรเจกต์',
  'project.addHint': 'ใส่ path ของโฟลเดอร์โปรเจกต์บนเครื่องนี้',
  'project.activeList': 'โปรเจกต์ที่ใช้งานอยู่',
  'project.archivedList': 'โปรเจกต์ที่เก็บถาวร',
  'project.systemList': 'System Workspaces',
  'project.archive': 'เก็บถาวร',
  'project.restore': 'นำกลับมาใช้งาน',
  'project.delete': 'ลบรายการ',
  'project.confirmDelete': 'ยืนยันลบรายการ',
  'project.cancel': 'ยกเลิก',
  'project.archivedBadge': 'เก็บถาวร',
  'project.systemBadge': 'ระบบ',
  'project.systemHint': 'Workspace นี้ lnwjud จัดการอัตโนมัติ จึงไม่สามารถเก็บถาวรหรือลบได้',
  'project.emptyActive': 'ยังไม่มีโปรเจกต์ที่ใช้งานอยู่',
  'project.emptyArchived': 'ยังไม่มีโปรเจกต์ที่เก็บถาวร',
  'project.deleteHint': 'ลบเฉพาะรายการออกจาก lnwjud เท่านั้น — โฟลเดอร์ ไฟล์ และ Git ของโปรเจกต์จะไม่ถูกลบ',
  'info.workspace': 'Workspace',
  'info.activeProject': 'Active Project',
  'info.mode': 'Mode',
  'workLog.title': 'บันทึกการทำงาน',
  'workLog.filterAll': 'ทั้งหมด',
  'workLog.filterError': 'เฉพาะ error',
  'workLog.clear': 'ล้างประวัติ',
  'workLog.empty': 'ยังไม่มีกิจกรรม',
  'scope.all': 'ทั้งหมด',
  'scope.workspace': 'Workspace',
  'scope.session': 'Session',
  'scope.clearSession': 'ล้าง Session นี้',
  'scope.clearWorkspace': 'ล้าง Workspace นี้',
  'scope.clearAll': 'ล้างทั้งหมด',
  'settings.title': 'ตั้งค่า',
  'settings.subtitle': 'ปรับแต่งภาษา สิทธิ์ความปลอดภัย และการเชื่อมต่อ Remote Tunnel สำหรับ AI Agent',
  'settings.generalTitle': 'ภาษาและการตั้งค่าทั่วไป',
  'settings.securityTitle': 'โปรไฟล์สิทธิ์ความปลอดภัย',
  'settings.tunnelTitle': 'OpenAI Secure MCP Tunnel สำหรับ ChatGPT',
  'settings.locale': 'ภาษา',
  'settings.tunnelKey': 'Runtime API key (บันทึกครั้งเดียว)',
  'settings.saveKey': 'บันทึกคีย์',
  'settings.clientPath': 'path ของ tunnel-client.exe',
  'settings.savePath': 'บันทึก path',
  'settings.permissions': 'โปรไฟล์สิทธิ์',
  'settings.unrestricted': 'โหมดเต็มสิทธิ์ (Unrestricted)',
  'settings.unrestrictedHint': 'ค่าเริ่มต้นเปิด: ลงทะเบียนทุกไดร์ฟ (C:, D:, E:), รัน cmd/powershell ได้, อ่านทุกไฟล์, รัน git ได้ทุกคำสั่ง — คำสั่งลบไฟล์ทั่วไปต้องถามก่อน',
  'settings.restartRequired': 'ต้องรีสตาร์ทแอพเพื่อให้มีผล',
  'settings.saved': 'บันทึกเรียบร้อย',
  'badge.unrestricted': 'Unrestricted',
  'security.title': 'ภาพรวมความปลอดภัย',
  'security.summaryBroad': 'การเข้าถึงกว้าง',
  'security.summaryRestricted': 'จำกัดขอบเขตแล้ว',
  'security.desktopProfile': 'Desktop Profile',
  'security.stdioProfile': 'Standalone STDIO Profile',
  'security.strictRoots': 'Strict Roots',
  'security.aiDelete': 'AI File Delete',
  'security.unrestricted': 'Unrestricted',
  'security.workspaceScope': 'ขอบเขต Workspace',
  'security.tunnelAccess': 'Tunnel',
  'security.enabled': 'เปิด',
  'security.disabled': 'ปิด',
  'security.registeredWorkspaces': 'workspace ที่ลงทะเบียน',
  'security.allowedRoots': 'Allowed Roots',
  'security.machineRoots': 'Machine roots / workspace ที่ลงทะเบียน',
  'security.warningBroad': 'Standalone/headless STDIO ใช้ Full โดยปิด Strict Roots อยู่ จึงอาจมองเห็น machine roots ที่ระบบลงทะเบียนไว้ ควรเปิด Strict Roots เมื่อต้องการจำกัดเฉพาะโฟลเดอร์ที่เลือก',
  'security.strictHint': 'Strict Roots จำกัด standalone/headless STDIO และไม่ใช่ OS sandbox; Secure Tunnel ใช้ Active Project ของ Desktop',
  'live.title': 'Live Logs',
  'live.subtitle': 'ดู log ของ tunnel, กิจกรรม MCP และ process แบบ realtime',
  'live.tabTunnel': 'Tunnel',
  'live.tabMcp': 'MCP activity',
  'live.tabProcess': 'Processes',
  'live.pause': 'หยุดชั่วคราว',
  'live.follow': 'ตามต่อ (follow)',
  'live.filter': 'กรองข้อความ...',
  'live.export': 'ส่งออกไฟล์',
  'live.clearTab': 'ล้าง Tab นี้',
  'live.captureIncident': 'บันทึกหลักฐานปัญหา',
  'live.incident.localToolFailed': 'เครื่องมือในเครื่องล้มเหลว',
  'live.incident.tunnelDisconnected': 'Tunnel หลุดการเชื่อมต่อ',
  'live.incident.remoteTurnStopped': 'Remote turn หยุดทำงาน',
  'live.incident.healthyOrInconclusive': 'ปกติหรือหลักฐานยังไม่ชัดเจน',
  'live.incident.cancelled': 'ยกเลิกการบันทึกหลักฐานแล้ว',
  'live.incident.capturing': 'กำลังบันทึกหลักฐานปัญหา…',
  'live.waiting': 'ยังไม่มีข้อมูล',
  'live.waitingTunnel': 'ยังไม่มีไฟล์ tunnel log — รัน tunnel ด้วยสคริปต์ start-lnwjud-tunnel.ps1 หรือกด Start Tunnel',
  'live.popOut': 'เปิดหน้าต่างแยก',
  'git.title': 'สถานะ Git',
  'git.changed': 'ไฟล์ที่แก้ไข',
  'git.staged': 'ไฟล์ที่ stage แล้ว',
  'doctor.title': 'Doctor',
  'doctor.run': 'รัน Doctor',
  'doctor.noReport': 'ยังไม่มีผลการตรวจสอบ',
  'capabilities.title': 'Capabilities',
  'permission.safe': 'Safe (ปลอดภัย)',
  'permission.balanced': 'Balanced (สมดุล)',
  'permission.full': 'Full (เต็มสิทธิ์)',
  'permission.custom': 'Custom (กำหนดเอง)',
  'app.loading': 'กำลังโหลด…',
  'error.logBufferClear': 'ไม่สามารถล้าง log buffer ได้',
  'error.logExport': 'การส่งออก log ล้มเหลว',
  'error.logViewerOpen': 'ไม่สามารถเปิดหน้าต่างดู log ได้',
  'error.desktopService': 'การเชื่อมต่อเซอร์วิส Desktop ล้มเหลว',
  'error.workspaceAdd': 'ไม่สามารถเพิ่ม workspace ได้',
  'error.workspaceSelect': 'ไม่สามารถเลือก workspace ได้',
  'error.workspaceArchive': 'ไม่สามารถเปลี่ยนสถานะเก็บถาวรของ workspace ได้',
  'error.workspaceDelete': 'ไม่สามารถลบรายการ workspace ได้',
  'error.permissionProfileChange': 'ไม่สามารถเปลี่ยนโปรไฟล์สิทธิ์ได้',
  'error.unrestrictedModeChange': 'ไม่สามารถเปลี่ยนโหมดเต็มสิทธิ์ได้',
  'error.mcpStop': 'ไม่สามารถหยุด MCP ได้',
  'error.mcpRestart': 'ไม่สามารถรีสตาร์ท MCP ได้',
  'error.workLogClear': 'ไม่สามารถล้างประวัติการทำงานได้',
  'error.tunnelStart': 'ไม่สามารถเริ่ม Tunnel ได้',
  'error.tunnelStop': 'ไม่สามารถหยุด Tunnel ได้',
  'error.doctorRun': 'ไม่สามารถรัน Doctor ได้',
  'language.th': 'ไทย',
  'language.en': 'English',
};

export const en: Messages = {
  brand: 'lnwjud',
  'nav.home': 'Home',
  'nav.projects': 'Projects',
  'nav.git': 'Git',
  'nav.workLog': 'Work Log',
  'nav.live': 'Live Logs',
  'nav.settings': 'Settings',
  'nav.doctor': 'Doctor',
  'footer.connected': 'Connected',
  'footer.disconnected': 'Disconnected',
  'home.title': 'Agent Control Center',
  'home.subtitle': 'Control the MCP gateway and monitor work in realtime',
  'agent.ready': 'Agent ready',
  'agent.busy': 'Agent busy',
  'agent.stopped': 'Agent stopped',
  'agent.mode': 'Windows Desktop Agent • WORK mode',
  'action.refresh': 'Refresh',
  'action.stop': 'Stop',
  'action.restart': 'Restart',
  'action.retry': 'Retry',
  'mcp.localUrl': 'MCP URL (local)',
  'mcp.stdioCommand': 'Local STDIO MCP command',
  'mcp.copy': 'Copy',
  'mcp.copied': 'Copied',
  'tunnel.title': 'Secure MCP Tunnel for ChatGPT',
  'tunnel.start': 'Start Tunnel',
  'tunnel.stop': 'Stop Tunnel',
  'tunnel.needKey': 'Save a Runtime API key once in Settings',
  'tunnel.needProfile': 'Missing lnwjud.yaml tunnel profile',
  'tunnel.running': 'Tunnel connected (from this app)',
  'tunnel.runningExternal': 'Tunnel connected (from script) — Start is disabled',
  'tunnel.incompleteExternal': 'A tunnel process is still running, but lnwjud setup is incomplete. Stop the tunnel before starting setup again.',
  'tunnel.stopped': 'Tunnel stopped',
  'tunnel.starting': 'Starting tunnel',
  'tunnel.error': 'Tunnel error',
  'guidedTunnel.tipTitle': 'Connect ChatGPT to lnwjud',
  'guidedTunnel.tipBody': 'Complete this once. lnwjud will guide you through creating a Tunnel ID and Runtime API key, then configure the connection automatically.',
  'guidedTunnel.privacy': 'Your key is encrypted with Windows DPAPI and stored only on this PC. lnwjud has no central server that receives your key.',
  'guidedTunnel.startSetup': 'Start setup',
  'guidedTunnel.later': 'Set up later',
  'guidedTunnel.openGuide': 'Open setup guide',
  'guidedTunnel.progress': 'Connection setup',
  'guidedTunnel.stepTunnelTitle': '1. Create an OpenAI Tunnel',
  'guidedTunnel.stepTunnelBody': 'Open Tunnel Settings, select the organization used with ChatGPT, create a tunnel, and copy the value beginning with tunnel_. If creation is unavailable, verify that the account has Tunnels Read + Manage.',
  'guidedTunnel.openTunnelSettings': 'Open Tunnel Settings',
  'guidedTunnel.tunnelIdLabel': 'Tunnel ID',
  'guidedTunnel.tunnelIdHint': 'Paste the Tunnel ID copied from OpenAI Platform.',
  'guidedTunnel.tunnelIdInvalid': 'The Tunnel ID must begin with tunnel_ and use a valid format.',
  'guidedTunnel.next': 'Continue',
  'guidedTunnel.back': 'Back',
  'guidedTunnel.stepKeyTitle': '2. Create a Runtime API key',
  'guidedTunnel.stepKeyBody': 'Open API Keys, create a new secret key, grant it Tunnels Read + Use, and copy it immediately.',
  'guidedTunnel.openApiKeys': 'Open API Keys',
  'guidedTunnel.apiKeyLabel': 'Runtime API key',
  'guidedTunnel.apiKeyHint': 'The full key is shown once. Paste it here, then save it.',
  'guidedTunnel.apiKeyRequired': 'Paste a Runtime API key.',
  'guidedTunnel.saveKey': 'Save key securely',
  'guidedTunnel.keyStored': 'Key saved with Windows DPAPI.',
  'guidedTunnel.stepConfigureTitle': '3. Let lnwjud configure the connection',
  'guidedTunnel.stepConfigureBody': 'lnwjud will use the bundled tunnel-client, create the local profile, and check the connection.',
  'guidedTunnel.configure': 'Configure and check',
  'guidedTunnel.configuring': 'Creating the profile and checking it…',
  'guidedTunnel.configured': 'Tunnel profile is ready.',
  'guidedTunnel.stepStartTitle': '4. Start the Tunnel',
  'guidedTunnel.stepStartBody': 'Review the details below, then select Start Tunnel. Once it is Running, the app will reconnect the same Tunnel ID automatically.',
  'guidedTunnel.startTunnel': 'Start Tunnel',
  'guidedTunnel.starting': 'Starting Tunnel…',
  'guidedTunnel.running': 'Tunnel is running',
  'guidedTunnel.stepChatGptTitle': '5. Connect in ChatGPT',
  'guidedTunnel.stepChatGptBody': 'Open ChatGPT Plugins. If Developer mode is off, go to Settings > Security and login > Developer mode. Add a connection, choose Tunnel, then select or paste this Tunnel ID.',
  'guidedTunnel.openChatGptPlugins': 'Open ChatGPT Plugins',
  'guidedTunnel.localComplete': 'Local setup is complete.',
  'guidedTunnel.done': 'Done',
  'guidedTunnel.dismissedHint': 'Tunnel is not configured yet. You can reopen the guide at any time.',
  'guidedTunnel.linkError': 'Could not open the link. Copy the address below into your browser.',
  'guidedTunnel.copyLink': 'Copy link',
  'guidedTunnel.retry': 'Try again',
  'guidedTunnel.externalRuntime': 'A tunnel is running externally, but lnwjud Desktop does not own it yet. Stop the existing tunnel, then select Start Tunnel again.',
  'guidedTunnel.showApiKey': 'Show',
  'guidedTunnel.hideApiKey': 'Hide',
  'guidedTunnel.advanced': 'Advanced settings and troubleshooting',
  'project.active': 'Active project',
  'project.setMain': 'Set as main project',
  'project.add': 'Add project',
  'project.addHint': 'Enter a local project folder path',
  'project.activeList': 'Active projects',
  'project.archivedList': 'Archived projects',
  'project.systemList': 'System workspaces',
  'project.archive': 'Archive',
  'project.restore': 'Restore',
  'project.delete': 'Remove',
  'project.confirmDelete': 'Confirm remove',
  'project.cancel': 'Cancel',
  'project.archivedBadge': 'Archived',
  'project.systemBadge': 'System',
  'project.systemHint': 'This workspace is managed automatically by lnwjud and cannot be archived or removed.',
  'project.emptyActive': 'No active projects yet.',
  'project.emptyArchived': 'No archived projects.',
  'project.deleteHint': 'Removes only the lnwjud registration — the project folder, files, and Git repository are not deleted.',
  'info.workspace': 'Workspace',
  'info.activeProject': 'Active Project',
  'info.mode': 'Mode',
  'workLog.title': 'Work Log',
  'workLog.filterAll': 'All',
  'workLog.filterError': 'Errors only',
  'workLog.clear': 'Clear history',
  'workLog.empty': 'No activity yet',
  'scope.all': 'All',
  'scope.workspace': 'Workspace',
  'scope.session': 'Session',
  'scope.clearSession': 'Clear this session',
  'scope.clearWorkspace': 'Clear this workspace',
  'scope.clearAll': 'Clear all',
  'settings.title': 'Settings',
  'settings.subtitle': 'Configure system preferences, security profiles, and remote tunnel connections',
  'settings.generalTitle': 'Language & General Preferences',
  'settings.securityTitle': 'Security & Permission Profiles',
  'settings.tunnelTitle': 'OpenAI Secure MCP Tunnel for ChatGPT',
  'settings.locale': 'Language',
  'settings.tunnelKey': 'Runtime API key (save once)',
  'settings.saveKey': 'Save key',
  'settings.clientPath': 'tunnel-client.exe path',
  'settings.savePath': 'Save path',
  'settings.permissions': 'Permission profile',
  'settings.unrestricted': 'Unrestricted mode',
  'settings.unrestrictedHint': 'Default on: registers every drive (C:, D:, E:), allows cmd/powershell, reads any file, and runs every git command — filesystem deletes must be confirmed',
  'settings.restartRequired': 'Restart the app to apply',
  'settings.saved': 'Saved successfully',
  'badge.unrestricted': 'Unrestricted',
  'security.title': 'Security Overview',
  'security.summaryBroad': 'Broad access',
  'security.summaryRestricted': 'Restricted scope',
  'security.desktopProfile': 'Desktop Profile',
  'security.stdioProfile': 'Standalone STDIO Profile',
  'security.strictRoots': 'Strict Roots',
  'security.aiDelete': 'AI File Delete',
  'security.unrestricted': 'Unrestricted',
  'security.workspaceScope': 'Workspace Scope',
  'security.tunnelAccess': 'Tunnel',
  'security.enabled': 'On',
  'security.disabled': 'Off',
  'security.registeredWorkspaces': 'registered workspaces',
  'security.allowedRoots': 'Allowed Roots',
  'security.machineRoots': 'Machine roots / registered workspaces',
  'security.warningBroad': 'Standalone/headless STDIO is using Full with Strict Roots off, so registered machine roots may be visible. Enable Strict Roots to limit access to selected folders.',
  'security.strictHint': 'Strict Roots scopes standalone/headless STDIO and is not an OS sandbox; Secure Tunnel uses the Desktop Active Project.',
  'live.title': 'Live Logs',
  'live.subtitle': 'Real-time tunnel, MCP activity, and process logs',
  'live.tabTunnel': 'Tunnel',
  'live.tabMcp': 'MCP activity',
  'live.tabProcess': 'Processes',
  'live.pause': 'Pause',
  'live.follow': 'Follow',
  'live.filter': 'Filter text...',
  'live.export': 'Export file',
  'live.clearTab': 'Clear tab',
  'live.captureIncident': 'Capture incident evidence',
  'live.incident.localToolFailed': 'Local tool failed',
  'live.incident.tunnelDisconnected': 'Tunnel disconnected',
  'live.incident.remoteTurnStopped': 'Remote turn stopped',
  'live.incident.healthyOrInconclusive': 'Healthy or inconclusive',
  'live.incident.cancelled': 'Incident capture cancelled',
  'live.incident.capturing': 'Capturing incident evidence…',
  'live.waiting': 'No data yet',
  'live.waitingTunnel': 'No tunnel log file yet — run start-lnwjud-tunnel.ps1 or press Start Tunnel',
  'live.popOut': 'Pop out viewer',
  'git.title': 'Git status',
  'git.changed': 'changed',
  'git.staged': 'staged',
  'doctor.title': 'Doctor',
  'doctor.run': 'Run doctor',
  'doctor.noReport': 'No report yet.',
  'capabilities.title': 'Capabilities',
  'permission.safe': 'Safe',
  'permission.balanced': 'Balanced',
  'permission.full': 'Full',
  'permission.custom': 'Custom',
  'app.loading': 'Loading…',
  'error.logBufferClear': 'Log buffer could not be cleared',
  'error.logExport': 'Log export failed',
  'error.logViewerOpen': 'Log viewer could not be opened',
  'error.desktopService': 'Desktop service request failed',
  'error.workspaceAdd': 'Workspace could not be added',
  'error.workspaceSelect': 'Workspace could not be selected',
  'error.workspaceArchive': 'Workspace archive state could not be changed',
  'error.workspaceDelete': 'Workspace registration could not be removed',
  'error.permissionProfileChange': 'Permission profile could not be changed',
  'error.unrestrictedModeChange': 'Unrestricted mode could not be changed',
  'error.mcpStop': 'MCP could not be stopped',
  'error.mcpRestart': 'MCP could not be restarted',
  'error.workLogClear': 'Work log could not be cleared',
  'error.tunnelStart': 'Tunnel could not be started',
  'error.tunnelStop': 'Tunnel could not be stopped',
  'error.doctorRun': 'Doctor could not run',
  'language.th': 'ไทย',
  'language.en': 'English',
};
