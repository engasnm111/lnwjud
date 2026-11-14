import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const launcher = await readFile(path.resolve(import.meta.dirname, '../../../native/windows-update-launcher/Program.cs'), 'utf8');

describe('Windows update launcher startup contract', () => {
  it('falls back to the verified installed slot whenever the service launch cannot be verified', () => {
    // v5.9.2 shipped a launcher that only fell back for an "unmanaged" footprint, so an
    // all-users installation without an enrolled baseline stopped at UPDATE_LAUNCH_UNVERIFIED.
    expect(launcher).not.toContain('InspectFootprint().Kind == "unmanaged"');
    const managed = launcher.indexOf('return await LaunchManaged(digest, args)');
    const fallback = launcher.indexOf('return await LaunchManual(root, args)');
    expect(managed).toBeGreaterThan(0);
    expect(fallback).toBeGreaterThan(managed);
    expect(launcher.slice(managed, fallback)).toContain('catch (Exception managed)');
  });

  it('verifies the slot manifest and image hash before starting the fallback slot', () => {
    const manual = launcher.slice(launcher.indexOf('private static async Task<int> LaunchManual'));
    expect(manual).toContain('Path.Combine(root, "slots", "A")');
    expect(manual).toContain('UPDATE_MANUAL_SLOT_INVALID');
    expect(manual).toContain('SHA256.HashData(executable)');
    expect(manual).toContain('GetProperty("sha256")');
    expect(manual).toContain('GetProperty("sizeBytes")');
  });
});
