import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { iconCandidatePaths } from '../src/main/window.js';

describe('icon candidate paths', () => {
  it('prefers PNG candidates over .ico on darwin because nativeImage cannot decode .ico there', () => {
    const candidates = iconCandidatePaths(path.join(os.tmpdir(), 'app', 'dist', 'main'), 'darwin');
    const firstIcoIndex = candidates.findIndex((candidate) => candidate.endsWith('.ico'));
    const lastPngIndex = candidates.findLastIndex((candidate) => candidate.endsWith('.png'));

    expect(firstIcoIndex).toBeGreaterThan(lastPngIndex);
    expect(candidates[0]?.endsWith('favicon-32x32.png')).toBe(true);
    expect(candidates.some((candidate) => candidate.endsWith('favicon.ico'))).toBe(true);
  });

  it('keeps the legacy .ico-first order on win32', () => {
    const candidates = iconCandidatePaths(path.join(os.tmpdir(), 'app', 'dist', 'main'), 'win32');

    expect(candidates[0]?.endsWith('favicon.ico')).toBe(true);
    expect(candidates.map((candidate) => path.extname(candidate))).toEqual([
      '.ico', '.ico', '.ico', '.png', '.png', '.png', '.png', '.png', '.png',
    ]);
  });

  it('resolves every candidate inside the app directory tree without leaving it', () => {
    const base = path.join(os.tmpdir(), 'app', 'dist', 'main');
    for (const candidate of iconCandidatePaths(base, 'darwin')) {
      expect(candidate.startsWith(path.resolve(base, '..', '..'))).toBe(true);
      expect(fs.existsSync(candidate)).toBe(false);
    }
  });
});
