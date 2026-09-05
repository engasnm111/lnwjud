import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY } from './task-ownership.js';
import { NativeCapabilityPathPolicy } from './native-path-policy.js';

const roots: string[] = [];
const fullBypass = { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' } as const;

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `lnwjud-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('NativeCapabilityPathPolicy', () => {
  it('keeps output paths inside the Active Project and gives trusted metadata precedence over fallback roots', async () => {
    const fallbackRoot = await tempRoot('native-fallback');
    const activeRoot = await tempRoot('native-active');
    const policy = new NativeCapabilityPathPolicy('screen_record', ['output_path'], { allowedRootsProvider: async () => [fallbackRoot] });

    await expect(policy.assertAllowed({ output_path: path.join(fallbackRoot, 'capture.mp4') })).resolves.toEqual({ ok: true, value: undefined });
    await expect(policy.assertAllowed({
      output_path: path.join(fallbackRoot, 'capture.mp4'),
      metadata: { [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: activeRoot },
    })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    await expect(policy.assertAllowed({
      output_path: path.join(activeRoot, 'capture.mp4'),
      metadata: { [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: activeRoot },
    })).resolves.toEqual({ ok: true, value: undefined });
  });

  it('lets Full Bypass leave the project root without skipping canonical path validation', async () => {
    const root = await tempRoot('native-bypass');
    const outside = await tempRoot('native-outside');
    const policy = new NativeCapabilityPathPolicy('audio', ['file_path', 'output_path'], { allowedRootsProvider: async () => [root] });
    const playable = path.join(outside, 'sound.wav');
    await writeFile(playable, 'fixture', 'utf8');

    await expect(policy.assertAllowed({ file_path: playable }, fullBypass)).resolves.toEqual({ ok: true, value: undefined });
    await expect(policy.assertAllowed({ file_path: path.join(outside, 'missing.wav') }, fullBypass)).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    });
  });

  it('requires a real canonical parent for future output files', async () => {
    const root = await tempRoot('native-parent');
    const policy = new NativeCapabilityPathPolicy('screen_record', ['output_path'], { allowedRootsProvider: async () => [root] });
    await mkdir(path.join(root, 'captures'));

    await expect(policy.assertAllowed({ output_path: path.join(root, 'captures', 'ok.mp4') })).resolves.toEqual({ ok: true, value: undefined });
    await expect(policy.assertAllowed({ output_path: path.join(root, 'missing', 'bad.mp4') })).resolves.toMatchObject({
      ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' },
    });
  });
});
