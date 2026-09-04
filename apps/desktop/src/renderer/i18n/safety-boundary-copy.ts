import type { UiLocale } from '@lnwjud/ipc-contracts';

export function unrestrictedSafetyBoundaryCopy(locale: UiLocale): string {
  return locale === 'th'
    ? 'เครื่องมือไฟล์แบบมีโครงสร้างใช้ Active Project แบบ canonical และ Recovery Trash / checkpoint. ระบบไม่สแกนหรือลงทะเบียน drive letter อัตโนมัติ แต่ Unrestricted อนุญาต absolute path ที่ระบุชัดเจน. เมื่อ Full Bypass ปิด งานปกติของ Full Access จะไม่ถาม แต่ tool ที่ต้องยืนยันเสมอ งานลบ/ทำข้อมูลหาย คำสั่งอันตราย และการออกนอกขอบเขตยังใช้ policy เดิม; เมื่อเปิด Full Bypass จะข้ามการอนุมัติและขอบเขตระดับแอป แต่ถ้ามี rolling scheduled goal ที่ active อยู่ ระบบยังบังคับ current goal lease เพื่อกัน worker เก่าชน worker ใหม่ โดยข้อจำกัดจริงของ Windows/บริการภายนอกยังมีผล'
    : 'Structured file tools use canonical Active Project paths and Recovery Trash / checkpoints. Drives are never scanned or registered automatically, while Unrestricted allows explicitly requested absolute paths. With Full Bypass OFF, ordinary Full Access work does not prompt while always-confirm, destructive, and out-of-scope operations keep their normal policy. With Full Bypass ON, lnwjud application approvals and scope checks are skipped, but an active rolling scheduled goal still requires the current goal lease so a stale worker cannot mutate after handoff; Windows and external-service boundaries still apply.';
}
