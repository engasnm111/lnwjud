import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@lnwjud/domain';
import { ContextEconomyRuntime } from './context-economy.js';
import { DocumentRuntimeService } from './document-runtime.js';
import { UpgradeRuntimeService } from './upgrade-runtime.js';
import { capabilityTools } from './tools/capability-tools.js';
import type { McpApplicationServices, McpToolContext } from './tools/tool-types.js';

const actor = { clientId: 'replacement-recovery-test', clientName: 'replacement recovery test' };
const replacementBackup = {
  recoveryId: 'recovery-before-provider',
  recoveryPath: 'E:\\recovery\\recovery-before-provider\\payload',
};
const providerFailure = appError('INTERNAL_ERROR', 'provider failed after backup', true);

function expectRecoveryDetails(result: Awaited<ReturnType<ReturnType<typeof capabilityTools>[number]['execute']>>): void {
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: providerFailure.code,
      message: providerFailure.message,
      recoverable: providerFailure.recoverable,
      details: {
        replacementRecoveryId: replacementBackup.recoveryId,
        replacementRecoveryPath: replacementBackup.recoveryPath,
      },
    },
  });
}

describe('external replacement recovery evidence', () => {
  it.each([
    ['office', { workspaceId: 'workspace-a', app: 'word', action: 'replace', file_path: 'report.docx', find: 'old', replace_with: 'new', userConfirmed: true }],
    ['audio', { workspaceId: 'workspace-a', action: 'record', output_path: 'capture.wav', duration_seconds: 1, userConfirmed: true }],
    ['screen_record', { workspaceId: 'workspace-a', action: 'start', output_path: 'capture.mp4', userConfirmed: true }],
  ] as const)('returns the Recovery Trash id when %s provider fails after the pre-image backup', async (toolName, input) => {
    const order: string[] = [];
    const services = {
      file: {
        async prepareExternalFileMutation(_actor: unknown, _workspaceId: string, request: { sourcePaths?: readonly string[]; targetPath: string }) {
          order.push('backup');
          return ok({
            sourcePaths: [...(request.sourcePaths ?? [])],
            targetPath: `E:\\project-a\\${path.win32.basename(request.targetPath)}`,
            targetRelativePath: path.win32.basename(request.targetPath),
            replacementBackup,
          });
        },
      },
      capabilities: {
        async execute() {
          order.push('provider');
          return err(providerFailure);
        },
      },
    } as unknown as McpApplicationServices;
    const context: McpToolContext = { actor, services, contextEconomy: new ContextEconomyRuntime() };
    const tool = capabilityTools(context).find((candidate) => candidate.name === toolName);
    if (tool === undefined) throw new Error(`missing tool ${toolName}`);

    const result = await tool.execute(input, new AbortController().signal);

    expect(order).toEqual(['backup', 'provider']);
    expectRecoveryDetails(result);
  });

  it.each([
    ['office', { workspaceId: 'workspace-a', app: 'word', action: 'replace', file_path: 'report.docx', find: 'old', replace_with: 'new', userConfirmed: true }],
    ['audio', { workspaceId: 'workspace-a', action: 'record', output_path: 'capture.wav', duration_seconds: 1, userConfirmed: true }],
    ['screen_record', { workspaceId: 'workspace-a', action: 'start', output_path: 'capture.mp4', userConfirmed: true }],
  ] as const)('does not dispatch %s provider when the pre-image backup fails', async (toolName, input) => {
    let providerCalled = false;
    const services = {
      file: {
        async prepareExternalFileMutation() {
          return err(appError('INTERNAL_ERROR', 'backup failed', true));
        },
      },
      capabilities: {
        async execute() {
          providerCalled = true;
          return ok({});
        },
      },
    } as unknown as McpApplicationServices;
    const context: McpToolContext = { actor, services, contextEconomy: new ContextEconomyRuntime() };
    const tool = capabilityTools(context).find((candidate) => candidate.name === toolName);
    if (tool === undefined) throw new Error(`missing tool ${toolName}`);

    const result = await tool.execute(input, new AbortController().signal);

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'backup failed' } });
    expect(providerCalled).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('returns the Recovery Trash id when DOCX merge provider fails after backup', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lnwjud-docx-recovery-'));
    const primary = path.join(root, 'primary.docx');
    const secondary = path.join(root, 'secondary.docx');
    const target = path.join(root, 'merged.docx');
    await Promise.all([
      writeFile(primary, 'primary', 'utf8'),
      writeFile(secondary, 'secondary', 'utf8'),
      writeFile(target, 'old target', 'utf8'),
    ]);
    const order: string[] = [];
    const services = {
      workspaceInfo: {
        async info() { return ok({ id: 'workspace-a', rootPath: root, realRootPath: root }); },
      },
      file: {
        async prepareExternalFileMutation(_actor: unknown, _workspaceId: string, request: { sourcePaths?: readonly string[]; targetPath: string }) {
          order.push('backup');
          return ok({
            sourcePaths: [...(request.sourcePaths ?? [])],
            targetPath: request.targetPath,
            targetRelativePath: path.basename(request.targetPath),
            replacementBackup,
          });
        },
      },
      capabilities: {
        async execute() {
          order.push('provider');
          return err(providerFailure);
        },
      },
    } as unknown as McpApplicationServices;
    const runtime = new DocumentRuntimeService(services, actor);

    const result = await runtime.docxMerge({
      workspaceId: 'workspace-a',
      file_path: primary,
      merge_paths: [secondary],
      target_path: target,
      dryRun: false,
      userConfirmed: true,
    });

    expect(order).toEqual(['backup', 'provider']);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: providerFailure.code,
        message: providerFailure.message,
        details: { replacementRecoveryId: replacementBackup.recoveryId },
      },
    });
  });

  it('returns the Recovery Trash id when PowerPoint save_as provider fails after backup', async () => {
    const order: string[] = [];
    const services = {
      file: {
        async prepareExternalFileMutation(_actor: unknown, _workspaceId: string, request: { sourcePaths?: readonly string[]; targetPath: string }) {
          order.push('backup');
          return ok({
            sourcePaths: [...(request.sourcePaths ?? [])],
            targetPath: request.targetPath,
            targetRelativePath: path.win32.basename(request.targetPath),
            replacementBackup,
          });
        },
      },
      capabilities: {
        async execute() {
          order.push('provider');
          return err(providerFailure);
        },
      },
    } as unknown as McpApplicationServices;
    const runtime = new UpgradeRuntimeService(services, actor);

    const result = await runtime.execute('office_ppt', {
      workspaceId: 'workspace-a',
      action: 'save_as',
      file_path: 'E:\\project-a\\deck.pptx',
      target_path: 'E:\\project-a\\copy.pptx',
      dryRun: false,
      userConfirmed: true,
    });

    expect(order).toEqual(['backup', 'provider']);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: providerFailure.code,
        message: providerFailure.message,
        details: { replacementRecoveryId: replacementBackup.recoveryId },
      },
    });
  });
});
