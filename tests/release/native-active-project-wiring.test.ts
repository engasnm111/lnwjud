import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

describe('path-bearing native Active Project wiring', () => {
  it('binds Desktop and stdio hosts to their host-owned Active Project providers', async () => {
    const desktop = await source('apps/desktop/src/main/desktop-services.ts');
    expect(desktop).toContain('activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => {');
    expect(desktop).toContain('return selected === null ? null : { workspaceId: selected.id, rootPath: selected.realRootPath };');

    const stdio = await source('apps/cli/src/runtime/stdio-mcp-runtime.ts');
    expect(stdio).toContain('activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope> => ({ workspaceId: workspace.id, rootPath: workspace.realRootPath })');
  });

  it('injects the host Active Project root into every path-bearing native request', async () => {
    const registry = await source('packages/mcp-server/src/tool-registry.ts');
    expect(registry).toContain("const NATIVE_ACTIVE_SCOPE_TOOLS = new Set(['office', 'audio', 'screen_record']);");
    expect(registry).toContain('const nativePathScopeRequired = requiresNativePathScope(tool.name, activeRoutedInput);');
    expect(registry).toContain('const activeRoutedInput = await this.routeInputToActiveWorkspace(parsedInput);');
    expect(registry).toContain('const matched = commonActiveWorkspaceScope(scopes, absolutePaths);');
    expect(registry).toContain('[CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: normalizedRoot');
    expect(registry).toContain("for (const key of ['file_path', 'target_path', 'output_path'] as const)");
  });

  it('makes the host Active Project root override every fallback native root, including unrestricted mode', async () => {
    const backend = await source('packages/capabilities/src/windows-native-backend.ts');
    expect(backend).toContain('const activeWorkspaceRoot = readCapabilityActiveWorkspaceRoot(input);');
    expect(backend).toContain('configured = [activeWorkspaceRoot];');
    expect(backend).toContain('} else if (this.options.allowedRootsProvider !== undefined) {');
    expect(backend).not.toContain('if (this.options.unrestricted === true) return ok(undefined);');
  });
});
