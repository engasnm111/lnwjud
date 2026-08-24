import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { SandboxRuntimeService } from './sandbox-runtime.js';
import type { McpApplicationServices } from './tools/tool-types.js';

const actor = { clientId: 'test-client', clientName: 'test' };

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
  const rawRoot = await mkdtemp(path.join(tmpdir(), 'lnwjud-sandbox-test-'));
  const root = process.platform === 'win32' ? path.win32.normalize(rawRoot) : rawRoot;
  await writeFile(path.join(root, 'WindowsSandbox.exe'), 'stub');
  try {
    await run(root);
  } finally {
    // Best-effort cleanup; artifacts stay for audit in production too.
  }
}

describe('SandboxRuntimeService', () => {
  it('reports a truthful unavailable state when WindowsSandbox.exe is missing', async () => {
    const runtime = new SandboxRuntimeService(servicesWithRoot('C:\\nowhere'), actor, {
      platform: 'win32',
      sandboxExecutable: 'Z:\\missing\\WindowsSandbox.exe',
    });
    await expect(runtime.execute({ workspaceId: 'ws-1', executable: 'node', arguments: ['--version'] })).resolves.toMatchObject({
      ok: true, value: { available: false, reason: 'windows_sandbox_feature_missing' },
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

  it('stages the WSB, runner, and manifest, then returns artifact results', async () => {
    await withTempRoot(async (root) => {
      let stagedOutput = '';
      const runtime = new SandboxRuntimeService(servicesWithRoot(root), actor, {
        platform: 'win32',
        sandboxExecutable: path.join(root, 'WindowsSandbox.exe'),
        launcher: async (): Promise<ReturnType<typeof ok>> => ok(undefined),
        waiter: async (file): Promise<boolean> => {
          stagedOutput = path.dirname(file);
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
