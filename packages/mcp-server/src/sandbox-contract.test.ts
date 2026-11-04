import { describe, expect, it } from 'vitest';
import { buildSandboxExecutionPlan } from './sandbox-contract.js';

describe('Windows Sandbox execution contract', () => {
  it('builds an offline artifact-based WSB plan with read-only input and no stdout transport', () => {
    const result = buildSandboxExecutionPlan({
      workspaceId: 'ws-1',
      allowedRoots: ['C:\\workspace'],
      inputPath: 'C:\\workspace\\fixture',
      outputPath: 'C:\\workspace\\.lnwjud\\sandbox-output',
      executable: 'node',
      arguments: ['--version'],
    });

    expect(result).toMatchObject({ ok: true, value: {
      networking: 'disabled',
      processIo: 'artifact-only',
      inputReadOnly: true,
      outputArtifact: expect.objectContaining({ path: 'C:\\workspace\\.lnwjud\\sandbox-output' }),
      jobManifest: expect.objectContaining({ executable: 'node', arguments: ['--version'] }),
      wsbXml: expect.stringContaining('<Networking>Disable</Networking>'),
    } });
    if (result.ok) expect(result.value.wsbXml).toContain('<ReadOnly>true</ReadOnly>');
  });

  it('rejects job IDs that alias parent directories or Win32 device names', () => {
    for (const jobId of ['.', '..', 'CON', 'nul.txt', 'job.']) {
      expect(buildSandboxExecutionPlan({
        workspaceId: 'ws-1', allowedRoots: ['C:\\workspace'],
        inputPath: 'C:\\workspace\\.lnwjud\\sandbox\\input',
        outputPath: 'C:\\workspace\\.lnwjud\\sandbox\\output',
        executable: 'node', arguments: [], jobId,
      })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
  });

  it('rejects workspace escape and shell-string commands before a WSB is created', () => {
    expect(buildSandboxExecutionPlan({
      workspaceId: 'ws-1', allowedRoots: ['C:\\workspace'], inputPath: 'C:\\outside', outputPath: 'C:\\workspace\\out', executable: 'node', arguments: [],
    })).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    expect(buildSandboxExecutionPlan({
      workspaceId: 'ws-1', allowedRoots: ['C:\\workspace'], inputPath: 'C:\\workspace\\in', outputPath: 'C:\\workspace\\out', executable: 'bash', arguments: ['-lc', 'echo unsafe'],
    })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
