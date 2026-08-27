import type { UiLocale } from '@lnwjud/ipc-contracts';

export function unrestrictedSafetyBoundaryCopy(locale: UiLocale): string {
  return locale === 'th'
    ? 'เครื่องมือไฟล์แบบมีโครงสร้างใช้ Active Project แบบ canonical และ Recovery Trash / checkpoint. เมื่อใช้ Full Access งานอ่าน เขียน แก้ แทนที่ รันคำสั่ง และ automation ปกติจะไม่ถามยืนยัน; จะถามเฉพาะการลบ/ทำข้อมูลหาย คำสั่ง destructive ที่ตรวจพบ หรือการออกนอก Active Project แบบชัดเจน และคำสั่งระดับเครื่องอันตรายยังถูกบล็อก. Unrestricted mode ไม่ยกเลิกขอบเขตอันตรายเหล่านี้'
    : 'Structured file tools use canonical Active Project paths and Recovery Trash / checkpoints. Under Full Access, ordinary read/write/edit/replace/execute and automation actions do not prompt; confirmation is reserved for detected deletion/data-loss operations or explicit Active Project escapes, while dangerous machine-level commands remain blocked. Unrestricted mode does not remove these dangerous-operation boundaries.';
}
