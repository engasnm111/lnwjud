import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const internalProcessSources = [
  'apps/desktop/src/main/tunnel-controller.ts',
  'apps/desktop/src/main/tunnel-lock.ts',
  'apps/desktop/src/main/portable-update.ts',
  'packages/capabilities/src/shell-backend.ts',
  'packages/capabilities/src/durable-shell-task-store.ts',
  'packages/capabilities/src/windows-bridge.ts',
  'packages/capabilities/src/event-log-backend.ts',
  'packages/capabilities/src/browser-cdp-protocol.ts',
  'packages/process/src/process-manager.ts',
  'packages/git/src/git-runner.ts',
  'packages/search/src/ripgrep-adapter.ts',
] as const;

const builtInPowerShellRuntimeSources = [
  'apps/desktop/src/main/tunnel-controller.ts',
  'apps/desktop/src/main/tunnel-lock.ts',
  'apps/desktop/src/main/portable-update.ts',
  'packages/capabilities/src/event-log-backend.ts',
] as const;

describe('Windows internal process visibility and compatibility', () => {
  it('keeps internal child console windows hidden so normal work does not flash CMD/PowerShell windows', async () => {
    for (const relativePath of internalProcessSources) {
      const source = await readFile(path.resolve(repositoryRoot, relativePath), 'utf8');
      expect(source, relativePath).not.toContain('windowsHide: false');
      expect(source, relativePath).toContain('windowsHide: true');
    }
  });

  it('uses built-in Windows PowerShell for product-internal Windows plumbing instead of requiring PowerShell 7', async () => {
    for (const relativePath of builtInPowerShellRuntimeSources) {
      const source = await readFile(path.resolve(repositoryRoot, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/spawn\(['"]pwsh(?:\.exe)?['"]/i);
      expect(source, relativePath).not.toMatch(/execFile\(['"]pwsh(?:\.exe)?['"]/i);
    }
  });
});
