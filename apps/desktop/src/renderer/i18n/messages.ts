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
  | 'tunnel.stopped'
  | 'tunnel.starting'
  | 'tunnel.error'
  | 'project.active'
  | 'project.setMain'
  | 'project.add'
  | 'project.addHint'
  | 'info.workspace'
  | 'info.activeProject'
  | 'info.mode'
  | 'workLog.title'
  | 'workLog.filterAll'
  | 'workLog.filterError'
  | 'workLog.clear'
  | 'workLog.empty'
  | 'settings.title'
  | 'settings.locale'
  | 'settings.tunnelKey'
  | 'settings.saveKey'
  | 'settings.clientPath'
  | 'settings.savePath'
  | 'settings.permissions'
  | 'settings.unrestricted'
  | 'settings.unrestrictedHint'
  | 'settings.restartRequired'
  | 'badge.unrestricted'
  | 'live.title'
  | 'live.subtitle'
  | 'live.tabTunnel'
  | 'live.tabMcp'
  | 'live.tabProcess'
  | 'live.pause'
  | 'live.follow'
  | 'live.filter'
  | 'live.export'
  | 'live.waiting'
  | 'live.waitingTunnel'
  | 'live.popOut'
  | 'git.title'
  | 'doctor.title'
  | 'doctor.run'
  | 'capabilities.title'
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
  'mcp.stdioCommand': 'คำสั่ง Secure Tunnel (stdio)',
  'mcp.copy': 'คัดลอก',
  'mcp.copied': 'คัดลอกแล้ว',
  'tunnel.title': 'Secure MCP Tunnel สำหรับ ChatGPT',
  'tunnel.start': 'เริ่ม Tunnel',
  'tunnel.stop': 'หยุด Tunnel',
  'tunnel.needKey': 'บันทึก Runtime API key ครั้งแรกในการตั้งค่า',
  'tunnel.needProfile': 'ยังไม่มีโปรไฟล์ lnwjud.yaml',
  'tunnel.running': 'Tunnel เชื่อมต่อแล้ว (จากแอพนี้)',
  'tunnel.runningExternal': 'Tunnel เชื่อมต่อแล้ว (จากสคริปต์) — ปุ่ม Start ถูกปิดไว้แล้ว',
  'tunnel.stopped': 'Tunnel หยุดอยู่',
  'tunnel.starting': 'กำลังเริ่ม Tunnel',
  'tunnel.error': 'Tunnel มีข้อผิดพลาด',
  'project.active': 'โปรเจกต์ที่ใช้งาน',
  'project.setMain': 'ตั้งเป็นโปรเจกต์หลัก',
  'project.add': 'เพิ่มโปรเจกต์',
  'project.addHint': 'ใส่ path ของโฟลเดอร์โปรเจกต์บนเครื่องนี้',
  'info.workspace': 'Workspace',
  'info.activeProject': 'Active Project',
  'info.mode': 'Mode',
  'workLog.title': 'บันทึกการทำงาน',
  'workLog.filterAll': 'ทั้งหมด',
  'workLog.filterError': 'เฉพาะ error',
  'workLog.clear': 'ล้างประวัติ',
  'workLog.empty': 'ยังไม่มีกิจกรรม',
  'settings.title': 'ตั้งค่า',
  'settings.locale': 'ภาษา',
  'settings.tunnelKey': 'Runtime API key (บันทึกครั้งเดียว)',
  'settings.saveKey': 'บันทึกคีย์',
  'settings.clientPath': 'path ของ tunnel-client.exe',
  'settings.savePath': 'บันทึก path',
  'settings.permissions': 'โปรไฟล์สิทธิ์',
  'settings.unrestricted': 'โหมดเต็มสิทธิ์ (Unrestricted)',
  'settings.unrestrictedHint': 'เปิด: ลงทะเบียนทุกไดร์ฟ (C:, D:, E:), รัน cmd/powershell/npm.cmd ได้, อ่าน secret ได้ทุกที่ — ยังบล็อกคำสั่งลบและ git clean/reset ตามเดิม',
  'settings.restartRequired': 'ต้องรีสตาร์ทแอพเพื่อให้มีผล',
  'badge.unrestricted': 'Unrestricted',
  'live.title': 'Live Logs',
  'live.subtitle': 'ดู log ของ tunnel, กิจกรรม MCP และ process แบบ realtime',
  'live.tabTunnel': 'Tunnel',
  'live.tabMcp': 'MCP activity',
  'live.tabProcess': 'Processes',
  'live.pause': 'หยุดชั่วคราว',
  'live.follow': 'ตามต่อ (follow)',
  'live.filter': 'กรองข้อความ...',
  'live.export': 'ส่งออกไฟล์',
  'live.waiting': 'ยังไม่มีข้อมูล',
  'live.waitingTunnel': 'ยังไม่มีไฟล์ tunnel log — รัน tunnel ด้วยสคริปต์ start-lnwjud-tunnel.ps1 หรือกด Start Tunnel',
  'live.popOut': 'เปิดหน้าต่างแยก',
  'git.title': 'สถานะ Git',
  'doctor.title': 'Doctor',
  'doctor.run': 'รัน Doctor',
  'capabilities.title': 'Capabilities',
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
  'mcp.stdioCommand': 'Secure Tunnel command (stdio)',
  'mcp.copy': 'Copy',
  'mcp.copied': 'Copied',
  'tunnel.title': 'Secure MCP Tunnel for ChatGPT',
  'tunnel.start': 'Start Tunnel',
  'tunnel.stop': 'Stop Tunnel',
  'tunnel.needKey': 'Save a Runtime API key once in Settings',
  'tunnel.needProfile': 'Missing lnwjud.yaml tunnel profile',
  'tunnel.running': 'Tunnel connected (from this app)',
  'tunnel.runningExternal': 'Tunnel connected (from script) — Start is disabled',
  'tunnel.stopped': 'Tunnel stopped',
  'tunnel.starting': 'Starting tunnel',
  'tunnel.error': 'Tunnel error',
  'project.active': 'Active project',
  'project.setMain': 'Set as main project',
  'project.add': 'Add project',
  'project.addHint': 'Enter a local project folder path',
  'info.workspace': 'Workspace',
  'info.activeProject': 'Active Project',
  'info.mode': 'Mode',
  'workLog.title': 'Work Log',
  'workLog.filterAll': 'All',
  'workLog.filterError': 'Errors only',
  'workLog.clear': 'Clear history',
  'workLog.empty': 'No activity yet',
  'settings.title': 'Settings',
  'settings.locale': 'Language',
  'settings.tunnelKey': 'Runtime API key (save once)',
  'settings.saveKey': 'Save key',
  'settings.clientPath': 'tunnel-client.exe path',
  'settings.savePath': 'Save path',
  'settings.permissions': 'Permission profile',
  'settings.unrestricted': 'Unrestricted mode',
  'settings.unrestrictedHint': 'On: registers every drive (C:, D:, E:), allows cmd/powershell/npm.cmd, reads secrets anywhere — delete commands and git clean/reset stay blocked',
  'settings.restartRequired': 'Restart the app to apply',
  'badge.unrestricted': 'Unrestricted',
  'live.title': 'Live Logs',
  'live.subtitle': 'Real-time tunnel, MCP activity, and process logs',
  'live.tabTunnel': 'Tunnel',
  'live.tabMcp': 'MCP activity',
  'live.tabProcess': 'Processes',
  'live.pause': 'Pause',
  'live.follow': 'Follow',
  'live.filter': 'Filter text...',
  'live.export': 'Export file',
  'live.waiting': 'No data yet',
  'live.waitingTunnel': 'No tunnel log file yet — run start-lnwjud-tunnel.ps1 or press Start Tunnel',
  'live.popOut': 'Pop out viewer',
  'git.title': 'Git status',
  'doctor.title': 'Doctor',
  'doctor.run': 'Run doctor',
  'capabilities.title': 'Capabilities',
  'language.th': 'ไทย',
  'language.en': 'English',
};
