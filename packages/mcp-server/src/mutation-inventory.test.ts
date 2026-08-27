import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './tool-registry.js';
import { inspectMutationOperation } from './mutation-policy.js';
import type { McpPermissionLevel } from './tools/tool-types.js';

const actor = { clientId: 'mutation-inventory', clientName: 'mutation-inventory-test' };

const mandatoryCases = [
  ['delete_file', { workspaceId: 'workspace-1', path: 'victim.txt' }, 'DANGEROUS', 'delete'],
  ['write_file', { workspaceId: 'workspace-1', path: 'a.txt', content: 'x', overwriteExisting: true }, 'WRITE', 'replace'],
  ['process_start', { workspaceId: 'workspace-1', executable: 'node', args: ['script.js'] }, 'EXECUTE', 'execute'],
  ['codex_run', { workspaceId: 'workspace-1', instruction: 'edit the project' }, 'EXECUTE', 'opaque_mutation'],
  ['mcp_call', { server: 'child', tool: 'write', arguments: { path: 'a.txt' } }, 'DANGEROUS', 'opaque_mutation'],
  ['shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'pnpm.cmd', arguments: ['test'] }, 'EXECUTE', 'execute'],
] as const satisfies readonly [string, Readonly<Record<string, unknown>>, McpPermissionLevel, string][];

/**
 * These tools intentionally expose both read-only and mutating operations. Each
 * entry is paired with an explicit read-mode assertion below so adding a new
 * mixed tool cannot silently inherit this exception.
 */
const mixedOperationReadCases = [
  ['workspace_list', {}, 'READ'],
  ['skills_list', {}, 'READ'],
  ['skills_read', { skillId: 'agents-skills/executing-plans' }, 'READ'],
  ['mcp_list', {}, 'READ'],
  ['mcp_describe', { server: 'child' }, 'READ'],
  ['shell', { operation: 'status', task_id: 'task-1' }, 'EXECUTE'],
  ['wsl_exec', { operation: 'status', task_id: 'task-1' }, 'EXECUTE'],
  ['web_fetch', { method: 'GET', url: 'https://example.test' }, 'READ'],
  ['scheduler', { action: 'list' }, 'EXECUTE'],
  ['office', { action: 'read' }, 'WRITE'],
  ['office_ppt', { action: 'read' }, 'WRITE'],
  ['docx_merge', {}, 'WRITE'],
  ['dom_cdp', { action: 'query', parameters: { selector: 'body' } }, 'READ'],
  ['window', { operation: 'list' }, 'EXECUTE'],
  ['audio', { action: 'record', dry_run: true }, 'EXECUTE'],
  ['screen_record', { action: 'status' }, 'EXECUTE'],
  ['tool_batch', { calls: [] }, 'EXECUTE'],
  ['git_worktree_spawn', {}, 'WRITE'],
  ['git_worktree_remove', {}, 'DANGEROUS'],
  ['self_heal_apply', {}, 'DANGEROUS'],
] as const satisfies readonly [string, Readonly<Record<string, unknown>>, McpPermissionLevel][];

const mixedOperationNames = new Set(mixedOperationReadCases.map(([tool]) => tool));

function mutationSafetyMatrix(): string {
  const filename = path.resolve(import.meta.dirname, '..', '..', '..', 'docs', 'architecture', 'MUTATION_SAFETY_MATRIX.md');
  try {
    return readFileSync(filename, 'utf8');
  } catch {
    return '';
  }
}

describe('mutation inventory completeness', () => {
  it.each(mandatoryCases)('%s has mandatory mutation kind %s', (tool, input, permission, expectedKind) => {
    expect(inspectMutationOperation(tool, input, permission).kind).toBe(expectedKind);
  });

  it.each(mixedOperationReadCases)('%s has an explicitly-reviewed read-only mode', (tool, input, permission) => {
    expect(inspectMutationOperation(tool, input, permission).kind).toBe('read');
  });

  it('fails closed for every advertised non-READ tool unless its mixed read mode is explicitly reviewed here', () => {
    const registry = new ToolRegistry({}, actor, { codexToolsEnabled: true });
    const violations = registry.list()
      .filter((tool) => tool.permission !== 'READ')
      .filter((tool) => !mixedOperationNames.has(tool.name))
      .filter((tool) => inspectMutationOperation(tool.name, {}, tool.permission).kind === 'read')
      .map((tool) => `${tool.name}:${tool.permission}`);

    expect(violations).toEqual([]);
  });

  it('documents every advertised MCP tool in the mutation safety matrix', () => {
    const matrix = mutationSafetyMatrix();
    const advertised = new ToolRegistry({}, actor, { codexToolsEnabled: true }).list().map((tool) => tool.name);
    const missing = advertised.filter((name) => !matrix.includes(`\`${name}\``));

    expect(missing).toEqual([]);
  });
});
