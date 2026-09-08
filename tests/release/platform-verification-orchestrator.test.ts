import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

describe('platform verification orchestrator', () => {
  it('keeps verification target-native and never publishes', async (): Promise<void> => {
    const source = await readFile(path.join(repositoryRoot, 'scripts', 'verify-platform-release.mjs'), 'utf8');
    expect(source).toContain('Platform verification must run on');
    expect(source).toContain('LNWJUD_VERIFY_ARCH');
    expect(source).toContain('shell: false');
    expect(source).toContain('resolveInvocation');
    expect(source).toContain('Invoke the bundled Corepack JavaScript through this exact');
    expect(source).toContain("'--locked'");
    expect(source).toContain('no publication or release action was performed');
    expect(source).not.toMatch(/git\s+(push|tag)\b/);
    expect(source).not.toMatch(/electron-builder[^\n]*(?:--publish\s+always|publish)/i);
  });

  it('keeps macOS and Linux package checks in target-native CI jobs', async (): Promise<void> => {
    const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(workflow).toContain('native-package-verification:');
    expect(workflow).toContain('macos-15');
    expect(workflow).toContain('macos-15-intel');
    expect(workflow).toContain('ubuntu-24.04-arm');
    expect(workflow).toContain('sigstore/cosign-installer@v4.1.2');
    expect(workflow).toContain("cosign-release: 'v3.1.3'");
    expect(workflow).toContain('verify:platform -- --package');
    expect(workflow).toContain('verify:macos-release');
    expect(workflow).toContain('verify:linux-release');
    expect(workflow).not.toMatch(/native-package-verification:[\s\S]*?action-gh-release/i);
  });
});
