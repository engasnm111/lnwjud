import { rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const outputPath = process.argv[2];
if (typeof outputPath !== 'string' || outputPath.trim().length === 0) throw new Error('A generated TypeScript output directory is required');
const absoluteOutputPath = path.resolve(outputPath);
await Promise.all([
  rm(absoluteOutputPath, { recursive: true, force: true }),
  rm(path.join(path.dirname(absoluteOutputPath), 'tsconfig.tsbuildinfo'), { force: true }),
]);
