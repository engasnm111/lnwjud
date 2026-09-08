import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@lnwjud/domain';
import { SandboxRuntimeService } from './sandbox-runtime.js';
import type { McpApplicationServices } from './tools/tool-types.js';

const actor = { clientId: 'test-client', clientName: 'test' };

// Translate only this fixture's Windows volume at the filesystem boundary.
// The runtime and sandbox plan still perform real Windows path validation;
// artifacts are persisted in an actual host-native temporary directory.
const fixtureFs = vi.hoisted(() => ({ root: '', windowsRoot: 'C:\\sandbox-fixture' }));
function hostFile<T>(file: T): T | string {
  if (typeof file !== 'string') return file;
  const relative = path.win32.relative(fixtureFs.windowsRoot, file);
  if (relative.startsWith('..') || path.win32.isAbsolute(relative)) return file;
  return path.join(fixtureFs.root, ...relative.split('\\'));
}
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (file: Parameters<typeof actual.existsSync>[0]): boolean => actual.existsSync(hostFile(file)) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: (file: string, options: Parameters<typeof actual.mkdir>[1]): Promise<string | undefined> => actual.mkdir(hostFile(file), options),
    readFile: (file: string, options: 'utf8'): Promise<string> => actual.readFile(hostFile(file), options),
    writeFile: (file: string, data: string, options?: 'utf8'): Promise<void> => actual.writeFile(hostFile(file), data, options),
  };
});

function servicesWithRoot(root: string): McpApplicationServices {
  return {
    workspaceInfo: {
      info: async () => ok({ id: 'ws-1', realRootPath: root, rootPath: root }),
    },
  } as unknown as McpApplicationServices;
}

function service(options: {
  root: string;
  launched?: (wsbPath: string) => void;
  waitResult?: boolean;
}): SandboxRuntimeService {
  return new SandboxRuntimeService(servicesWithRoot(options.root), actor, {
    platform: 'win32',
    sandboxExecutable: path.join(options.root, 'WindowsSandbox.exe'),
    launcher: async (): Promise<ReturnType<typeof ok>> => { options.launched?.('launched'); return ok(undefined); },
    waiter: async () => options.waitResult ?? true,
  });
}

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'lnwjud-sandbox-test-'));
  fixtureFs.root = root;
  await writeFile(path.join(root, 'WindowsSandbox.exe'), 'stub');
  try {
    await run(fixtureFs.windowsRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
    fixtureFs.root = '';
  }
}

describe('SandboxRuntimeService', () => {
  const fullBypassAuthorization = {
    mode: 'full_bypass',
    applicationApproved: true,
    bypassApplicationAuthorization: true,
    source: 'full_bypass',
  } as const;

  it('reports Windows Sandbox as unsupported rather than a missing dependency on POSIX hosts', async () => {
    const runtime = new SandboxRuntimeService(servicesWithRoot('/tmp/project'), actor, {
      platform: 'linux',
      sandboxExecutable: '/usr/bin/WindowsSandbox.exe',
    });
    await expect(runtime.execute({ workspaceId: 'ws-1', executable: 'node', arguments: ['--version'] })).resolves.toMatchObject({
      ok: true, value: { status: 'unsupported', available: false, ready: false, reason: 'unsupported_platform', readinessReason: 'unsupported_platform' },
    });
  });

  it('reports a truthful unavailable state when WindowsSandbox.exe is missing', async () => {
    const runtime = new SandboxRuntimeService(servicesWithRoot('C:\\nowhere'), actor, {
      platform: 'win32',
      sandboxExecutable: 'Z:\\missing\\WindowsSandbox.exe',
    });
    await expect(runtime.execute({ workspaceId: 'ws-1', executable: 'node', arguments: ['--version'] })).resolves.toMatchObject({
      ok: true, value: { available: false, reason: 'windows_sandbox_feature_missing' },
    });
  });

  it('fails closed when the workspace registry is unavailable', async () => {
    await withTempRoot(async (root) => {
      const runtime = new SandboxRuntimeService({} as McpApplicationServices, actor, {
        platform: 'win32',
        sandboxExecutable: path.join(root, 'WindowsSandbox.exe'),
      });
      await expect(runtime.execute({ workspaceId: 'ws-1', executable: 'node', arguments: ['--version'] })).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: expect.stringContaining('verified registered workspace'),
        },
      });
    });
  });

  it('returns the artifact-only plan as a dry-run by default', async () => {
    await withTempRoot(async (root) => {
      const runtime = service({ root });
      const result = await runtime.execute({ workspaceId: 'ws-1', executable: 'node', arguments: ['--version'] });
      expect(result).toMatchObject({ ok: true, value: {
        dryRun: true, executed: false, networking: 'disabled', processIo: 'artifact-only',
      } });
      expect((result as { value: { wsbXml: string } }).value.wsbXml).toContain('sandbox-runner.ps1');
    });
  });

  it('requires explicit user confirmation before detonating', async () => {
    await withTempRoot(async (root) => {
      const runtime = service({ root });
      await expect(runtime.execute({ workspaceId: 'ws-1', executable: 'node', arguments: ['--version'], dryRun: false })).resolves.toMatchObject({
        ok: false, error: { code: 'PERMISSION_REQUIRED' },
      });
    });
  });

  it('detonates under trusted Full Bypass without caller confirmation', async () => {
    await withTempRoot(async (root) => {
      const runtime = new SandboxRuntimeService(servicesWithRoot(root), actor, {
        platform: 'win32',
        sandboxExecutable: path.join(root, 'WindowsSandbox.exe'),
        launcher: async (): Promise<ReturnType<typeof ok>> => ok(undefined),
        waiter: async (file): Promise<boolean> => {
          const output = path.win32.dirname(file);
          await writeFile(path.join(output, 'exit-code.txt'), '0');
          await writeFile(path.join(output, 'stdout.log'), 'bypassed');
          await writeFile(path.join(output, 'stderr.log'), '');
          return true;
        },
      });

      await expect(runtime.execute({
        workspaceId: 'ws-1', executable: 'node', arguments: ['--version'],
        dryRun: false, jobId: 'job-full-bypass', timeoutSeconds: 60,
      }, undefined, fullBypassAuthorization)).resolves.toMatchObject({
        ok: true, value: { executed: true, jobId: 'job-full-bypass', stdout: 'bypassed' },
      });
    });
  });

  it('stages the WSB, runner, and manifest, then returns artifact results', async () => {
    await withTempRoot(async (root) => {
      let stagedOutput = '';
      const runtime = new SandboxRuntimeService(servicesWithRoot(root), actor, {
        platform: 'win32',
        sandboxExecutable: path.join(root, 'WindowsSandbox.exe'),
        launcher: async (): Promise<ReturnType<typeof ok>> => ok(undefined),
        waiter: async (file): Promise<boolean> => {
          stagedOutput = path.win32.dirname(file);
          await writeFile(path.join(stagedOutput, 'exit-code.txt'), '0');
          await writeFile(path.join(stagedOutput, 'stdout.log'), 'detonated ok');
          await writeFile(path.join(stagedOutput, 'stderr.log'), '');
          return true;
        },
      });

      const result = await runtime.execute({
        workspaceId: 'ws-1', executable: 'node', arguments: ['--version'],
        dryRun: false, userConfirmed: true, jobId: 'job-test-1', timeoutSeconds: 60,
      });
      expect(result).toMatchObject({ ok: true, value: {
        tool: 'sandbox_exec', executed: true, jobId: 'job-test-1', exitCode: 0, stdout: 'detonated ok',
      } });

      const staging = path.join(root, '.lnwjud', 'sandbox', 'job-test-1');
      const wsb = await readFile(path.join(staging, 'job.wsb'), 'utf8');
      expect(wsb).toContain('<Networking>Disable</Networking>');
      expect(wsb).toContain('sandbox-runner.ps1');
      const manifest = JSON.parse(await readFile(path.join(staging, 'output', 'job-manifest.json'), 'utf8')) as { executable: string; jobId: string };
      expect(manifest).toMatchObject({ executable: 'node', jobId: 'job-test-1' });
      const runner = await readFile(path.join(staging, 'input', 'sandbox-runner.ps1'), 'utf8');
      expect(runner).toContain('job-manifest.json');
      expect(runner).toContain('$manifest.exitCode');
      expect(runner).not.toContain('$manifest.exit_code');
    });
  });

  it('fails closed when the sandbox never produces exit-code.txt', async () => {
    await withTempRoot(async (root) => {
      const runtime = service({ root, waitResult: false });
      await expect(runtime.execute({
        workspaceId: 'ws-1', executable: 'node', arguments: ['--version'],
        dryRun: false, userConfirmed: true, timeoutSeconds: 5,
      })).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    });
  });
});
