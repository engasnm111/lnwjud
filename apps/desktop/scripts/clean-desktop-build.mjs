import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// TypeScript does not remove emitted files when a source module is deleted. A
// clean main/preload output is therefore part of the packaging security
// boundary: stale Windows secret modules must not survive into a new ASAR.
await Promise.all([
  rm(path.join(desktopRoot, 'dist', 'main'), { recursive: true, force: true }),
  rm(path.join(desktopRoot, 'dist', 'preload'), { recursive: true, force: true }),
  rm(path.join(desktopRoot, 'tsconfig.main.tsbuildinfo'), { force: true }),
  rm(path.join(desktopRoot, 'tsconfig.renderer.tsbuildinfo'), { force: true }),
]);
