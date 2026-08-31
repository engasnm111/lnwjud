import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DoctorReport, ResolvedRemediation, ToolCatalogItem } from '@lnwjud/ipc-contracts';
import { formatDateTime } from '../src/renderer/date-time.js';
import { DoctorPanel } from '../src/renderer/features/doctor/DoctorPanel.js';
import { ToolDetailModal } from '../src/renderer/features/tools/ToolDetailModal.js';

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
    const browserTool: ToolCatalogItem = { ...tool, name: 'browser_debug_context', remediationIds: ['configure_browser_cdp'] };
    const toolMarkup = renderToStaticMarkup(createElement(ToolDetailModal, {
      locale: 'th', item: browserTool, remediations: [browserRemediation], onClose: () => undefined, onRemediation: () => undefined,
    }));
    expect(toolMarkup).toContain('เปิด Managed Browser');

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

  it('shows an honest fallback when Doctor has an issue with no safe automatic remediation', () => {
    const report: DoctorReport = { exitCode: 0, checks: [{ ...doctor.checks[0]!, remediationId: undefined }] };
    const markup = renderToStaticMarkup(createElement(DoctorPanel, {
      locale: 'th', report, remediations: [], onRunDoctor: async () => undefined,
    }));
    expect(markup).toContain('ไม่มีการตั้งค่าอัตโนมัติที่ปลอดภัย');
    expect(markup).toContain('จะไม่พาไปหน้า Settings ที่ไม่เกี่ยวข้อง');
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
