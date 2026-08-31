import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

  it('allows file targets inside the canonical Active Project root for office', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lnwjud-native-root-'));
    const report = path.join(root, 'report.xlsx');
    await writeFile(report, 'fixture', 'utf8');
    let called = false;
    const bridge: WindowsCapabilityBridge = {
      execute: async () => { called = true; return ok({ done: true }); },
    };
    const backend = new WindowsNativeCapabilityBackend('office', bridge, 'win32', {
      allowedRootsProvider: async (): Promise<readonly string[]> => [root],
    });

    const result = await backend.execute({ app: 'excel', action: 'read', file_path: report, range: 'A1:B2' });

    expect(result).toMatchObject({ ok: true, value: { done: true } });
    expect(called).toBe(true);
  });

  it.each([
    ['audio', { action: 'record', output_path: 'outside.wav', userConfirmed: true }],
    ['screen_record', { action: 'start', output_path: 'outside.mp4', userConfirmed: true }],
    ['office', { app: 'word', action: 'replace', file_path: 'outside.docx', find: 'old', replace_with: 'new', userConfirmed: true }],
  ] as const)('does not let unrestricted %s bypass the Active Project path boundary', async (capability, template) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lnwjud-native-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'lnwjud-native-outside-'));
    const targetField = capability === 'office' ? 'file_path' : 'output_path';
    const input = { ...template, [targetField]: path.join(outside, String(template[targetField])) };
    if (capability === 'office') await writeFile(String(input.file_path), 'fixture', 'utf8');

    let called = false;
    const bridge: WindowsCapabilityBridge = {
      execute: async () => { called = true; return ok({ done: true }); },
    };
    const backend = new WindowsNativeCapabilityBackend(capability, bridge, 'win32', {
      allowedRootsProvider: async (): Promise<readonly string[]> => [root],
      unrestricted: true,
    });

    await expect(backend.execute(input)).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    expect(called).toBe(false);
  });

  it('accepts an outside path and mutating native action only under trusted Full Bypass authorization', async () => {
    const activeRoot = await mkdtemp(path.join(tmpdir(), 'lnwjud-native-root-'));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'lnwjud-native-outside-'));
    const report = path.join(outsideRoot, 'report.docx');
    await writeFile(report, 'fixture', 'utf8');
    let called = false;
    const bridge: WindowsCapabilityBridge = {
      execute: async () => { called = true; return ok({ done: true }); },
    };
    const backend = new WindowsNativeCapabilityBackend('office', bridge, 'win32', {
      allowedRootsProvider: async (): Promise<readonly string[]> => [activeRoot],
    });
    const authorization = { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' } as const;

    await expect(backend.execute({ app: 'word', action: 'replace', file_path: report }, undefined, authorization))
      .resolves.toMatchObject({ ok: true, value: { done: true } });
    expect(called).toBe(true);
  });

  it.each([
    ['audio', { action: 'record', output_path: 'capture.wav', userConfirmed: true }],
    ['screen_record', { action: 'start', output_path: 'capture.mp4', userConfirmed: true }],
    ['office', { app: 'word', action: 'replace', file_path: 'report.docx', find: 'old', replace_with: 'new', userConfirmed: true }],
  ] as const)('rejects a junction escape for %s before native provider dispatch', async (capability, template) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lnwjud-native-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'lnwjud-native-outside-'));
    const escape = path.join(root, 'escape');
    await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
    const targetField = capability === 'office' ? 'file_path' : 'output_path';
    const input = { ...template, [targetField]: path.join(escape, String(template[targetField])) };
    if (capability === 'office') await writeFile(String(input.file_path), 'fixture', 'utf8');

    let called = false;
    const bridge: WindowsCapabilityBridge = {
      execute: async () => { called = true; return ok({ done: true }); },
    };
    const backend = new WindowsNativeCapabilityBackend(capability, bridge, 'win32', {
      allowedRootsProvider: async (): Promise<readonly string[]> => [root],
      unrestricted: true,
    });

    await expect(backend.execute(input)).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    expect(called).toBe(false);
  });

  it('reports an unavailable backend off Windows', async () => {
    const bridge: WindowsCapabilityBridge = { execute: async () => ok({}) };
    const backend = new WindowsNativeCapabilityBackend('vision', bridge, 'linux');

    await expect(backend.execute({ action: 'capture_display' })).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('blocks Office replacement and raw input without confirmation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lnwjud-native-root-'));
    const report = path.join(root, 'report.docx');
    await writeFile(report, 'fixture', 'utf8');
    let called = false;
    const bridge: WindowsCapabilityBridge = {
      execute: async () => { called = true; return ok({}); },
    };
    const office = new WindowsNativeCapabilityBackend('office', bridge, 'win32', {
      allowedRootsProvider: async (): Promise<readonly string[]> => [root],
      unrestricted: true,
    });
    const input = new WindowsNativeCapabilityBackend('input_event', bridge, 'win32');

    await expect(office.execute({ app: 'word', action: 'replace', file_path: report }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(input.execute({ operation: 'click' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(called).toBe(false);
  });

  it('does not dispatch a native side effect after caller cancellation', async () => {
    let called = false;
    const bridge: WindowsCapabilityBridge = {
      execute: async () => { called = true; return ok({}); },
    };
    const backend = new WindowsNativeCapabilityBackend('input_event', bridge, 'win32');
    const controller = new AbortController();
    controller.abort();

    await expect(backend.execute({ operation: 'click' }, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PROCESS_TIMEOUT' },
    });
    expect(called).toBe(false);
  });
});
