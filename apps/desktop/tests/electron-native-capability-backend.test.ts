import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY } from '@lnwjud/capabilities';
import { ElectronNativeCapabilityBackend, type ElectronNativeCapabilityApi } from '../src/main/electron-native-capability-backend.js';

const approved = { mode: 'standard', applicationApproved: true, bypassApplicationAuthorization: false, source: 'host_approval' } as const;

describe('Electron native capability backend', () => {
  it('returns bounded system metadata even in headless mode', async (): Promise<void> => {
    const backend = new ElectronNativeCapabilityBackend('system_info', { platform: 'darwin', api: { hasWindow: (): boolean => false } });
    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({ ok: true, value: { available: true, ready: true, backend: 'electron-native' } });
    await expect(backend.execute({ action: 'summary' })).resolves.toMatchObject({ ok: true, value: { platform: 'darwin', arch: process.arch, backend: 'electron-native' } });
  });

  it('requires explicit authorization before notification or clipboard writes', async (): Promise<void> => {
    let shown = 0;
    let written = '';
    const api: ElectronNativeCapabilityApi = { showNotification: () => { shown += 1; }, writeClipboardText: (value) => { written = value; }, readClipboardText: () => '' };
    const notification = new ElectronNativeCapabilityBackend('notification', { api });
    const clipboard = new ElectronNativeCapabilityBackend('clipboard', { api });
    await expect(notification.execute({ action: 'show', body: 'hello' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(clipboard.execute({ action: 'set_text', text: 'secret' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(notification.execute({ action: 'show', body: 'hello' }, undefined, approved)).resolves.toMatchObject({ ok: true, value: { shown: true } });
    await expect(clipboard.execute({ action: 'set_text', text: 'safe' }, undefined, approved)).resolves.toMatchObject({ ok: true, value: { written: true } });
    expect(shown).toBe(1);
    expect(written).toBe('safe');
  });

  it('does not open a native dialog after cancellation and scopes selected paths', async (): Promise<void> => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-electron-native-'));
    try {
      const selected = path.join(root, 'chosen.txt');
      await writeFile(selected, 'ok', 'utf8');
      let calls = 0;
      const api: ElectronNativeCapabilityApi = {
        hasWindow: () => true,
        showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => { calls += 1; return { canceled: false, filePaths: [selected] }; },
        showSaveDialog: async () => ({ canceled: true, filePaths: [] }),
      };
      const backend = new ElectronNativeCapabilityBackend('file_dialog', { api, allowedRootsProvider: async (): Promise<string[]> => [root] });
      const aborted = new AbortController();
      aborted.abort();
      await expect(backend.execute({ action: 'open' }, aborted.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
      expect(calls).toBe(0);
      await expect(backend.execute({ action: 'open', metadata: { [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: root } })).resolves.toMatchObject({ ok: true, value: { canceled: false, paths: [selected] } });
      await expect(backend.execute({ action: 'open', metadata: { [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: path.dirname(root) } })).resolves.toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('supports bounded clipboard image round trips', async (): Promise<void> => {
    let value: string | null = null;
    const api: ElectronNativeCapabilityApi = {
      readClipboardImageBase64: () => value,
      writeClipboardImageBase64: (next) => { value = next; },
    };
    const backend = new ElectronNativeCapabilityBackend('clipboard', { api });
    await expect(backend.execute({ action: 'set_image', data_base64: 'aGVsbG8=' }, undefined, approved)).resolves.toMatchObject({ ok: true, value: { written: true, bytes: 5 } });
    await expect(backend.execute({ action: 'get_image' })).resolves.toMatchObject({ ok: true, value: { format: 'png', data_base64: 'aGVsbG8=', empty: false } });
  });
});
