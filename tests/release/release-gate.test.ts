import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

describe('MVP release verification gate', () => {
  it('runs the required Windows verification stages in order and fails fast', async () => {
    const script = await readFile(path.join(repositoryRoot, 'scripts', 'verify-release.ps1'), 'utf8');
    const stages = [
      'install --frozen-lockfile',
      'lint',
      'typecheck',
      'test',
      'test:integration',
      'test:e2e',
      'build',
      'test:packaging',
      'package:windows',
    ];
    let previousIndex = -1;
    for (const stage of stages) {
      const index = script.indexOf(stage);
      expect(index, `missing release stage: ${stage}`).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(script).toContain('if ($LASTEXITCODE -ne 0)');
    expect(script).toContain('git diff --check');
  });

  it('documents the acceptance evidence and clean-machine limitations', async () => {
    const checklist = await readFile(path.join(repositoryRoot, 'docs', 'development', 'RELEASE_CHECKLIST.md'), 'utf8');
    for (const evidence of [
      'traversal',
      'junction',
      'secret',
      'MCP local HTTP',
      'process ownership',
      'output limit',
      'fake Codex',
      'packaged-app smoke',
      'real Codex',
      'git diff --check',
    ]) {
      expect(checklist.toLowerCase()).toContain(evidence.toLowerCase());
    }
  });
});
