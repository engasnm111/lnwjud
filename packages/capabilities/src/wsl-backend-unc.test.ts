import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import { WslCapabilityBackend, WslFilesystemCapabilityBackend } from './wsl-backend.js';

const filesystem = vi.hoisted(() => ({
  canonical: new Map<string, string>(), reads: [] as string[], stats: [] as string[], files: new Set<string>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  realpath: async (value: string): Promise<string> => {
    filesystem.reads.push(value);
    return filesystem.canonical.get(value) ?? value;
  },
  stat: async (value: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number; mtime: Date }> => {
    filesystem.stats.push(value);
    return {
      isDirectory: (): boolean => !filesystem.files.has(value),
      isFile: (): boolean => filesystem.files.has(value), size: 0, mtime: new Date(0),
    };
  },
}));

afterEach(() => {
  filesystem.canonical.clear(); filesystem.reads.length = 0; filesystem.stats.length = 0; filesystem.files.clear();
});

const root = '\\\\wsl.localhost\\Ubuntu\\home\\example\\Project';
const bypass: InvocationAuthorization = {
  mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass',
};

function fixture(allowedRoots = [root]): {
  backend: WslCapabilityBackend;
  filesystemBackend: WslFilesystemCapabilityBackend;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const backend = new WslCapabilityBackend({
    platform: 'win32', allowedRoots,
    runner: { execute: async (input): Promise<Result<unknown>> => { calls.push(input); return ok({}); } },
  });
  const filesystemBackend = new WslFilesystemCapabilityBackend({ platform: 'win32', allowedRoots });
  return { backend, filesystemBackend, calls };
}

describe('WSL UNC address contracts with simulated host filesystem', () => {
  it.each(['wsl.localhost', 'wsl$', 'WSL.LOCALHOST'])('uses %s consistently for translation, preview and execution', async (authority) => {
    const { backend, filesystemBackend, calls } = fixture();
    const cwd = `\\\\${authority}\\Ubuntu\\home\\example\\Project\\src`;
    const request = { workspaceId: 'ws', distro: 'Ubuntu', executable: 'pwd', cwd };
    await expect(backend.execute({ ...request, dry_run: true })).resolves.toMatchObject({
      ok: true, value: { linux_cwd: '/home/example/Project/src' },
    });
    expect(calls).toEqual([]);
    await expect(backend.execute(request)).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual([expect.objectContaining({
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\example\\Project\\src',
      arguments: ['--distribution', 'Ubuntu', '--cd', '/home/example/Project/src', '--exec', 'pwd'],
    })]);
    await expect(filesystemBackend.execute({
      workspaceId: 'ws', distro: 'Ubuntu', direction: 'windows_to_wsl', path: cwd,
    })).resolves.toMatchObject({ ok: true, value: { path: '/home/example/Project/src', raw_access: false } });
  });

  it.each([
    ['wrong distro', root, 'Debian'],
    ['default distro', root, 'default'],
    ['generic UNC', '\\\\server\\share\\Project', 'Ubuntu'],
    ['device UNC', '\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\example\\Project', 'Ubuntu'],
    ['device drive', '\\\\?\\C:\\workspace', 'Ubuntu'],
    ['parent segment', `${root}\\src\\..\\target`, 'Ubuntu'],
    ['drive parent segment', 'C:\\workspace\\src\\..\\target', 'Ubuntu'],
    ['forward-slash parent', '//wsl$/Ubuntu/home/example/Project/../Project', 'Ubuntu'],
    ['missing distribution', '\\\\wsl.localhost\\', 'Ubuntu'],
    ['dot distribution', '\\\\wsl.localhost\\.\\home', '.'],
  ])('rejects %s before normalization, including Full Bypass', async (_label, cwd, distro) => {
    const { backend, filesystemBackend, calls } = fixture();
    for (const authorization of [undefined, bypass]) {
      for (const dry_run of [true, false]) {
        await expect(backend.execute({ workspaceId: 'ws', distro, executable: 'pwd', cwd, dry_run }, undefined, authorization))
          .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      }
      await expect(filesystemBackend.execute({ workspaceId: 'ws', distro, direction: 'windows_to_wsl', path: cwd }, undefined, authorization))
        .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(calls).toEqual([]);
    expect(filesystem.reads).toEqual([]);
  });

  it('preserves Linux case in containment but keeps Windows drive case behavior', async () => {
    const { backend, filesystemBackend, calls } = fixture();
    const cwd = root.replace('Project', 'project');
    await expect(backend.execute({ workspaceId: 'ws', distro: 'Ubuntu', executable: 'pwd', cwd }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    await expect(filesystemBackend.execute({ workspaceId: 'ws', distro: 'Ubuntu', direction: 'windows_to_wsl', path: cwd }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    expect(calls).toEqual([]);
    const drive = fixture(['C:\\Workspace']);
    await expect(drive.backend.execute({ workspaceId: 'ws', executable: 'pwd', cwd: 'c:\\workspace\\src', dry_run: true }))
      .resolves.toMatchObject({ ok: true, value: { linux_cwd: '/mnt/c/workspace/src' } });
  });

  it('uses dynamic roots and an alias canonicalized by the host without losing Linux case', async () => {
    const canonicalRoot = '\\\\wsl$\\Ubuntu\\home\\example\\Project';
    filesystem.canonical.set(root, canonicalRoot);
    filesystem.canonical.set(`${root}\\src`, `${canonicalRoot}\\src`);
    const backend = new WslCapabilityBackend({
      platform: 'win32', allowedRoots: ['C:\\unused'], allowedRootsProvider: async (): Promise<readonly string[]> => [root],
      runner: { execute: async (): Promise<Result<unknown>> => ok({}) },
    });
    await expect(backend.execute({
      workspaceId: 'ws', distro: 'Ubuntu', executable: 'pwd', cwd: 'src',
      metadata: { 'lnwjud.activeWorkspaceRoot.v1': root }, dry_run: true,
    })).resolves.toMatchObject({ ok: true, value: { linux_cwd: '/home/example/Project/src' } });
  });

  it('rejects adjacent directory prefixes and default distro for native Linux paths', async () => {
    const { backend, filesystemBackend, calls } = fixture();
    await expect(backend.execute({ workspaceId: 'ws', distro: 'Ubuntu', executable: 'pwd', cwd: `${root}Other`, dry_run: true }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    await expect(backend.execute({ workspaceId: 'ws', executable: 'pwd', cwd: '/home/example/Project', dry_run: true }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(filesystemBackend.execute({ workspaceId: 'ws', direction: 'wsl_to_windows', path: '/home/example/Project' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).toEqual([]);
  });

  it.each(['unc', 'posix'])('invokes the canonical scoped target for a %s symlink', async (form) => {
    const { backend, filesystemBackend, calls } = fixture();
    const link = `${root}\\link`;
    const target = `${root}\\Actual`;
    filesystem.canonical.set(link, target);
    const cwd = form === 'unc' ? link : '/home/example/Project/link';
    const metadata = { 'lnwjud.activeWorkspaceRoot.v1': root };
    const request = { workspaceId: 'ws', distro: 'Ubuntu', executable: 'pwd', cwd, metadata };
    await expect(backend.execute({ ...request, dry_run: true })).resolves.toMatchObject({
      ok: true, value: { linux_cwd: '/home/example/Project/Actual' },
    });
    await expect(backend.execute(request)).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual([expect.objectContaining({
      cwd: target, arguments: ['--distribution', 'Ubuntu', '--cd', '/home/example/Project/Actual', '--exec', 'pwd'],
    })]);
    await expect(filesystemBackend.execute({
      workspaceId: 'ws', distro: 'Ubuntu', direction: 'windows_to_wsl', path: link, metadata,
    })).resolves.toMatchObject({ ok: true, value: { path: '/home/example/Project/Actual', windows_path: target } });
  });

  it('rejects canonical escape from Active Project even into another registered WSL root', async () => {
    const other = '\\\\wsl.localhost\\Ubuntu\\home\\example\\Other';
    const { backend, filesystemBackend, calls } = fixture([root, other]);
    filesystem.canonical.set(`${root}\\link`, other);
    const metadata = { 'lnwjud.activeWorkspaceRoot.v1': root };
    for (const dry_run of [true, false]) {
      await expect(backend.execute({ workspaceId: 'ws', distro: 'Ubuntu', executable: 'pwd', cwd: `${root}\\link`, metadata, dry_run }))
        .resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    }
    await expect(filesystemBackend.execute({
      workspaceId: 'ws', distro: 'Ubuntu', direction: 'windows_to_wsl', path: `${root}\\link`, metadata,
    })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    expect(calls).toEqual([]);
  });

  it('checks canonical WSL execution scope when only registered roots are supplied', async () => {
    const { backend, calls } = fixture();
    filesystem.canonical.set(`${root}\\link`, '\\\\wsl.localhost\\Ubuntu\\outside');
    for (const dry_run of [true, false]) {
      await expect(backend.execute({ workspaceId: 'ws', distro: 'Ubuntu', executable: 'pwd', cwd: `${root}\\link`, dry_run }))
        .resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    }
    expect(calls).toEqual([]);
  });

  it('rejects metadata through a WSL symlink outside registered roots before stat follows the link', async () => {
    const { filesystemBackend } = fixture();
    const link = `${root}\\link\\secret.txt`;
    const outside = '\\\\wsl.localhost\\Ubuntu\\outside\\secret.txt';
    filesystem.canonical.set(link, outside);
    const result = await filesystemBackend.execute({
      workspaceId: 'ws', distro: 'Ubuntu', operation: 'metadata', direction: 'windows_to_wsl', path: link,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    expect(filesystem.stats).not.toContain(link);
    expect(filesystem.stats).not.toContain(outside);
  });

  it('reads in-scope canonical file metadata without requiring that the target is a directory', async () => {
    const { filesystemBackend } = fixture();
    const link = `${root}\\link.txt`;
    const target = `${root}\\Actual.txt`;
    filesystem.canonical.set(link, target);
    filesystem.files.add(target);
    await expect(filesystemBackend.execute({
      workspaceId: 'ws', distro: 'Ubuntu', operation: 'metadata', direction: 'windows_to_wsl', path: link,
    })).resolves.toMatchObject({
      ok: true, value: { windows_path: target, path: '/home/example/Project/Actual.txt', exists: true, kind: 'file', raw_access: false },
    });
    expect(filesystem.stats).toContain(target);
    expect(filesystem.stats).not.toContain(link);
  });

  it('translates a future path without resolving or reading the filesystem', async () => {
    const { filesystemBackend } = fixture();
    await expect(filesystemBackend.execute({
      workspaceId: 'ws', distro: 'Ubuntu', operation: 'translate', direction: 'windows_to_wsl', path: `${root}\\future.txt`,
    })).resolves.toMatchObject({ ok: true, value: { path: '/home/example/Project/future.txt', raw_access: false } });
    expect(filesystem.reads).toEqual([]);
    expect(filesystem.stats).toEqual([]);
  });

  it('allows a valid outside path under Full Bypass but validates its canonical distro', async () => {
    const { backend } = fixture();
    const outside = '\\\\wsl$\\Ubuntu\\outside';
    await expect(backend.execute({ workspaceId: 'ws', distro: 'Ubuntu', executable: 'pwd', cwd: outside, dry_run: true }, undefined, bypass))
      .resolves.toMatchObject({ ok: true, value: { linux_cwd: '/outside' } });
    filesystem.canonical.set('\\\\wsl.localhost\\Ubuntu\\outside', '\\\\wsl.localhost\\Debian\\outside');
    await expect(backend.execute({ workspaceId: 'ws', distro: 'Ubuntu', executable: 'pwd', cwd: outside, dry_run: true }, undefined, bypass))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('supports WSL and drive roots without a drive-relative cwd', async () => {
    const { backend, filesystemBackend } = fixture(['\\\\wsl$\\Ubuntu\\', 'C:\\']);
    await expect(backend.execute({ workspaceId: 'ws', distro: 'Ubuntu', executable: 'pwd', cwd: '\\\\wsl$\\Ubuntu\\', dry_run: true }))
      .resolves.toMatchObject({ ok: true, value: { linux_cwd: '/' } });
    await expect(filesystemBackend.execute({ workspaceId: 'ws', distro: 'Ubuntu', direction: 'wsl_to_windows', path: '/mnt/c' }))
      .resolves.toMatchObject({ ok: true, value: { path: 'C:\\', raw_access: false } });
  });
});
