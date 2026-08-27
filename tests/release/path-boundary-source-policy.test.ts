import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const authorizationSources = [
  'apps/cli/src/runtime/strict-workspace-repository.ts',
  'packages/capabilities/src/wsl-backend.ts',
  'packages/capabilities/src/shell-backend.ts',
  'packages/capabilities/src/windows-native-backend.ts',
  'packages/application/src/workspace-index.ts',
  'packages/codex/src/codex-discovery.ts',
  'packages/extensions/src/skill-catalog.ts',
  'packages/mcp-server/src/destructive-scope.ts',
  'packages/mcp-server/src/document-runtime.ts',
  'packages/mcp-server/src/lsp-runtime.ts',
  'packages/mcp-server/src/sandbox-contract.ts',
] as const;

describe('runtime path authorization source policy', () => {
  it.each(authorizationSources)('%s uses segment-aware path.relative containment instead of string-prefix authorization', async (relativePath) => {
    const source = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
    expect(source).not.toMatch(/\brelative\.startsWith\s*\(/);
    expect(source).not.toMatch(/\bcandidate\.startsWith\s*\(/);
  });
});
