import { randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink, writeFile } from 'node:fs/promises';

export async function readRegularSecret(filePath: string): Promise<string> {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Secret path is not a regular file');
  const handle = await open(filePath, 'r');
  try {
    const opened = await handle.stat();
    const current = await lstat(filePath);
    if (!current.isFile() || current.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino
      || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('Secret path changed while opening');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

export async function writeSecretAtomically(filePath: string, encrypted: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, encrypted, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // Rename replaces a final symlink instead of writing through to its target.
    await rename(temporary, filePath);
  } finally { await unlink(temporary).catch(() => undefined); }
}
