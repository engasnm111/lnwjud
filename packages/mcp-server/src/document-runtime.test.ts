import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { DocumentRuntimeService } from './document-runtime.js';
import type { McpApplicationServices } from './tools/tool-types.js';

const actor = { clientId: 'test-client', clientName: 'test' };

function servicesWithOffice(root: string, officeResults: Record<string, unknown>): McpApplicationServices {
  return {
    workspaceInfo: { info: async () => ok({ id: 'ws-1', realRootPath: root, rootPath: root }) },
    capabilities: {
      async execute(_tool: string, request: { app?: string; action?: string; file_path?: string; merge_paths?: string[] }) {
        const key = `${request.app}:${request.action}`;
        const handler = officeResults[key];
        if (typeof handler === 'function') return handler(request);
        return handler === undefined
          ? { ok: false as const, error: { code: 'INVALID_INPUT' as const, message: `unexpected office call ${key}`, recoverable: false } }
          : ok(handler);
      },
    },
    file: {
      async prepareExternalFileMutation(_actor, _workspaceId, request) {
        return ok({
          sourcePaths: [...(request.sourcePaths ?? [])],
          targetPath: request.targetPath,
          targetRelativePath: path.relative(root, request.targetPath),
        });
      },
    } as McpApplicationServices['file'],
  } as unknown as McpApplicationServices;
}

async function withWorkspace(run: (root: string, file: string, provider: string) => Promise<void>): Promise<void> {
  // Hosted Windows runners may report TEMP as an 8.3 path (RUNNER~1) while
  // realpath() returns the long form. Keep fixtures canonical like real workspaces.
  const root = path.normalize(await realpath(await mkdtemp(path.join(tmpdir(), 'lnwjud-doc-test-'))));
  const file = path.join(root, 'sample.pdf');
  await writeFile(file, '%PDF-1.4\n%fake-but-present\n%%EOF\n', 'utf8');
  const provider = path.join(root, 'pdftotext.exe');
  await writeFile(provider, 'stub', 'utf8');
  await run(root, file, provider);
}

describe('DocumentRuntimeService', () => {
  const fullBypassAuthorization = {
    mode: 'full_bypass',
    applicationApproved: true,
    bypassApplicationAuthorization: true,
    source: 'full_bypass',
  } as const;

  it('extracts PDF layout text through the configured provider', async () => {
    await withWorkspace(async (root, file, provider) => {
      const calls: { provider: string; args: readonly string[] }[] = [];
      const runtime = new DocumentRuntimeService(servicesWithOffice(root, {}), actor, {
        pdfProvider: provider,
        pdfRunner: async (resolvedProvider, args): Promise<ReturnType<typeof ok>> => { calls.push({ provider: resolvedProvider, args }); return ok('name  qty\npencil 3\fpen 5'); },
      });
      const result = await runtime.extractTables({ workspaceId: 'ws-1', file_path: file });
      expect(result).toMatchObject({ ok: true, value: {
        tool: 'pdf_extract_tables', available: true, workspaceId: 'ws-1', mode: 'layout-text', truncated: false,
        text: 'name  qty\npencil 3\fpen 5',
      } });
      expect(calls).toEqual([{ provider, args: ['-layout', file, '-'] }]);
    });
  });

  it('reports a truthful unavailable state without a PDF provider', async () => {
    await withWorkspace(async (root, file) => {
      const runtime = new DocumentRuntimeService(servicesWithOffice(root, {}), actor, { environment: { PATH: '' }, pdfProvider: 'Z:\\missing\\pdftotext.exe' });
      const result = await runtime.extractTables({ workspaceId: 'ws-1', file_path: file });
      expect(result).toMatchObject({ ok: true, value: {
        tool: 'pdf_extract_tables', available: false, status: 'needs_setup',
        requirements: ['local PDF provider', 'bounded document size'],
      } });
    });
  });

  it('summarizes PDF structure for inspect_pdf', async () => {
    await withWorkspace(async (root, file, provider) => {
      const runtime = new DocumentRuntimeService(servicesWithOffice(root, {}), actor, {
        pdfProvider: provider,
        pdfRunner: async (): Promise<ReturnType<typeof ok>> => ok('page one\fpage two\fpage three'),
      });
      const result = await runtime.inspectPdf({ workspaceId: 'ws-1', file_path: file });
      expect(result).toMatchObject({ ok: true, value: {
        tool: 'inspect_pdf', available: true, workspaceId: 'ws-1', pages: 2, preview: expect.stringContaining('page one'),
      } });
    });
  });

  it('inspects workbooks through the Office capability with a bounded sample', async () => {
    await withWorkspace(async (root, file) => {
      const runtime = new DocumentRuntimeService(servicesWithOffice(root, {
        'excel:sheets': { sheets: [{ name: 'Sheet1', used_range: 'A1:B2', rows: 2, columns: 2 }] },
        'excel:read': { values: [[1, 2], [3, 4]] },
      }), actor);
      const result = await runtime.inspectWorkbook({ workspaceId: 'ws-1', file_path: file });
      expect(result).toMatchObject({ ok: true, value: {
        tool: 'inspect_workbook', available: true, workspaceId: 'ws-1',
        sheets: [expect.objectContaining({ name: 'Sheet1' })],
        sampleRange: 'A1:C8',
        sample: [[1, 2], [3, 4]],
      } });
    });
  });

  it('keeps docx_merge workspace-confined, dry-run first, confirmation gated, then applies via Word COM', async () => {
    await withWorkspace(async (root) => {
      const primary = path.join(root, 'a.docx');
      const second = path.join(root, 'b.docx');
      const third = path.join(root, 'c.docx');
      await Promise.all([writeFile(primary, 'a'), writeFile(second, 'b'), writeFile(third, 'c')]);
      const merges: { file_path?: string; merge_paths?: string[]; target_path?: string; userConfirmed?: boolean }[] = [];
      const runtime = new DocumentRuntimeService(servicesWithOffice(root, {
        'word:merge': (request: { file_path?: string; merge_paths?: string[]; target_path?: string; userConfirmed?: boolean }) => {
          merges.push({ file_path: request.file_path, merge_paths: request.merge_paths, target_path: request.target_path, userConfirmed: request.userConfirmed });
          return ok({ app: 'word', action: 'merge', saved: true });
        },
      }), actor);

      const input = { workspaceId: 'ws-1', file_path: 'a.docx', merge_paths: ['b.docx', 'c.docx'], target_path: 'merged.docx' };
      await expect(runtime.docxMerge({ ...input })).resolves.toMatchObject({ ok: true, value: { dryRun: true, applied: false } });
      await expect(runtime.docxMerge({ ...input, dryRun: false })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
      await expect(runtime.docxMerge({ ...input, dryRun: false, userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { applied: true } });
      expect(merges).toEqual([{ file_path: primary, merge_paths: [second, third], target_path: path.join(root, 'merged.docx'), userConfirmed: true }]);
      await expect(runtime.docxMerge({ workspaceId: 'ws-1', file_path: primary, target_path: 'x.docx' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
  });

  it('applies docx_merge under trusted Full Bypass without caller confirmation', async () => {
    await withWorkspace(async (root) => {
      await Promise.all([
        writeFile(path.join(root, 'a.docx'), 'a'),
        writeFile(path.join(root, 'b.docx'), 'b'),
      ]);
      const runtime = new DocumentRuntimeService(servicesWithOffice(root, {
        'word:merge': { app: 'word', action: 'merge', saved: true },
      }), actor);

      await expect(runtime.docxMerge({
        workspaceId: 'ws-1',
        file_path: 'a.docx',
        merge_paths: ['b.docx'],
        target_path: 'merged.docx',
        dryRun: false,
      }, undefined, fullBypassAuthorization)).resolves.toMatchObject({ ok: true, value: { applied: true } });
    });
  });

  it('rejects paths that escape the registered workspace before invoking a provider', async () => {
    await withWorkspace(async (root, _file, provider) => {
      const outside = path.join(root, '..', 'outside.pdf');
      await writeFile(outside, '%PDF-1.4\n%%EOF\n', 'utf8');
      let calls = 0;
      const runtime = new DocumentRuntimeService(servicesWithOffice(root, {}), actor, {
        pdfProvider: provider,
        pdfRunner: async (): Promise<ReturnType<typeof ok>> => { calls += 1; return ok('should not run'); },
      });
      await expect(runtime.extractTables({ workspaceId: 'ws-1', file_path: path.join('..', 'outside.pdf') })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
      await expect(runtime.extractTables({ workspaceId: 'ws-1', file_path: outside }, undefined, fullBypassAuthorization))
        .resolves.toMatchObject({ ok: true, value: { file: await realpath(outside) } });
      expect(calls).toBe(1);
    });
  });
});
