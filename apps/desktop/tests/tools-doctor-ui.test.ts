import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DoctorReport, ResolvedRemediation, ToolCatalogItem } from '@lnwjud/ipc-contracts';
import { formatDateTime } from '../src/renderer/date-time.js';
import { DoctorPanel } from '../src/renderer/features/doctor/DoctorPanel.js';
import { ToolDetailModal } from '../src/renderer/features/tools/ToolDetailModal.js';
import { ToolsPage } from '../src/renderer/features/tools/ToolsPage.js';

const checkedAt = new Date(2026, 7, 29, 18, 35, 13).toISOString();

const remediation: ResolvedRemediation = {
  id: 'configure_lsp',
  title: 'ตั้งค่า Language Server',
  explanation: 'ตั้งค่าคำสั่ง Language Server ภายในเครื่องอย่างน้อยหนึ่งรายการ',
  steps: ['ตั้งค่าคำสั่ง Language Server ภายในเครื่องอย่างน้อยหนึ่งรายการในหน้า Tools แล้วตรวจใหม่'],
  actions: [{ kind: 'open_settings', target: 'tools' }, { kind: 'recheck', requirementIds: ['configured_lsp'] }],
};

const tool: ToolCatalogItem = {
  name: 'db_inspect',
  origin: 'lnwjud',
  category: 'automation',
  title: 'DB Inspect · งานอัตโนมัติ',
  shortDescription: 'Inspect a database.',
  longDescription: 'Inspect a configured read-only database target.',
  declaredPermission: 'READ',
  profileDecision: 'ALLOW',
  riskMode: 'fixed',
  readiness: 'needs_setup',
  userPreference: 'default',
  systemEligible: true,
  effectiveExposed: true,
  stale: false,
  checkedAt,
  supportsCancel: false,
  supportsDryRun: true,
  requirements: [{ id: 'database_target', status: 'warn', required: false, checkedAt, summaryKey: 'requirement.database_target', detail: 'Configure a target first.' }],
  remediationIds: [],
  inputSchema: null,
  searchText: ['db_inspect'],
};

const doctor: DoctorReport = {
  exitCode: 0,
  checks: [{
    id: 'configured_lsp',
    required: false,
    status: 'warn',
    title: 'ตรวจ configured_lsp',
    summary: 'WARN: requirement.configured_lsp',
    detail: 'No local language-server command is configured',
    affectedToolNames: ['lsp_diagnostics', 'lsp_rename'],
    remediationId: 'configure_lsp',
    checkedAt,
    durationMs: 862,
  }],
};

describe('Tools and Doctor UX', () => {
  it('renders readable tool facts without raw ISO timestamps or boolean literals', () => {
    const markup = renderToStaticMarkup(createElement(ToolDetailModal, {
      locale: 'th', item: tool, remediations: [], onClose: () => undefined, onRemediation: () => undefined,
    }));
    expect(markup).toContain(formatDateTime(checkedAt));
    expect(markup).not.toContain(checkedAt);
    expect(markup).toContain('ต้องตั้งค่า');
    expect(markup).toContain('ใช่');
    expect(markup).toContain('ไม่');
    expect(markup).toContain('tool-modal-close');
  });

  it('keeps Doctor remediation content in a dedicated block and preserves millisecond durations', () => {
    const markup = renderToStaticMarkup(createElement(DoctorPanel, {
      locale: 'th', report: doctor, remediations: [remediation],
      onRunDoctor: async () => undefined, onRecheck: async () => undefined, onRemediation: async () => undefined, onOpenProjects: () => undefined,
    }));
    expect(markup).toContain('doctor-remediation-copy');
    expect(markup).toContain('doctor-remediation-actions');
    expect(markup).toContain(formatDateTime(checkedAt));
    expect(markup).not.toContain(checkedAt);
    expect(markup).toContain('862 ms');
  });

  it('renders actionable system/browser remediation labels instead of a generic settings button', () => {
    const browserRemediation: ResolvedRemediation = {
      id: 'configure_browser_cdp',
      title: 'เปิดเบราว์เซอร์ที่ lnwjud จัดการ',
      explanation: 'เปิด Managed Browser',
      steps: ['กดเปิด Managed Browser'],
      actions: [{ kind: 'launch_managed_browser' }],
    };
    const browserTool: ToolCatalogItem = {
      ...tool,
      name: 'browser_debug_context',
      readinessReason: 'runtime_not_ready',
      deliveryState: 'operational',
      available: true,
      remediationIds: ['configure_browser_cdp'],
    };
    const toolMarkup = renderToStaticMarkup(createElement(ToolDetailModal, {
      locale: 'th', item: browserTool, remediations: [browserRemediation], onClose: () => undefined, onRemediation: () => undefined,
    }));
    expect(toolMarkup).toContain('ต้องเปิดใช้งาน');
    expect(toolMarkup).not.toContain('ต้องตั้งค่า');
    expect(toolMarkup).toContain('เปิด Managed Browser');

    const englishMarkup = renderToStaticMarkup(createElement(ToolDetailModal, {
      locale: 'en', item: browserTool, remediations: [{ ...browserRemediation, title: 'Start the lnwjud managed browser' }], onClose: () => undefined, onRemediation: () => undefined,
    }));
    expect(englishMarkup).toContain('Start required');
    expect(englishMarkup).not.toContain('Needs setup');
    expect(englishMarkup).toContain('Start managed browser');

    const sandboxRemediation: ResolvedRemediation = {
      id: 'configure_windows_sandbox',
      title: 'เปิดใช้ Windows Sandbox',
      explanation: 'Windows Sandbox เป็น Optional Feature ของ Windows',
      steps: ['เปิด Turn Windows features on or off'],
      actions: [{ kind: 'open_system_settings', target: 'windows_optional_features' }],
    };
    const sandboxReport: DoctorReport = { exitCode: 0, checks: [{ ...doctor.checks[0]!, id: 'windows_sandbox', title: 'ตรวจ windows_sandbox', remediationId: 'configure_windows_sandbox' }] };
    const doctorMarkup = renderToStaticMarkup(createElement(DoctorPanel, {
      locale: 'th', report: sandboxReport, remediations: [sandboxRemediation], onRunDoctor: async () => undefined, onRemediation: async () => undefined,
    }));
    expect(doctorMarkup).toContain('เปิด Windows Optional Features');
    expect(doctorMarkup).not.toContain('>เปิดการตั้งค่า<');
  });

  it('labels the coarse needs-setup filter as Action required while reserving setup copy for setup_required', () => {
    const setupTool: ToolCatalogItem = { ...tool, readinessReason: 'setup_required', deliveryState: 'dependency_gated', available: false };
    const snapshot = { generatedAt: checkedAt, locale: 'en' as const, items: [setupTool], remediations: [] };
    const english = renderToStaticMarkup(createElement(ToolsPage, {
      locale: 'en', snapshot, loading: false, onRefresh: async () => undefined, onRemediation: async () => undefined,
    }));
    expect(english).toContain('Action required');
    expect(english).toContain('Needs setup');

    const thai = renderToStaticMarkup(createElement(ToolsPage, {
      locale: 'th', snapshot: { ...snapshot, locale: 'th' }, loading: false, onRefresh: async () => undefined, onRemediation: async () => undefined,
    }));
    expect(thai).toContain('ต้องดำเนินการ');
    expect(thai).toContain('ต้องตั้งค่า');
  });

  it('shows the failed composite subrequirement details without claiming Chrome is required', () => {
    const composite: ToolCatalogItem = {
      ...tool,
      name: 'computer_use',
      title: 'Computer Use',
      readinessReason: 'setup_required',
      deliveryState: 'dependency_gated',
      available: false,
      requirements: [
        { id: 'windows_ui_automation', status: 'fail', required: false, checkedAt, summaryKey: 'requirement.windows_ui_automation', detail: 'Windows UI Automation bridge is unavailable.' },
        { id: 'windows_input', status: 'fail', required: false, checkedAt, summaryKey: 'requirement.windows_input', detail: 'Native input permission is unavailable.' },
        { id: 'windows_ocr', status: 'fail', required: false, checkedAt, summaryKey: 'requirement.windows_ocr', detail: 'WinRT OCR package identity is unavailable.' },
      ],
    };
    const markup = renderToStaticMarkup(createElement(ToolDetailModal, {
      locale: 'en', item: composite, remediations: [], onClose: () => undefined, onRemediation: () => undefined,
    }));
    expect(markup).toContain('windows_ui_automation');
    expect(markup).toContain('windows_input');
    expect(markup).toContain('windows_ocr');
    expect(markup).not.toContain('Chrome');
  });

  it('shows an honest fallback when Doctor has an issue with no safe automatic remediation', () => {
    const report: DoctorReport = { exitCode: 0, checks: [{ ...doctor.checks[0]!, remediationId: undefined }] };
    const markup = renderToStaticMarkup(createElement(DoctorPanel, {
      locale: 'th', report, remediations: [], onRunDoctor: async () => undefined,
    }));
    expect(markup).toContain('ไม่มีการตั้งค่าอัตโนมัติที่ปลอดภัย');
    expect(markup).toContain('จะไม่พาไปหน้า Settings ที่ไม่เกี่ยวข้อง');
  });

  it('renders a polished accessible availability switch in both the catalog and detail modal', () => {
    const enabledTool: ToolCatalogItem = { ...tool, userPreference: 'enabled', effectiveExposed: true };
    const snapshot = { generatedAt: checkedAt, locale: 'en' as const, items: [enabledTool], remediations: [] };
    const toolsMarkup = renderToStaticMarkup(createElement(ToolsPage, {
      locale: 'en', snapshot, loading: false, onRefresh: async () => undefined, onRemediation: async () => undefined,
      onSetAvailability: async () => undefined,
    }));
    const modalMarkup = renderToStaticMarkup(createElement(ToolDetailModal, {
      locale: 'en', item: enabledTool, remediations: [], onClose: () => undefined, onRemediation: () => undefined,
      onSetAvailability: async () => undefined,
    }));
    const styles = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(toolsMarkup).toContain('role="switch"');
    expect(toolsMarkup).toContain('aria-checked="true"');
    expect(toolsMarkup).toContain('tool-availability-switch is-on');
    expect(toolsMarkup).toContain('tool-availability-switch-track');
    expect(modalMarkup).toContain('tool-availability-switch is-on');
    expect(styles).toContain('.tool-availability-switch.is-on .tool-availability-switch-track');
    expect(styles).toContain('.tool-availability-switch:focus-visible');
    expect(styles).not.toContain('.tool-card-availability label {');
  });

  it('exposes status filters as pressed-state toggles and keeps selected labels/focus legible', () => {
    const snapshot = { generatedAt: checkedAt, locale: 'en' as const, items: [tool], remediations: [] };
    const markup = renderToStaticMarkup(createElement(ToolsPage, {
      locale: 'en', snapshot, loading: false, onRefresh: async () => undefined, onRemediation: async () => undefined,
    }));
    const styles = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    expect(markup).toContain('aria-pressed="false"');
    expect(styles).toContain('.tool-status-strip button.active span { color: currentColor; }');
    expect(styles).toContain('.tool-status-strip button.active strong { color: currentColor; }');
    expect(styles).toContain('.tool-status-strip button:focus-visible');
  });

  it('keeps Managed Browser remediation responsive and refreshes the selected tool from the latest catalog', () => {
    const modalSource = readFileSync(new URL('../src/renderer/features/tools/ToolDetailModal.tsx', import.meta.url), 'utf8');
    const toolsPageSource = readFileSync(new URL('../src/renderer/features/tools/ToolsPage.tsx', import.meta.url), 'utf8');
    const desktopServicesSource = readFileSync(new URL('../src/main/desktop-services.ts', import.meta.url), 'utf8');
    const remediationSource = readFileSync(new URL('../src/main/tool-catalog/remediation-registry.ts', import.meta.url), 'utf8');
    expect(modalSource).toContain('กำลังเปิด Managed Browser…');
    expect(modalSource).toContain('disabled={busyActionKey !== null}');
    expect(toolsPageSource).toContain('items.find((item) => toolKey(item) === selectedKey)');
    expect(desktopServicesSource).toContain("{ action: 'launch', userConfirmed: true }");
    expect(remediationSource).not.toContain('implementation/build');
    expect(remediationSource).toContain('เวอร์ชันนี้ยังไม่มีส่วนทำงานของเครื่องมือนี้');
  });

  it('renders ChatGPT host-sync guidance as a non-blocking status notice when supplied', () => {
    const snapshot = { generatedAt: checkedAt, locale: 'en' as const, items: [tool], remediations: [] };
    const notice = 'Browser F5 is not guaranteed to refresh the approved action snapshot. Use Action Refresh / Scan Tools.';
    const markup = renderToStaticMarkup(createElement(ToolsPage, {
      locale: 'en', snapshot, loading: false, hostSyncNotice: notice, onRefresh: async () => undefined, onRemediation: async () => undefined,
    }));
    expect(markup).toContain('tool-host-sync-notice');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('F5');
    expect(markup).toContain('Action Refresh / Scan Tools');
  });

  it('anchors the tool modal to document.body and constrains scrolling to the viewport-safe modal body', () => {
    const source = readFileSync(new URL('../src/renderer/features/tools/ToolDetailModal.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    expect(source).toContain("createPortal(modal, document.body)");
    expect(styles).toContain('z-index: 5000');
    expect(styles).toContain('align-items: flex-start');
    expect(styles).toContain('max-height: calc(100dvh - 64px)');
    expect(styles).toContain('.tool-modal-scroll { flex: 1 1 auto;');
  });
});
