import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { WindowsNativeCapabilityBackend, type WindowsCapabilityBridge } from './windows-native-backend.js';

describe('WindowsNativeCapabilityBackend', () => {
  it('forwards a native capability request to the local bridge', async () => {
    const requests: unknown[] = [];
    const bridge: WindowsCapabilityBridge = {
      execute: async (request) => { requests.push(request); return ok({ ready: true }); },
    };
    const backend = new WindowsNativeCapabilityBackend('window', bridge, 'win32');

    const result = await backend.execute({ operation: 'list' });

    expect(result).toMatchObject({ ok: true, value: { ready: true } });
    expect(requests).toEqual([{ capability: 'window', input: { operation: 'list' } }]);
  });

  it('returns a dry-run description without sending native input', async () => {
    let called = false;
    const bridge: WindowsCapabilityBridge = {
      execute: async () => { called = true; return ok({}); },
    };
    const backend = new WindowsNativeCapabilityBackend('input_event', bridge, 'win32');

    const result = await backend.execute({ operation: 'click', dry_run: true });

    expect(result).toMatchObject({ ok: true, value: { dry_run: true, capability: 'input_event' } });
    expect(called).toBe(false);
  });

  it('rejects file targets outside configured roots for audio', async () => {
    let called = false;
    const bridge: WindowsCapabilityBridge = {
      execute: async () => { called = true; return ok({}); },
    };
    const backend = new WindowsNativeCapabilityBackend('audio', bridge, 'win32', {
      allowedRootsProvider: async (): Promise<readonly string[]> => ['C:\\Users\\Test\\AppData\\Local\\Temp\\lnwjud-audio'],
    });

    const result = await backend.execute({ action: 'record', output_path: 'C:\\Windows\\Temp\\out.wav' });

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    expect(called).toBe(false);
  });

  it('allows file targets inside configured roots for office', async () => {
    let called = false;
    const bridge: WindowsCapabilityBridge = {
      execute: async () => { called = true; return ok({ done: true }); },
    };
    const backend = new WindowsNativeCapabilityBackend('office', bridge, 'win32', {
      allowedRootsProvider: async (): Promise<readonly string[]> => ['E:\\work'],
    });

    const result = await backend.execute({ app: 'excel', action: 'read', file_path: 'E:\\work\\report.xlsx', range: 'A1:B2' });

    expect(result).toMatchObject({ ok: true, value: { done: true } });
    expect(called).toBe(true);
  });

  it('skips path checks in unrestricted mode', async () => {
    let called = false;
    const bridge: WindowsCapabilityBridge = {
      execute: async () => { called = true; return ok({ done: true }); },
    };
    const backend = new WindowsNativeCapabilityBackend('screen_record', bridge, 'win32', {
      allowedRootsProvider: async (): Promise<readonly string[]> => ['E:\\work'],
      unrestricted: true,
    });

    const result = await backend.execute({ action: 'start', output_path: 'D:\\recordings\\capture.mp4' });

    expect(result).toMatchObject({ ok: true, value: { done: true } });
    expect(called).toBe(true);
  });

  it('reports an unavailable backend off Windows', async () => {
    const bridge: WindowsCapabilityBridge = { execute: async () => ok({}) };
    const backend = new WindowsNativeCapabilityBackend('vision', bridge, 'linux');

    await expect(backend.execute({ action: 'capture_display' })).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });
});
