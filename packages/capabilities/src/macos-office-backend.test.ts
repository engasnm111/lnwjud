import { describe, expect, it } from 'vitest';
import { MacosOfficeCapabilityBackend } from './macos-office-backend.js';

describe('MacosOfficeCapabilityBackend', () => {
  it('reports Microsoft Office as unavailable when no app bundle is present', async (): Promise<void> => {
    const backend = new MacosOfficeCapabilityBackend({ applicationExists: (): boolean => false });

    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: {
        available: false,
        ready: false,
        backend: 'apple-events-office',
        reason: 'dependency_missing',
        dependencyState: 'missing',
      },
    });
  });

  it('keeps installed Office distinct from an Apple Events bridge', async (): Promise<void> => {
    const backend = new MacosOfficeCapabilityBackend({
      applicationExists: (applicationPath: string): boolean => applicationPath.endsWith('Microsoft Excel.app'),
    });

    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { available: true, ready: false, reason: 'provider_not_implemented', dependencyState: 'present' },
    });
    await expect(backend.execute({ action: 'read', app: 'excel' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_PLATFORM' },
    });
  });

  it('cuts unsupported apps and protects mutations with explicit confirmation', async (): Promise<void> => {
    const backend = new MacosOfficeCapabilityBackend({ applicationExists: (): boolean => true });

    await expect(backend.execute({ action: 'read', app: 'libreoffice' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_PLATFORM' },
    });
    await expect(backend.execute({ action: 'replace', app: 'excel' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_REQUIRED' },
    });
  });

  it('supports dry-run without requiring Office installation', async (): Promise<void> => {
    const backend = new MacosOfficeCapabilityBackend({ applicationExists: (): boolean => false });

    await expect(backend.execute({ action: 'write', dry_run: true })).resolves.toMatchObject({
      ok: true,
      value: { dry_run: true, capability: 'office', platform: 'darwin', action: 'write' },
    });
  });
});
