import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRuntime } from '../src/main/desktop-services.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const PNG_RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zx0sAAAAASUVORK5CYII=', 'base64');
const PNG_GREEN = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const PNG_BLUE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8zwAAAgEBAN6p6WQAAAAASUVORK5CYII=', 'base64');

beforeEach(() => { vi.stubEnv('LNWJUD_UNRESTRICTED', '1'); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

describe('Desktop Git image diff', () => {
  it('returns before/after image payloads for staged and unstaged Git scopes', async () => {
    const rawRepo = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-git-image-repo-'));
    const rawData = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-git-image-data-'));
    temporaryRoots.push(rawRepo, rawData);
    const repo = await realpath(rawRepo);
    const dataRoot = await realpath(rawData);

    await git(repo, 'init');
    await git(repo, 'config', 'user.email', 'tests@lnwjud.local');
    await git(repo, 'config', 'user.name', 'lnwjud tests');
    await writeFile(path.join(repo, 'image.png'), PNG_RED);
    await git(repo, 'add', 'image.png');
    await git(repo, 'commit', '-m', 'baseline image');

    await writeFile(path.join(repo, 'image.png'), PNG_GREEN);
    await git(repo, 'add', 'image.png');

    const runtime = createDesktopRuntime(dataRoot, { checkpointEncryptionKey: Buffer.alloc(32, 0x42) });
    try {
      const workspaceId = await runtime.ensureDefaultWorkspace(repo);
      const staged = await runtime.services.getGitDiff({ workspaceId, path: 'image.png', staged: true });
      expect(staged.oldImage).toMatchObject({ mimeType: 'image/png', byteLength: PNG_RED.byteLength, dataBase64: PNG_RED.toString('base64') });
      expect(staged.newImage).toMatchObject({ mimeType: 'image/png', byteLength: PNG_GREEN.byteLength, dataBase64: PNG_GREEN.toString('base64') });

      await writeFile(path.join(repo, 'image.png'), PNG_BLUE);
      const unstaged = await runtime.services.getGitDiff({ workspaceId, path: 'image.png', staged: false });
      expect(unstaged.oldImage).toMatchObject({ mimeType: 'image/png', byteLength: PNG_GREEN.byteLength, dataBase64: PNG_GREEN.toString('base64') });
      expect(unstaged.newImage).toMatchObject({ mimeType: 'image/png', byteLength: PNG_BLUE.byteLength, dataBase64: PNG_BLUE.toString('base64') });

      await writeFile(path.join(repo, 'mystery.bin'), PNG_BLUE);
      const sniffed = await runtime.services.getGitDiff({ workspaceId, path: 'mystery.bin', staged: false });
      expect(sniffed.newImage).toMatchObject({ mimeType: 'image/png', dataBase64: PNG_BLUE.toString('base64') });

      await writeFile(path.join(repo, 'large.png'), Buffer.alloc(4 * 1024 * 1024 + 1));
      const oversized = await runtime.services.getGitDiff({ workspaceId, path: 'large.png', staged: false });
      expect(oversized.imagePreviewError).toBe('too_large');
      expect(oversized.newImage).toBeUndefined();
    } finally {
      await runtime.close();
    }
  }, 30_000);
});
