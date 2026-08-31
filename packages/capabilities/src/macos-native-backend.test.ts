import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MacosNativeCapabilityBackend } from './macos-native-backend.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

function activeRootMetadata(root: string): Record<string, unknown> {
  return { metadata: { 'lnwjud.activeWorkspaceRoot.v1': root } };
}

describe('MacosNativeCapabilityBackend path authorization', () => {
  it('allows a target inside a configured root when no active root metadata is present', async () => {
    const root = await temporaryDirectory('lnwjud-mac-roots-');
    const target = path.join(root, 'report.docx');
    await writeFile(target, 'fixture', 'utf8');
    const backend = new MacosNativeCapabilityBackend('office', 'darwin', { allowedRootsProvider: async (): Promise<readonly string[]> => [root] });

    const result = await backend.execute({ file_path: target, userConfirmed: true });

    expect(result).toMatchObject({ ok: true, value: { available: false, reason: expect.stringContaining('not available on macOS') } });
  });

  it('narrows to the active root when it lies inside the configured roots', async () => {
    const firstRoot = await temporaryDirectory('lnwjud-mac-first-');
    const secondRoot = await temporaryDirectory('lnwjud-mac-second-');
    const target = path.join(secondRoot, 'sheet.xlsx');
    await writeFile(target, 'fixture', 'utf8');
    const backend = new MacosNativeCapabilityBackend('office', 'darwin', { allowedRootsProvider: async (): Promise<readonly string[]> => [firstRoot, secondRoot] });

    const result = await backend.execute({ file_path: target, userConfirmed: true, ...activeRootMetadata(secondRoot) });

    expect(result).toMatchObject({ ok: true, value: { available: false } });
  });

  it('fails closed when the active root is outside every configured root', async () => {
    const configuredRoot = await temporaryDirectory('lnwjud-mac-configured-');
    const strangerRoot = await temporaryDirectory('lnwjud-mac-stranger-');
    const backend = new MacosNativeCapabilityBackend('office', 'darwin', { allowedRootsProvider: async (): Promise<readonly string[]> => [configuredRoot] });

    const result = await backend.execute({ file_path: path.join(strangerRoot, 'escape.docx'), userConfirmed: true, ...activeRootMetadata(strangerRoot) });

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('fails closed when the active root is valid but the target is inside another configured root', async () => {
    const firstRoot = await temporaryDirectory('lnwjud-mac-first-');
    const secondRoot = await temporaryDirectory('lnwjud-mac-second-');
    const backend = new MacosNativeCapabilityBackend('office', 'darwin', { allowedRootsProvider: async (): Promise<readonly string[]> => [firstRoot, secondRoot] });

    const result = await backend.execute({ file_path: path.join(secondRoot, 'other.xlsx'), userConfirmed: true, ...activeRootMetadata(firstRoot) });

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('resolves a symlinked active root back into the configured roots', async () => {
    const realRoot = await temporaryDirectory('lnwjud-mac-real-');
    const aliasRoot = await temporaryDirectory('lnwjud-mac-alias-');
    await rm(aliasRoot, { recursive: true, force: true });
    await symlink(realRoot, aliasRoot, 'dir');
    const realTarget = path.join(realRoot, 'via-alias.docx');
    await writeFile(realTarget, 'fixture', 'utf8');
    const backend = new MacosNativeCapabilityBackend('office', 'darwin', { allowedRootsProvider: async (): Promise<readonly string[]> => [realRoot] });

    const result = await backend.execute({ file_path: path.join(aliasRoot, 'via-alias.docx'), userConfirmed: true, ...activeRootMetadata(aliasRoot) });

    expect(result).toMatchObject({ ok: true, value: { available: false } });
  });

  it('fails closed when the allowed roots provider throws', async () => {
    const root = await temporaryDirectory('lnwjud-mac-provider-');
    const backend = new MacosNativeCapabilityBackend('office', 'darwin', {
      allowedRootsProvider: async (): Promise<readonly string[]> => { throw new Error('workspace service unavailable'); },
    });

    const result = await backend.execute({ file_path: path.join(root, 'report.docx'), userConfirmed: true });

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('fails closed when no allowed roots provider is configured', async () => {
    const root = await temporaryDirectory('lnwjud-mac-noprovider-');
    const backend = new MacosNativeCapabilityBackend('office', 'darwin');

    const result = await backend.execute({ file_path: path.join(root, 'report.docx'), userConfirmed: true });

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('skips configured roots that do not exist', async () => {
    const root = await temporaryDirectory('lnwjud-mac-live-');
    const target = path.join(root, 'report.docx');
    await writeFile(target, 'fixture', 'utf8');
    const backend = new MacosNativeCapabilityBackend('office', 'darwin', {
      allowedRootsProvider: async (): Promise<readonly string[]> => [path.join(root, 'missing'), root],
    });

    const result = await backend.execute({ file_path: target, userConfirmed: true });

    expect(result).toMatchObject({ ok: true, value: { available: false } });
  });

  it('rejects path operations on non-darwin platforms', async () => {
    const backend = new MacosNativeCapabilityBackend('office', 'linux', { allowedRootsProvider: async (): Promise<readonly string[]> => ['/tmp'] });

    await expect(backend.execute({ file_path: '/tmp/x.docx', userConfirmed: true })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' },
    });
  });
});

describe.skipIf(process.platform !== 'darwin')('MacosNativeCapabilityBackend screen recording state', () => {
  const stateDirectory = path.join(os.tmpdir(), `lnwjud-screen-record-${process.getuid?.() ?? 0}`);
  const statePath = path.join(stateDirectory, 'state.json');

  afterEach(async () => {
    await rm(statePath, { force: true }).catch(() => undefined);
  });

  it('reports an idle status and keeps state in a user-scoped 0700 directory', async () => {
    await rm(statePath, { force: true }).catch(() => undefined);
    const backend = new MacosNativeCapabilityBackend('screen_record', 'darwin');

    const result = await backend.execute({ action: 'status' });

    expect(result).toMatchObject({ ok: true, value: { recording: false } });
    const stats = await stat(stateDirectory);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('refuses to signal a pid that no longer belongs to screencapture on stop', async () => {
    // A forged or stale state file pointing at this test process: the stop
    // action must verify the pid's command before signalling, so the runner
    // survives and the state is still cleaned up.
    await writeFile(statePath, JSON.stringify({ pid: process.pid, outputPath: '/tmp/lnwjud-fake-recording.mov' }), 'utf8');
    const backend = new MacosNativeCapabilityBackend('screen_record', 'darwin');

    const result = await backend.execute({ action: 'stop', userConfirmed: true });

    expect(result).toMatchObject({ ok: true, value: { recording: false, output_path: '/tmp/lnwjud-fake-recording.mov' } });
    expect(processAliveForTest(process.pid)).toBe(true);
    await expect(stat(statePath)).rejects.toThrow();
  });
});

function processAliveForTest(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
