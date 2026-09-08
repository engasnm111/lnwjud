import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

describe('native platform documentation contract', () => {
  it('documents install, tunnel, permission, session, and unsupported-feature boundaries', async (): Promise<void> => {
    const [macos, linux, provider, readme] = await Promise.all([
      read('docs/INSTALL_MACOS.md'),
      read('docs/INSTALL_LINUX.md'),
      read('docs/NATIVE_PROVIDER_DEVELOPMENT.md'),
      read('README.md'),
    ]);
    for (const source of [macos, linux]) {
      expect(source).toMatch(/SHA-?256|SHA256/i);
      expect(source).toContain('tunnel-client');
      expect(source).toMatch(/STDIO|MCP/);
      expect(source).toMatch(/permission|สิทธิ์/i);
      expect(source).toContain('unsupported_platform');
      expect(source).toMatch(/runtime key|API key|keyring|Keychain/i);
    }
    expect(macos).toMatch(/Accessibility|Screen Recording|Microphone/);
    expect(linux).toMatch(/Wayland|X11|portal|PipeWire|AT-SPI/);
    expect(provider).toContain('provider_not_implemented');
    expect(provider).toContain('--locked');
    expect(provider).toMatch(/no shell|no arbitrary shell/i);
    expect(readme).toContain('INSTALL_MACOS.md');
    expect(readme).toContain('INSTALL_LINUX.md');
  });

  it('does not embed developer paths, secret values, or AV exclusions', async (): Promise<void> => {
    const sources = await Promise.all([
      read('docs/INSTALL_MACOS.md'),
      read('docs/INSTALL_LINUX.md'),
      read('docs/NATIVE_PROVIDER_DEVELOPMENT.md'),
    ]);
    const combined = sources.join('\n');
    expect(combined).not.toMatch(/[A-Z]:\\Users\\/i);
    expect(combined).not.toMatch(/C:\\(?:Users|Windows)\\/i);
    expect(combined).not.toMatch(/(?:api[_ -]?key|token|password)\s*[:=]\s*[A-Za-z0-9_-]{16,}/i);
    expect(combined).not.toMatch(/AV exclusion|Defender exclusion|disable antivirus/i);
  });
});
