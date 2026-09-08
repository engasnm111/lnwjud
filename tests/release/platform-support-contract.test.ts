import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

function capabilityNamesFromSource(source: string): string[] {
  const start = source.indexOf('export const capabilityToolNames');
  const end = source.indexOf('] as const', start);
  expect(start, 'capability tool list must remain discoverable').toBeGreaterThanOrEqual(0);
  expect(end, 'capability tool list must have a closing marker').toBeGreaterThan(start);
  return Array.from(source.slice(start, end).matchAll(/^\s*'([^']+)',\s*$/gm), (match) => match[1]).filter(
    (name): name is string => name !== undefined,
  );
}

describe('native platform support contract', () => {
  it('maps every capability and Windows-sensitive runtime to a truthful disposition', async () => {
    const platformSupport = await readRepositoryFile('docs/architecture/PLATFORM_SUPPORT.md');
    const capabilitySource = await readRepositoryFile('packages/capabilities/src/index.ts');
    const requiredCapabilities = capabilityNamesFromSource(capabilitySource);
    const explicitPlatformSensitiveTools = [
      'tunnel-client',
      'registry_context',
      'windows_environment',
      'windows_sandbox',
      'wsl_exec',
      'wsl_fs',
      'office',
      'office_outlook',
    ];

    expect(platformSupport).toContain('Support matrix');
    expect(platformSupport).toContain('macOS 13');
    expect(platformSupport).toContain('Ubuntu 24.04 LTS');
    expect(platformSupport).toContain('GNOME Wayland');
    expect(platformSupport).toContain('X11');
    expect(platformSupport).toContain('unsupported_platform');
    expect(platformSupport).toContain('dependency_gated');
    expect(platformSupport).toContain('https://github.com/openai/tunnel-client/releases');
    expect(platformSupport).toMatch(/no (?:system|unverified) fallback/i);

    for (const tool of [...requiredCapabilities, ...explicitPlatformSensitiveTools]) {
      const row = platformSupport
        .split('\n')
        .find((line) => line.includes(`| \`${tool}\` |`));
      expect(row, `missing platform disposition for ${tool}`).toBeDefined();
      expect(row).toMatch(/native|dependency_gated|unsupported|preview/i);
    }

    expect(platformSupport).toMatch(/Windows Sandbox[\s\S]*unsupported/i);
    expect(platformSupport).toMatch(/Windows Registry[\s\S]*unsupported/i);
    expect(platformSupport).toMatch(/WSL[\s\S]*unsupported/i);
    expect(platformSupport).toMatch(/office_outlook[\s\S]*unsupported/i);
  });

  it('links the platform contract from the public tool contract and README', async () => {
    const toolContract = await readRepositoryFile('docs/architecture/TOOL_CONTRACT.md');
    const readme = await readRepositoryFile('README.md');

    expect(toolContract).toContain('PLATFORM_SUPPORT.md');
    expect(readme).toContain('PLATFORM_SUPPORT.md');
    expect(readme).toMatch(/macOS|Linux/);
  });

  it('runs the deterministic platform contract on Windows, macOS, and Linux CI', async () => {
    const workflow = await readRepositoryFile('.github/workflows/ci.yml');
    expect(workflow).toContain('name: Native Platform Contract (${{ matrix.name }})');
    expect(workflow).toContain('windows-latest');
    expect(workflow).toContain('macos-15');
    expect(workflow).toContain('ubuntu-24.04');
    expect(workflow).toContain('tests/integration/platform-composition.test.ts');
    expect(workflow).toContain('tests/release/platform-support-contract.test.ts');
  });

  it('keeps WSL catalog entries tied to the Windows-only requirement', async () => {
    const source = await readRepositoryFile('apps/desktop/src/main/tool-catalog/catalog-definitions.ts');
    const wslBlock = /if \(\/\^wsl_\/\.test\(name\)\) \{([\s\S]*?)\n\s*\}/u.exec(source)?.[1] ?? '';
    expect(wslBlock).toContain("ids.add('wsl_runtime')");
    expect(wslBlock).toContain("ids.add('platform_windows')");
  });

  it('keeps Outlook automation tied to the Windows-only requirement', async () => {
    const source = await readRepositoryFile('apps/desktop/src/main/tool-catalog/catalog-definitions.ts');
    const officeBlock = /if \(name === 'office' \|\| \/\^office_\(ppt\|outlook\)\$\/\.test\(name\)[\s\S]*?\n\s*if \(name === 'office_outlook'\)[\s\S]*?\n/iu.exec(source)?.[0] ?? '';
    expect(officeBlock).toContain("ids.add('platform_windows')");
  });

  it('gives SQLite-backed desktop fixtures enough time on every host', async () => {
    const vitestConfig = await readRepositoryFile('apps/desktop/vitest.config.ts');
    expect(vitestConfig).toContain('testTimeout: process.env.CI ? 30_000 : 15_000');
    expect(vitestConfig).toContain('hookTimeout: process.env.CI ? 30_000 : 20_000');
  });
});
