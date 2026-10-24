import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ipcChannels, type DashboardSnapshot, type LnwjudApi } from '@lnwjud/ipc-contracts';
import { createDesktopRuntime } from '../src/main/desktop-services.js';

const electron = vi.hoisted(() => ({
  exposed: undefined as LnwjudApi | undefined,
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: LnwjudApi): void => { electron.exposed = api; } },
  ipcRenderer: { invoke: electron.invoke, on: vi.fn(), removeListener: vi.fn() },
}));

type DashboardGate = NonNullable<DashboardSnapshot['engineeringHarnessStatus']['task']>['gates'][number];
const applicabilityCases = {
  required: 'required', optional: 'optional', not_applicable: 'not_applicable', unresolved: 'unresolved',
} satisfies { [Key in DashboardGate['applicability']]: Key };

describe('preload Dashboard engineering gate validation', () => {
  let dataRoot: string;
  let dashboard: DashboardSnapshot;

  beforeAll(async () => {
    await import('../src/preload/index.js');
    dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-dashboard-ipc-'));
    const runtime = createDesktopRuntime(dataRoot);
    try {
      dashboard = await runtime.services.getDashboard();
    } finally {
      await runtime.close();
    }
  }, 60_000);

  afterAll(async () => { await rm(dataRoot, { recursive: true, force: true }); });

  function withGate(applicability: DashboardGate['applicability']): DashboardSnapshot {
    return {
      ...dashboard,
      engineeringHarnessStatus: {
        ...dashboard.engineeringHarnessStatus,
        task: {
          goalId: 'goal', goalKey: 'dashboard-startup', currentPhase: 'verification', nextAction: 'Resolve source identity',
          primaryTaskKind: 'bugfix', riskTier: 'high', deliveryScope: 'release',
          gates: [{ id: 'source_identity', title: 'Source identity', applicability, status: 'blocked', reason: 'SOURCE_IDENTITY_UNRESOLVED' }],
        },
      },
    };
  }

  it.each(Object.values(applicabilityCases))(
    'loads the runtime dashboard with %s applicability', async (applicability) => {
      const response = withGate(applicability);
      electron.invoke.mockResolvedValueOnce(response);
      await expect(electron.exposed!.getDashboard()).resolves.toMatchObject({
        engineeringHarnessStatus: { task: { gates: [{
          id: 'source_identity', applicability, status: 'blocked', reason: 'SOURCE_IDENTITY_UNRESOLVED',
        }] } },
      });
      expect(electron.invoke).toHaveBeenLastCalledWith(ipcChannels.getDashboard);
    },
  );

  it('rejects an unsupported gate applicability instead of treating it as resolved', async () => {
    const response = withGate('unresolved');
    electron.invoke.mockResolvedValueOnce({
      ...response,
      engineeringHarnessStatus: {
        ...response.engineeringHarnessStatus,
        task: { ...response.engineeringHarnessStatus.task, gates: [{ ...response.engineeringHarnessStatus.task!.gates[0], applicability: 'unsupported' }] },
      },
    });
    await expect(electron.exposed!.getDashboard()).rejects.toThrow('Invalid IPC response');
  });
});
