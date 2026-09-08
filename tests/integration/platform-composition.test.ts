import { access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_TOOL_RUNTIME_FIXTURES } from '../../packages/mcp-server/src/tool-runtime-fixtures.js';
import { createPlatformProfile } from '../../packages/shared/src/platform-profile.js';
import { PLATFORM_FIXTURES } from '../helpers/platform-fixtures.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

describe('deterministic platform composition harness', () => {
  it('resolves every fixture without mutating process globals', () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;

    for (const fixture of PLATFORM_FIXTURES) {
      const profile = createPlatformProfile(fixture.input);
      expect(profile).toMatchObject({
        platform: fixture.input.platform,
        arch: fixture.input.arch,
        release: fixture.input.release,
        family: fixture.expectedFamily,
        supportTier: fixture.expectedTier,
      });
    }

    expect(process.platform).toBe(originalPlatform);
    expect(process.arch).toBe(originalArch);
  });

  it('never exposes Windows-only providers as native on a foreign host', () => {
    for (const fixture of PLATFORM_FIXTURES.filter(({ expectedFamily }) => expectedFamily !== 'windows')) {
      const profile = createPlatformProfile(fixture.input);
      expect(profile.capabilities['windows_sandbox']).not.toBe('native');
      expect(profile.capabilities['registry_context']).not.toBe('native');
      expect(profile.capabilities['wsl_exec']).toBe('unsupported');
      expect(profile.capabilities['wsl_fs']).toBe('unsupported');
      expect(profile.capabilities['tunnel-client']).not.toBe('native');
    }
  });

  it('keeps the Windows verification gates available as the refactor baseline', async () => {
    const baselinePaths = [
      'tests/release/release-gate.test.ts',
      'tests/packaging/tunnel-stdio-layout.test.ts',
      'apps/desktop/tests/tunnel-controller.test.ts',
      'apps/desktop/tests/tunnel-lock.test.ts',
      'packages/shared/src/secret-protection.test.ts',
      'packages/process/src/windows-process-tree.test.ts',
      '.github/workflows/ci.yml',
    ];

    for (const relativePath of baselinePaths) {
      await expect(access(path.join(repositoryRoot, relativePath))).resolves.toBeUndefined();
    }
  });

  it('uses a host-neutral executable in the shared MCP runtime fixture', () => {
    expect(CORE_TOOL_RUNTIME_FIXTURES.process_start.input.executable).toBe('node');
  });
});
