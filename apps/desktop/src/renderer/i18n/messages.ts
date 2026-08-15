export type MessageKey =
  | 'brand'
  | 'nav.home'
  | 'nav.projects'
  | 'nav.git'
  | 'nav.workLog'
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
  'tunnel.running': 'Tunnel เชื่อมต่อแล้ว',
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
  'tunnel.running': 'Tunnel connected',
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
  'git.title': 'Git status',
  'doctor.title': 'Doctor',
  'doctor.run': 'Run doctor',
  'capabilities.title': 'Capabilities',
  'language.th': 'ไทย',
  'language.en': 'English',
};
