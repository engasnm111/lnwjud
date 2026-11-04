import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LocalExtensionsService } from '@lnwjud/extensions';
import { createWindowsMcpStdioOwner } from '@lnwjud/process';
import { CONTAINMENT_HELPER_SHA256, CONTAINMENT_PIN_SHA256 } from '../../capabilities/src/containment-integrity.generated.js';
import { permissionProfiles } from '@lnwjud/permissions';
import { ToolRegistry } from './tool-registry.js';

const child = fileURLToPath(new URL('../../extensions/tests/fixtures/external-mcp-server.mjs', import.meta.url));

describe('real local external MCP direct-vs-batch contract', () => {
  it('preserves direct success, exact child error, and batched child status without changing approval policy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-mcp-direct-batch-'));
    const windowsMcpStdioOwner = process.platform === 'win32' ? createWindowsMcpStdioOwner({
      helper: {
        executable: fileURLToPath(new URL('../../../apps/desktop/build/native-containment/lnwjud-containment.exe', import.meta.url)),
        sha256: CONTAINMENT_HELPER_SHA256,
        buildId: 'lnwjud-containment-v2',
      },
      pin: {
        modulePath: fileURLToPath(new URL('../../../apps/desktop/build/native-containment/lnwjud-containment-pin.node', import.meta.url)),
        sha256: CONTAINMENT_PIN_SHA256,
      },
    }) : undefined;
    const extensions = new LocalExtensionsService({
      ...(windowsMcpStdioOwner === undefined ? {} : { windowsMcpStdioOwner }),
      homeDir: root,
      appDataDir: root,
      settings: {
        mode: 'enable_all',
        disabledServers: [], enabledServers: [],
        disabledSkillRoots: [], extraSkillRoots: [],
        extraMcpServers: {
          'safe-local-fixture': {
            command: process.execPath,
            args: [child],
            env: { LNWJUD_EXTERNAL_MCP_FIXTURE_ERA: 'schema-error' },
          },
        },
      },
      callTimeoutMs: 20_000,
    });
    try {
      const registry = new ToolRegistry({ extensions }, {
        clientId: 'direct-batch-test', clientName: 'test',
      }, {
        sessionId: 'one-session',
        profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
        hostMutationApprovalProvider: async (): Promise<boolean> => true,
      });
      const declared = await registry.invoke('mcp_describe', { server: 'safe-local-fixture' });
      expect(declared.isError).not.toBe(true);
      expect(JSON.stringify(declared)).toContain('schema_error_demo');
      const base = {
        server: 'safe-local-fixture', tool: 'schema_error_demo',
        userConfirmed: true,
      };
      const valid = { ...base, arguments: { mode: 'success-valid' } };
      const denied = await registry.invoke('mcp_call', {
        ...valid, userConfirmed: false,
      });
      expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
      const direct = await registry.invoke('mcp_call', valid);
      expect(direct).toMatchObject({ structuredContent: { value: 'ok' } });
      expect(direct.isError).not.toBe(true);
      const batched = await registry.invoke('tool_batch', {
        calls: [{ id: 'successful-child', tool: 'mcp_call', arguments: valid }],
      });
      expect(batched.isError).not.toBe(true);
      expect(batched.structuredContent).toMatchObject({
        summary: { succeeded: 1, failed: 0 },
        results: [{ id: 'successful-child', status: 'succeeded' }],
      });
      const invalid = { ...base, arguments: { mode: 'error-no-structured' } };
      const directError = await registry.invoke('mcp_call', invalid);
      expect(directError.isError).toBe(true);
      expect(JSON.stringify(directError.content)).toContain('Demo validation failed');
      const batchedError = await registry.invoke('tool_batch', {
        calls: [{ id: 'failed-child', tool: 'mcp_call', arguments: invalid }],
      });
      expect(batchedError.isError).toBe(true);
      expect(batchedError.structuredContent).toMatchObject({
        summary: { succeeded: 0, failed: 1 },
        results: [{ id: 'failed-child', status: 'failed' }],
      });
    } finally {
      await extensions.close();
      await rm(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 45_000);
});
