import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { LspRuntimeService } from './lsp-runtime.js';
import type { McpApplicationServices } from './tools/tool-types.js';

const actor = { clientId: 'test-client', clientName: 'test' };

function servicesWithRoot(root: string): McpApplicationServices {
  return {
    workspaceInfo: { info: async () => ok({ id: 'ws-1', realRootPath: root, rootPath: root }) },
  } as unknown as McpApplicationServices;
}

describe('LspRuntimeService', () => {
  it('reports the missing configuration truthfully before spawning anything', async () => {
    let spawns = 0;
    const runtime = new LspRuntimeService(servicesWithRoot('C:\\ws'), actor, {
      environment: {},
      spawner: (): ReturnType<typeof ok> => { spawns += 1; return ok({ kill: () => undefined } as never); },
    });
    await expect(runtime.diagnostics({ workspaceId: 'ws-1', files: ['src/a.ts'] })).resolves.toMatchObject({
      ok: false, error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('LNWJUD_LSP_TYPESCRIPT_COMMAND') },
    });
    expect(spawns).toBe(0);
  });

  it('rejects lexical workspace escapes before spawning a language server', async () => {
    const rawRoot = await mkdtemp(path.join(tmpdir(), 'lnwjud-lsp-test-'));
    const root = process.platform === 'win32' ? path.win32.normalize(rawRoot) : rawRoot;
    const outside = path.join(root, '..', 'outside.ts');
    await writeFile(outside, 'export const outside = true;\n', 'utf8');
    let spawns = 0;
    const runtime = new LspRuntimeService(servicesWithRoot(root), actor, {
      environment: { LNWJUD_LSP_TYPESCRIPT_COMMAND: JSON.stringify([process.execPath, 'unused-server.mjs']) },
      spawner: (): ReturnType<typeof ok> => { spawns += 1; return ok({ kill: () => undefined } as never); },
    });
    await expect(runtime.diagnostics({ workspaceId: 'ws-1', files: ['..\\outside.ts'] })).resolves.toMatchObject({
      ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' },
    });
    expect(spawns).toBe(0);
  });

  it('collects published diagnostics from a configured language server', async () => {
    const rawRoot = await mkdtemp(path.join(tmpdir(), 'lnwjud-lsp-test-'));
    const root = process.platform === 'win32' ? path.win32.normalize(rawRoot) : rawRoot;
    await writeFile(path.join(root, 'a.ts'), 'export const broken = 1;\n', 'utf8');

    const fakeServer = await createFakeServer();
    try {
      const runtime = new LspRuntimeService(servicesWithRoot(root), actor, {
        environment: { LNWJUD_LSP_TYPESCRIPT_COMMAND: JSON.stringify([process.execPath, fakeServer]) },
        timeoutMs: 10_000,
      });
      const result = await runtime.diagnostics({ workspaceId: 'ws-1', files: ['a.ts'] });
      expect(result).toMatchObject({ ok: true, value: {
        tool: 'lsp_diagnostics', available: true, language: 'typescript',
        diagnostics: [expect.objectContaining({ count: 1, entries: [expect.objectContaining({ message: 'fake ไทย TS1234' })] })],
      } });
    } finally {
      // The fake server exits on shutdown; nothing to clean up.
    }
  });

  it('returns an approval-gated rename plan without applying it', async () => {
    const rawRoot = await mkdtemp(path.join(tmpdir(), 'lnwjud-lsp-test-'));
    const root = process.platform === 'win32' ? path.win32.normalize(rawRoot) : rawRoot;
    await writeFile(path.join(root, 'a.ts'), 'export const broken = 1;\n', 'utf8');
    const fakeServer = await createFakeServer();
    const runtime = new LspRuntimeService(servicesWithRoot(root), actor, {
      environment: { LNWJUD_LSP_TYPESCRIPT_COMMAND: JSON.stringify([process.execPath, fakeServer]) },
      timeoutMs: 10_000,
    });
    const result = await runtime.renamePlan({ workspaceId: 'ws-1', file: 'a.ts', line: 0, character: 13, newName: 'fixed' });
    expect(result).toMatchObject({ ok: true, value: {
      applied: false, requiresApproval: true, newName: 'fixed',
      edit: expect.objectContaining({ documentChanges: expect.any(Array) }),
    } });
    if (result.ok) expect((result.value as { applyHint: string }).applyHint).toContain('apply_patch');
  });
});

async function createFakeServer(): Promise<string> {
  const { writeFile: write } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(tmpdir(), 'lnwjud-lsp-fake-'));
  const file = path.join(directory, 'fake-server.mjs');
  await write(file, FAKE_SERVER_SOURCE, 'utf8');
  return file;
}

const FAKE_SERVER_SOURCE = `
import { createInterface } from 'node:readline';
let buffer = '';
const write = (message) => process.stdout.write('Content-Length: ' + Buffer.byteLength(JSON.stringify(message)) + '\\r\\n\\r\\n' + JSON.stringify(message));
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) return;
    const match = /Content-Length:\\s*(\\d+)/i.exec(buffer.slice(0, headerEnd));
    if (match === null) { buffer = buffer.slice(headerEnd + 4); continue; }
    const length = parseInt(match[1], 10);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length);
    buffer = buffer.slice(headerEnd + 4 + length);
    const message = JSON.parse(body);
    if (message.method === 'initialize') {
      write({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: 1, renameProvider: true } } });
    } else if (message.method === 'textDocument/didOpen') {
      write({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: message.params.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'fake ไทย TS1234' }] } });
    } else if (message.method === 'textDocument/rename') {
      write({ jsonrpc: '2.0', id: message.id, result: { documentChanges: [{ textDocument: { uri: message.params.textDocument.uri, version: 1 }, edits: [{ range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } }, newText: message.params.newName }] }] } });
    } else if (message.method === 'shutdown') {
      write({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.method === 'exit') {
      process.exit(0);
    }
  }
});
`;
