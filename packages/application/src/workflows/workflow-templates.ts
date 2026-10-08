import type { WorkflowTemplate } from '@lnwjud/domain';
const field = (key: string, labelTh: string, labelEn: string, type: 'path' | 'text' | 'enum' | 'mapping_file', required = true, options?: readonly string[]): WorkflowTemplate['inputFields'][number] =>
  ({ key, labelTh, labelEn, type, required, ...(options === undefined ? {} : { options }) });
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: 'project-check', revision: 1, titleTh: 'ตรวจสอบโปรเจกต์', titleEn: 'Project Check',
    descriptionTh: 'ตรวจสถานะโปรเจกต์และผลตรวจจริง', descriptionEn: 'Inspect project stack and verified checks.',
    category: 'coding', inputFields: [field('projectPath','โฟลเดอร์โปรเจกต์','Project folder','path'), field('focus','หัวข้อ','Focus','enum',true,['general','build','tests'])],
    outputKinds: ['report','diagnostics'], requiredCapabilities: [], readOnly: true, estimatedEffort: 'small',
  },
  {
    id: 'code-review', revision: 1, titleTh: 'รีวิวโค้ด', titleEn: 'Code Review',
    descriptionTh: 'ตรวจความเสี่ยงจาก diff โดยไม่แก้ไฟล์', descriptionEn: 'Review scoped diff without editing files.',
    category: 'coding', inputFields: [field('repoPath','โฟลเดอร์โค้ด','Repository','path'), field('baseRef','ฐานเปรียบเทียบ','Base ref','text')],
    outputKinds: ['report'], requiredCapabilities: [], readOnly: true, estimatedEffort: 'medium',
  },
  {
    id: 'release-readiness', revision: 1, titleTh: 'ตรวจความพร้อมรีลีส', titleEn: 'Release Readiness',
    descriptionTh: 'ตรวจหลักฐานก่อนเผยแพร่ ไม่เผยแพร่เอง', descriptionEn: 'Check release evidence; never publish automatically.',
    category: 'coding', inputFields: [field('repoPath','โปรเจกต์','Repository','path'), field('targetVersion','เวอร์ชันเป้าหมาย','Target version','text')],
    outputKinds: ['report','diagnostics'], requiredCapabilities: [], readOnly: true, estimatedEffort: 'large',
  },
  {
    id: 'connection-check', revision: 1, titleTh: 'ตรวจการเชื่อมต่อ', titleEn: 'Connection Check',
    descriptionTh: 'วินิจฉัยการเชื่อมต่อโดยไม่รีสตาร์ทบริการ', descriptionEn: 'Diagnose connection without restarting shared services.',
    category: 'diagnostics', inputFields: [field('connection','การเชื่อมต่อ','Connection','text')],
    outputKinds: ['diagnostics'], requiredCapabilities: [], readOnly: true, estimatedEffort: 'small',
  },
  {
    id: 'data-audit', revision: 1, titleTh: 'ตรวจข้อมูล Excel/CSV', titleEn: 'Data Audit',
    descriptionTh: 'ตรวจค่าว่างและข้อมูลซ้ำ โดยไม่เปลี่ยนต้นฉบับ', descriptionEn: 'Inspect missing and duplicate values without changing input.',
    category: 'office', inputFields: [field('inputPath','ไฟล์ข้อมูล','Data file','path'), field('sheet','แผ่นงาน','Sheet','text',false), field('range','ช่วงข้อมูล','Range','text',false), field('keyColumns','คอลัมน์คีย์','Key columns','text')],
    outputKinds: ['report'], requiredCapabilities: ['office-data-file-provider'], readOnly: true, estimatedEffort: 'medium',
  },
  {
    id: 'template-report', revision: 1, titleTh: 'สร้างรายงานจากต้นแบบ', titleEn: 'Template Report',
    descriptionTh: 'สร้างไฟล์ใหม่โดยคงต้นฉบับและตรวจผลลัพธ์', descriptionEn: 'Create a new verified report without modifying source files.',
    category: 'office', inputFields: [field('inputPath','ไฟล์ข้อมูล','Data file','path'), field('templatePath','ไฟล์ต้นแบบ','Reference workbook','path'), field('mappingPath','ไฟล์แมป','Mapping JSON','mapping_file'), field('outputPath','ไฟล์ปลายทางใหม่','New output file','path')],
    outputKinds: ['file','report'], requiredCapabilities: ['office-data-file-provider'], readOnly: false, estimatedEffort: 'large',
  },
] as const;
