import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(desktopRoot, 'build', 'packaged-runtime-evidence.json');

const packagedRuntimeFiles = Object.freeze([
  { name: 'lnwjud.exe', relativePath: 'lnwjud.exe' },
  { name: 'lnwjud-mcp-stdio.cjs', relativePath: 'lnwjud-mcp-stdio.cjs' },
  { name: 'lnwjud-mcp-stdio.cmd', relativePath: 'lnwjud-mcp-stdio.cmd' },
  { name: 'lnwjud-node.exe', relativePath: 'lnwjud-node.exe' },
  { name: 'rg.exe', relativePath: 'resources/runtime-tools/ripgrep/rg.exe' },
  { name: 'tunnel-client.exe', relativePath: 'resources/tunnel-client/tunnel-client.exe' },
]);

export default async function capturePackagedRuntimeEvidence(context) {
  if (context?.electronPlatformName !== 'win32') return;
  const appOutDir = context.appOutDir;
  if (typeof appOutDir !== 'string' || appOutDir.length === 0) throw new Error('Windows packaged app directory is unavailable');

  const files = [];
  for (const entry of packagedRuntimeFiles) {
    const absolutePath = path.join(appOutDir, ...entry.relativePath.split('/'));
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) throw new Error(`Required packaged runtime file is not a file: ${entry.relativePath}`);
    files.push({
      name: entry.name,
      relativePath: entry.relativePath,
      sizeBytes: metadata.size,
      sha256: await sha256File(absolutePath),
    });
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, platform: 'win32', arch: process.arch, files }, null, 2)}\n`, 'utf8');
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}
