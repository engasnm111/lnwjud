import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LinuxOfficeCapabilityBackend } from './linux-office-backend.js';

describe('LinuxOfficeCapabilityBackend', () => {
  it('reports LibreOffice as unavailable without turning a missing dependency into readiness', async (): Promise<void> => {
    const backend = new LinuxOfficeCapabilityBackend({ executableExists: (): boolean => false });

    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: {
        available: false,
        ready: false,
        backend: 'libreoffice-uno',
        reason: 'dependency_missing',
        dependencyState: 'missing',
      },
    });
  });

  it('exposes dependency presence separately from the unimplemented automation bridge', async (): Promise<void> => {
    const backend = new LinuxOfficeCapabilityBackend({ executableExists: (executable: string): boolean => executable === 'soffice' });

    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { available: true, ready: false, reason: 'provider_not_implemented', dependencyState: 'present' },
    });
    await expect(backend.execute({ action: 'read', app: 'soffice' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_PLATFORM' },
    });
  });

  it('cuts unsupported Office applications and requires confirmation for mutations', async (): Promise<void> => {
    const backend = new LinuxOfficeCapabilityBackend({ executableExists: (): boolean => true });

    await expect(backend.execute({ action: 'read', app: 'excel' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_PLATFORM' },
    });
    await expect(backend.execute({ action: 'write', app: 'soffice' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_REQUIRED' },
    });
  });

  it('rejects excessive path targets instead of silently dropping them', async (): Promise<void> => {
    const backend = new LinuxOfficeCapabilityBackend({ executableExists: (): boolean => true });
    const result = await backend.execute({ action: 'merge', app: 'soffice', merge_paths: Array.from({ length: 17 }, (_, index) => `report-${index}.ods`) });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('keeps Office file paths inside the Active Project before dependency dispatch', async (): Promise<void> => {
    const root = await mkdtemp(path.join(process.cwd(), '.lnwjud-linux-office-'));
    const outside = await mkdtemp(path.join(process.cwd(), '.lnwjud-linux-office-outside-'));
    const insideFile = path.join(root, 'input.ods');
    const outsideFile = path.join(outside, 'outside.ods');
    try {
      await writeFile(insideFile, 'fixture');
      await writeFile(outsideFile, 'fixture');
      const portable = (value: string): string => value.replaceAll('\\', '/');
      const rootInput = portable(path.relative(process.cwd(), root));
      const insideInput = portable(path.relative(process.cwd(), insideFile));
      const outsideInput = portable(path.relative(process.cwd(), outsideFile));
      const backend = new LinuxOfficeCapabilityBackend({
        executableExists: (): boolean => true,
        allowedRootsProvider: async (): Promise<readonly string[]> => [rootInput],
      });

      await expect(backend.execute({ action: 'read', file_path: insideInput })).resolves.toMatchObject({
        ok: false,
        error: { code: 'UNSUPPORTED_PLATFORM' },
      });
      await expect(backend.execute({ action: 'read', file_path: outsideInput })).resolves.toMatchObject({
        ok: false,
        error: { code: 'PATH_OUTSIDE_WORKSPACE' },
      });
      const portableForeign = await backend.execute({ action: 'read', file_path: 'C:\\Users\\alice\\report.ods' });
      expect(portableForeign).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
