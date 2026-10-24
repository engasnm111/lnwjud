import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { verifyUpdateWorkerArtifacts } from './verify-update-worker-artifacts.mjs';

if (process.platform === 'win32') {
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const identity = await verifyUpdateWorkerArtifacts({
    directory: path.join(desktopRoot, 'build/update-worker'),
    compiledBundlePath: path.join(desktopRoot, 'dist/main/main.js'),
  });
  process.stdout.write(`${JSON.stringify({ ...identity, installationEffects: false })}\n`);
}
