import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ipcChannels, type LnwjudApi, type ToolCatalogItem, type ToolCatalogSnapshot, type UserSettings } from '@lnwjud/ipc-contracts';

const electron = vi.hoisted(() => ({
  exposed: undefined as LnwjudApi | undefined,
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: LnwjudApi): void => { electron.exposed = api; },
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

const checkedAt = '2026-08-30T00:00:00.000Z';
const item: ToolCatalogItem = {
  name: 'git', origin: 'lnwjud', category: 'git', title: 'Git', shortDescription: 'Git', longDescription: 'Git',
  declaredPermission: 'EXECUTE', profileDecision: 'ALLOW', riskMode: 'fixed', readiness: 'ready',
  userPreference: 'default', systemEligible: true, effectiveExposed: true, stale: false,
  checkedAt, supportsCancel: false, supportsDryRun: false, requirements: [], remediationIds: [], inputSchema: null, searchText: ['git'],
};

function response(override: Record<string, unknown>): ToolCatalogSnapshot {
  return { generatedAt: checkedAt, locale: 'en', items: [{ ...item, ...override }], remediations: [] };
}

const userSettingsFixture: UserSettings = {
  customPermission: { read: 'ALLOW', write: 'ASK', execute: 'ASK', dangerous: 'DENY', allowedExecutables: [] },
  desktopFullBypassAll: false,
  stdioFullBypassAll: false,
  mcpCallTimeoutMs: 60_000,
  mcpIdleTimeoutMs: 300_000,
  processTimeoutMs: 3_600_000,
  mcpPollWaitSeconds: 5,
  shellSynchronousWaitSeconds: 60,
  capabilityRoots: [],
  pdfProviderPath: '',
  lspCommands: {},
  mcpHttpPort: 18_765,
  codexToolsEnabled: false,
  eccEnabled: false,
  ponytailMode: 'off',
  updateAutoCheck: true,
  updateCheckOnStartup: true,
  updateIntervalMinutes: 30,
  updateAutoDownload: true,
  closeBehavior: 'tray',
  launchAtStartup: false,
  startMinimized: false,
  tunnelAutoReconnect: true,
  tunnelMaxAutoRestarts: 5,
  recoveryRetentionDays: 30,
  extensions: { mode: 'enable_all', disabledServers: [], enabledServers: [], disabledSkillRoots: [], extraSkillRoots: [], extraMcpServers: [] },
};

describe('preload Tool Catalog validation', () => {
  beforeAll(async () => { await import('../src/preload/index.js'); });

  it('preserves ECC opt-in state through the preload settings parser', async () => {
    const enabled = { ...userSettingsFixture, eccEnabled: true };
    electron.invoke.mockResolvedValueOnce({ settings: enabled, restartRequired: false });
    await expect(electron.exposed!.setUserSettings({ settings: enabled })).resolves.toMatchObject({
      settings: { eccEnabled: true },
      restartRequired: false,
    });
    expect(electron.invoke).toHaveBeenLastCalledWith(ipcChannels.setUserSettings, { settings: enabled });
  });

  it('keeps ECC disabled when an older settings response omits eccEnabled', async () => {
    const legacySettings = { ...userSettingsFixture } as Record<string, unknown>;
    delete legacySettings.eccEnabled;
    electron.invoke.mockResolvedValueOnce({ settings: legacySettings, restartRequired: false });
    await expect(electron.exposed!.setUserSettings({ settings: userSettingsFixture })).resolves.toMatchObject({
      settings: { eccEnabled: false },
      restartRequired: false,
    });
  });

  it('preserves valid optional readiness fields from IPC', async () => {
    electron.invoke.mockResolvedValueOnce(response({
      readiness: 'needs_setup', readinessReason: 'runtime_not_ready', deliveryState: 'operational', available: true,
    }));
    await expect(electron.exposed!.getToolCatalog({ locale: 'en' })).resolves.toMatchObject({
      items: [expect.objectContaining({
        readiness: 'needs_setup', readinessReason: 'runtime_not_ready', deliveryState: 'operational', available: true,
      })],
    });
  });

  it('accepts generic diagnostic detail returned by the activity-detail IPC', async () => {
    electron.invoke.mockResolvedValueOnce({ status: 'complete', detail: { kind: 'details', items: ['status=active', 'nested.revision=12'] } });
    await expect(electron.exposed!.resolveActivityTargetDetail({ detailRef: 'call-1:completed' })).resolves.toEqual({
      status: 'complete',
      detail: { kind: 'details', items: ['status=active', 'nested.revision=12'] },
    });
  });

  it('allows the ngrok authtoken setup target through the preload bridge', async () => {
    electron.invoke.mockResolvedValueOnce({ opened: true });
    await expect(electron.exposed!.openExternalSetupPage({ target: 'ngrok_authtoken' })).resolves.toEqual({ opened: true });
    expect(electron.invoke).toHaveBeenLastCalledWith(ipcChannels.openExternalSetupPage, { target: 'ngrok_authtoken' });
  });

  it('accepts the unclean desktop-session incident classification from IPC', async () => {
    electron.invoke.mockResolvedValueOnce({
      exported: true,
      cancelled: false,
      classification: 'desktop_session_ended_uncleanly',
      capturedAt: checkedAt,
    });
    await expect(electron.exposed!.captureIncident()).resolves.toMatchObject({
      exported: true,
      classification: 'desktop_session_ended_uncleanly',
    });
  });

  it.each([
    ['readinessReason', 'invented_reason'],
    ['deliveryState', 'invented_delivery'],
    ['available', 'yes'],
  ] as const)('rejects invalid optional %s values from IPC', async (field, value) => {
    electron.invoke.mockResolvedValueOnce(response({ [field]: value }));
    await expect(electron.exposed!.getToolCatalog({ locale: 'en' })).rejects.toThrow('Invalid IPC response');
  });
});
