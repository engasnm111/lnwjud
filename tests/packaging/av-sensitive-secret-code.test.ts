import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

async function collectFiles(root: string): Promise<string[]> {
  try {
    await access(root);
  } catch {
    return [];
  }
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  }
  await visit(root);
  return result;
}

describe('AV-sensitive secret runtime contract', () => {
  it('removes the legacy JavaScript DPAPI/PowerShell secret modules and imports', async () => {
    const sourceRoots = [
      path.join(repositoryRoot, 'apps', 'cli', 'src'),
      path.join(repositoryRoot, 'apps', 'desktop', 'src', 'main'),
      path.join(repositoryRoot, 'packages', 'shared', 'src'),
      path.join(repositoryRoot, 'packages', 'storage', 'src'),
    ];
    const sourceFiles = (await Promise.all(sourceRoots.map(collectFiles))).flat()
      .filter((filePath) => /\.(?:js|mjs|ts|tsx)$/.test(filePath));
    const violations: string[] = [];
    const forbidden = [
      /windows-dpapi/i,
      /tunnel-secret-dpapi/i,
      /loadCheckpointEncryptionKey/,
      /protectWithWindowsDpapi|unprotectWithWindowsDpapi/,
      /ConvertTo-SecureString|ConvertFrom-SecureString/,
    ];

    for (const filePath of sourceFiles) {
      const source = await readFile(filePath, 'utf8');
      if (forbidden.some((pattern) => pattern.test(source))) violations.push(path.relative(repositoryRoot, filePath));
    }

    expect(violations).toEqual([]);
    await expect(access(path.join(repositoryRoot, 'packages', 'shared', 'src', 'windows-dpapi.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(repositoryRoot, 'apps', 'desktop', 'src', 'main', 'tunnel-secret-dpapi.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not leave legacy secret code in compiled workspace output', async () => {
    const compiledRoots = [
      path.join(repositoryRoot, 'apps', 'cli', 'dist'),
      path.join(repositoryRoot, 'apps', 'desktop', 'dist', 'main'),
      path.join(repositoryRoot, 'packages', 'shared', 'dist'),
      path.join(repositoryRoot, 'packages', 'storage', 'dist'),
    ];
    const outputFiles = (await Promise.all(compiledRoots.map(collectFiles))).flat()
      .filter((filePath) => /\.(?:js|cjs|mjs)$/.test(filePath));
    const violations: string[] = [];
    const forbidden = /windows-dpapi|tunnel-secret-dpapi|loadCheckpointEncryptionKey|ConvertTo-SecureString|ConvertFrom-SecureString/gi;

    for (const filePath of outputFiles) {
      const source = await readFile(filePath, 'utf8');
      if (forbidden.test(source)) violations.push(path.relative(repositoryRoot, filePath));
      forbidden.lastIndex = 0;
    }

    expect(violations).toEqual([]);
  });

  it('does not pass parent credential environment variables to bundled tool verification', async () => {
    const scripts = [
      path.join(repositoryRoot, 'apps', 'desktop', 'scripts', 'prepare-tunnel-client.mjs'),
      path.join(repositoryRoot, 'apps', 'desktop', 'scripts', 'prepare-runtime-tools.mjs'),
    ];
    for (const scriptPath of scripts) {
      const source = await readFile(scriptPath, 'utf8');
      expect(source).toContain('function sanitizedEnvironment');
      expect(source).toContain('env: sanitizedEnvironment()');
      expect(source).not.toContain('env: process.env');
    }
  });
});
