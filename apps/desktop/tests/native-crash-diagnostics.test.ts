import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureNativeCrashDiagnostics, pruneNativeCrashDumps, readNativeCrashDumpMetadata } from '../src/main/native-crash-diagnostics.js';

const roots: string[] = [];
const tempRoot = (): string => { const root = mkdtempSync(path.join(tmpdir(), 'lnwjud-crash-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('native crash diagnostics', () => {
  it('keeps Crashpad local-only and bounds retained dumps', () => {
    const root = tempRoot();
    const start = vi.fn();
    configureNativeCrashDiagnostics(root, '5.3.0', { start }, vi.fn(), Date.now());
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ uploadToServer: false, compress: false }));

    const directory = path.join(root, 'crash-dumps'); mkdirSync(directory, { recursive: true });
    const now = Date.now();
    for (let index = 0; index < 22; index += 1) {
      const file = path.join(directory, String(index).padStart(2, '0') + '.dmp'); writeFileSync(file, 'dump');
      const modified = new Date(now - index * 1_000); utimesSync(file, modified, modified);
    }
    const old = path.join(directory, 'old.dmp'); writeFileSync(old, 'old');
    const oldDate = new Date(now - 31 * 24 * 60 * 60 * 1000); utimesSync(old, oldDate, oldDate);
    pruneNativeCrashDumps(directory, now);
    const metadata = readNativeCrashDumpMetadata(root, now);
    expect(metadata.count).toBe(20);
    expect(metadata).not.toHaveProperty('directory');
    expect(metadata.dumps.some((dump) => dump.fileName === 'old.dmp')).toBe(false);
  });
});
