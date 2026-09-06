import type { ToolCatalogItem, UiLocale } from '@lnwjud/ipc-contracts';

export function toolAvailabilityLabel(locale: UiLocale, item: ToolCatalogItem): string {
  if (item.userPreference === 'disabled') {
    if (item.readiness === 'ready') return locale === 'th' ? 'พร้อมใช้งาน แต่ผู้ใช้ปิดไว้' : 'Ready, but disabled by user';
    return locale === 'th' ? 'ผู้ใช้ปิดไว้' : 'Disabled by user';
  }
  if (item.userPreference === 'enabled' && !item.systemEligible) {
    if (item.readinessReason === 'feature_disabled') {
      return locale === 'th' ? 'เปิดรายตัวไว้ แต่ต้องเปิดการตั้งค่าหลักก่อน' : 'Enabled per-tool, but the required Settings gate is off';
    }
    return locale === 'th' ? 'เปิดรายตัวไว้ แต่ระบบยังไม่พร้อมให้เปิดใช้งาน' : 'Enabled per-tool, but the system is not ready to expose it';
  }
  if (item.userPreference === 'enabled') return locale === 'th' ? 'ผู้ใช้เปิดไว้' : 'Enabled by user';
  return item.effectiveExposed
    ? (locale === 'th' ? 'เปิดตามค่าเริ่มต้น' : 'Enabled by default')
    : (locale === 'th' ? 'ปิดตามค่าเริ่มต้น' : 'Disabled by default');
}

export function effectiveExposureLabel(locale: UiLocale, item: ToolCatalogItem): string {
  return item.effectiveExposed
    ? (locale === 'th' ? 'แสดงใน MCP tools/list' : 'Exposed in MCP tools/list')
    : (locale === 'th' ? 'ไม่แสดงใน MCP tools/list' : 'Hidden from MCP tools/list');
}
