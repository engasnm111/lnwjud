import type { UiLocale } from '@lnwjud/ipc-contracts';
import { catalogDefinitions, catalogSourceDescriptions } from './catalog-definitions.js';

const CATEGORY_LABELS: Readonly<Record<string, Readonly<Record<UiLocale, string>>>> = Object.freeze({
  workspace: { en: 'Workspace', th: 'พื้นที่ทำงาน' },
  files: { en: 'Files', th: 'ไฟล์' },
  search_context: { en: 'Search & Context', th: 'ค้นหาและบริบท' },
  git: { en: 'Git', th: 'Git' },
  process: { en: 'Processes & Development', th: 'โปรเซสและงานพัฒนา' },
  browser_desktop: { en: 'Browser & Desktop', th: 'เบราว์เซอร์และเดสก์ท็อป' },
  system: { en: 'System', th: 'ระบบ' },
  office_media: { en: 'Office & Media', th: 'Office และสื่อ' },
  automation: { en: 'Automation', th: 'งานอัตโนมัติ' },
  agent_goals: { en: 'Agent & Goals', th: 'เอเจนต์และเป้าหมาย' },
  extensions: { en: 'Extensions', th: 'ส่วนขยาย' },
});

export function resolveCatalogCopy(locale: UiLocale, key: string): string {
  const match = /^tool\.([A-Za-z0-9_]+)\.(title|short|long)$/.exec(key);
  if (match === null) return '';
  const name = match[1];
  const field = match[2];
  if (name === undefined || field === undefined) return '';
  const definition = catalogDefinitions[name];
  if (definition === undefined) return '';
  const description = catalogSourceDescriptions[name]?.trim() ?? '';
  const title = humanizeToolName(name);
  const category = CATEGORY_LABELS[definition.category]?.[locale] ?? definition.category;

  if (field === 'title') return locale === 'th' ? `${title} · ${category}` : title;
  if (field === 'short') {
    return locale === 'th'
      ? `ใช้ ${title} เพื่อ${thaiToolPurpose(name, definition.category)}`
      : description || `${title} tool.`;
  }
  return locale === 'th'
    ? `เครื่องมือ ${title} ใช้เพื่อ${thaiToolPurpose(name, definition.category)}ในหมวด ${category} ความพร้อมจริงยังขึ้นกับ dependency, input และสิทธิ์ของโปรไฟล์ปัจจุบัน`
    : `${description || `${title} follows the lnwjud runtime contract.`} Category: ${category}. Availability still depends on runtime readiness, requirements, and the active permission profile.`;
}

const THAI_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  read: 'อ่าน', write: 'เขียน', search: 'ค้นหา', find: 'ค้นหา', list: 'แสดงรายการ', get: 'อ่าน', set: 'ตั้งค่า',
  start: 'เริ่ม', stop: 'หยุด', run: 'รัน', inspect: 'ตรวจสอบ', compare: 'เปรียบเทียบ', capture: 'เก็บสถานะ',
  debug: 'วิเคราะห์', review: 'ตรวจทาน', restore: 'กู้คืน', delete: 'ลบ', move: 'ย้าย', copy: 'คัดลอก', create: 'สร้าง',
  cancel: 'ยกเลิก', prepare: 'เตรียม', record: 'บันทึก', claim: 'รับช่วง', finish: 'ปิดงาน', check: 'ตรวจสอบ',
});
const THAI_OBJECTS: Readonly<Record<string, string>> = Object.freeze({
  file: 'ไฟล์', files: 'หลายไฟล์', workspace: 'พื้นที่โปรเจกต์', project: 'โปรเจกต์', git: 'Git', process: 'โปรเซส',
  context: 'บริบท', symbol: 'สัญลักษณ์โค้ด', references: 'จุดอ้างอิง', definition: 'ตำแหน่งประกาศ', tests: 'เทสต์', test: 'เทสต์',
  browser: 'เบราว์เซอร์', ui: 'หน้าจอ', window: 'หน้าต่าง', screen: 'หน้าจอ', screenshot: 'ภาพหน้าจอ', network: 'เครือข่าย',
  console: 'คอนโซล', office: 'Office', pdf: 'PDF', workbook: 'สมุดงาน Excel', database: 'ฐานข้อมูล', db: 'ฐานข้อมูล',
  lsp: 'Language Server', sandbox: 'Windows Sandbox', tool: 'เครื่องมือ', tools: 'เครื่องมือ', skill: 'สกิล', skills: 'สกิล',
  mcp: 'MCP', task: 'งาน', goal: 'เป้าหมาย', session: 'เซสชัน', cache: 'แคช', hook: 'ฮุก', runtime: 'runtime', status: 'สถานะ',
});

function thaiToolPurpose(name: string, category: string): string {
  const parts = name.split('_').filter(Boolean);
  const action = THAI_ACTIONS[parts[0] ?? ''] ?? 'ทำงานกับ';
  const translated = parts.slice(1).map((part) => THAI_OBJECTS[part] ?? part).join(' ');
  if (translated.length > 0) return `${action}${translated.startsWith(' ') ? '' : ' '}${translated} `;
  const categoryLabel = CATEGORY_LABELS[category]?.th ?? category;
  return `${action}งานในหมวด ${categoryLabel} `;
}

function humanizeToolName(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
