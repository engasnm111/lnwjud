import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readRegularSecret, writeSecretAtomically } from '../src/main/secret-file.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('atomically replaces a secret and leaves no temporary files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-secret-'));
  roots.push(root);
  const file = path.join(root, 'secret');
  await writeSecretAtomically(file, 'old encrypted value');
  await writeSecretAtomically(file, 'new encrypted value');
  expect(await readRegularSecret(file)).toBe('new encrypted value');
  expect(await readdir(root)).toEqual(['secret']);
  if (process.platform !== 'win32') expect((await lstat(file)).mode & 0o777).toBe(0o600);
});

it('refuses symlink reads and replaces the link without modifying its target', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-secret-link-'));
  roots.push(root);
  const file = path.join(root, 'secret');
  const target = path.join(root, 'outside');
  await writeFile(target, 'untouched');
  try { await symlink(target, file, 'file'); } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; }
    throw error;
  }
  await expect(readRegularSecret(file)).rejects.toThrow('not a regular file');
  await writeSecretAtomically(file, 'encrypted replacement');
  expect(await readFile(target, 'utf8')).toBe('untouched');
  expect((await lstat(file)).isSymbolicLink()).toBe(false);
  expect(await readRegularSecret(file)).toBe('encrypted replacement');
});
