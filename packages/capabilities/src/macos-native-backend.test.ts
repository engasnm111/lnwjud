import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MacosNativeCapabilityBackend } from './macos-native-backend.js';
import type { NativeHostProcessBridge } from './native-host-protocol.js';

function bridgeFor(calls: string[]): NativeHostProcessBridge {
  return { execute: async (operation: string): Promise<{ ok: true; value: { available: boolean; ready: boolean; operation: string } }> => { calls.push(operation); return { ok: true, value: { available: true, ready: true, operation } }; } } as unknown as NativeHostProcessBridge;
}

describe('MacosNativeCapabilityBackend', () => {
  it('reports a missing native host without manufacturing readiness', async () => {
    const result = await new MacosNativeCapabilityBackend('accessibility').execute({ action: 'status' });
    expect(result).toMatchObject({ ok: true, value: { available: false, ready: false, reason: 'native_host_missing', backend: 'darwin-native-host' } });
  });

  it('requires authorization for input mutations and forwards health probes', async () => {
    const calls: string[] = [];
    const backend = new MacosNativeCapabilityBackend('input_event', { bridge: bridgeFor(calls) });
    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({ ok: true, value: { available: true, ready: false, readinessReason: 'provider_not_implemented' } });
    await expect(backend.execute({ action: 'click', x: 1, y: 2 })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(backend.execute({ action: 'click', x: 1, y: 2, userConfirmed: true })).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual(['health', 'input_event']);
  });

  it('keeps path-bearing media operations inside the active project', async (): Promise<void> => {
    // Keep both temporary roots on the checkout's drive so Node can express
    // them as relative slash paths even when this deterministic macOS-profile
    // test is executed on Windows.
    const root = await mkdtemp(path.join(process.cwd(), '.lnwjud-macos-native-'));
    const outside = await mkdtemp(path.join(process.cwd(), '.lnwjud-macos-native-outside-'));
    try {
      await mkdir(path.join(root, 'media'));
      await writeFile(path.join(root, 'media', 'in.wav'), 'fixture');
      // Keep the fixture portable when this profile test runs on Windows:
      // relative slash paths exercise the same canonical-root check without
      // making the host's drive syntax look like a foreign macOS path.
      const portable = (value: string): string => value.replaceAll('\\', '/');
      const rootInput = portable(path.relative(process.cwd(), root));
      const insideInput = portable(path.relative(process.cwd(), path.join(root, 'media', 'in.wav')));
      const outsideInput = portable(path.relative(process.cwd(), path.join(outside, 'out.wav')));
      const portableBackend = new MacosNativeCapabilityBackend('audio', { bridge: bridgeFor([]), allowedRootsProvider: async (): Promise<string[]> => [rootInput] });
      await expect(portableBackend.execute({ action: 'play', file_path: insideInput, userConfirmed: true })).resolves.toMatchObject({ ok: true });
      await expect(portableBackend.execute({ action: 'play', file_path: outsideInput, userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects unknown actions before dispatching to the native helper', async (): Promise<void> => {
    const calls: string[] = [];
    const backend = new MacosNativeCapabilityBackend('window', { bridge: bridgeFor(calls) });
    await expect(backend.execute({ action: 'run_arbitrary_code' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(calls).toEqual([]);
  });

  it('rejects foreign Windows paths instead of resolving them as POSIX relatives', async (): Promise<void> => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-macos-native-foreign-'));
    try {
      const backend = new MacosNativeCapabilityBackend('audio', { bridge: bridgeFor([]), allowedRootsProvider: async (): Promise<string[]> => [root] });
      await expect(backend.execute({ action: 'play', file_path: 'C:\\Users\\alice\\recording.wav', userConfirmed: true })).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
