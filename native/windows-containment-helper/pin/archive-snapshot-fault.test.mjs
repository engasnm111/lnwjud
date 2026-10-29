import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { buildContainmentPin } from './build.mjs';

test('initialization faults delete only the created spool or report retained cleanup',
  { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-archive-test-addon-'));
    try {
      const addon = buildContainmentPin(root, true);
      const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./archive-snapshot-fault-child.mjs', import.meta.url)), addon],
        { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      assert.equal(child.status, 0, child.stderr || child.error?.message);
    } finally {
      for (const name of ['lnwjud-containment-pin-test.node', 'pin.obj', 'pin.lib', 'pin.exp'])
        await unlink(path.join(root, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(root);
    }
  });
