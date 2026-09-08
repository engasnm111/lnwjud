import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureLinuxAutostart } from '../src/main/linux-autostart.js';

describe('Linux XDG autostart', () => {
  it('writes only the lnwjud entry atomically and escapes executable paths', async (): Promise<void> => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-autostart-'));
    try {
      const file = await configureLinuxAutostart({ configDirectory: root, executablePath: '/opt/lnwjud path/lnwjud', enabled: true });
      await expect(readFile(file, 'utf8')).resolves.toContain('Exec=/opt/lnwjud\\spath/lnwjud');
      await expect(readFile(file, 'utf8')).resolves.toContain('TryExec=/opt/lnwjud\\spath/lnwjud');
      await configureLinuxAutostart({ configDirectory: root, executablePath: '/opt/lnwjud path/lnwjud', enabled: false });
      await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
