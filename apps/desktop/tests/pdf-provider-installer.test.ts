import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installPdfProvider, readPdfProviderInstallEvidence, type PdfProviderPackage } from '../src/main/pdf-provider-installer.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PDF provider installer', () => {
  it('downloads a pinned archive, verifies SHA-256, installs Poppler, and reuses the verified path', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-pdf-provider-'));
    roots.push(dataPath);
    const archive = Buffer.from('test poppler archive');
    const packageInfo = testPackage(archive);
    let downloads = 0;
    let extracts = 0;
    const options = {
      package: packageInfo,
      fetchImpl: async (): Promise<ReturnType<typeof response>> => {
        downloads += 1;
        return response(archive);
      },
      extractImpl: async (_archivePath: string, options: { readonly dir: string }): Promise<void> => {
        extracts += 1;
        const bin = path.join(options.dir, `poppler-${packageInfo.popplerVersion}`, 'Library', 'bin');
        await mkdir(bin, { recursive: true });
        await writeFile(path.join(bin, 'pdftotext.exe'), 'fixture');
      },
    };

    const first = await installPdfProvider(dataPath, options);
    expect(first.reused).toBe(false);
    expect(first.providerPath).toBe(path.join(dataPath, 'runtime-tools', 'pdf-provider', packageInfo.version, 'Library', 'bin', 'pdftotext.exe'));
    expect(await readFile(first.providerPath, 'utf8')).toBe('fixture');
    expect(await readPdfProviderInstallEvidence(first.providerPath)).toMatchObject({ provider: 'pdftotext', version: packageInfo.version, archiveSha256: packageInfo.archiveSha256 });

    const second = await installPdfProvider(dataPath, options);
    expect(second.reused).toBe(true);
    expect(downloads).toBe(1);
    expect(extracts).toBe(1);
  });

  it('coalesces concurrent install requests for the same pinned provider', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-pdf-provider-concurrent-'));
    roots.push(dataPath);
    const archive = Buffer.from('concurrent poppler archive');
    const packageInfo = testPackage(archive);
    let downloads = 0;
    let extracts = 0;
    const options = {
      package: packageInfo,
      fetchImpl: async (): Promise<ReturnType<typeof response>> => {
        downloads += 1;
        return response(archive);
      },
      extractImpl: async (_archivePath: string, options: { readonly dir: string }): Promise<void> => {
        extracts += 1;
        const bin = path.join(options.dir, `poppler-${packageInfo.popplerVersion}`, 'Library', 'bin');
        await mkdir(bin, { recursive: true });
        await writeFile(path.join(bin, 'pdftotext.exe'), 'fixture');
      },
    };

    const first = installPdfProvider(dataPath, options);
    const second = installPdfProvider(dataPath, options);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.providerPath).toBe(secondResult.providerPath);
    expect(downloads).toBe(1);
    expect(extracts).toBe(1);
  });

  it('refuses an archive whose SHA-256 does not match the pinned manifest', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-pdf-provider-'));
    roots.push(dataPath);
    const packageInfo = { ...testPackage(Buffer.from('expected')), archiveSha256: '0'.repeat(64) };

    await expect(installPdfProvider(dataPath, {
      package: packageInfo,
      fetchImpl: async () => response(Buffer.from('tampered')),
      extractImpl: async () => { throw new Error('must not extract'); },
    })).rejects.toThrow('integrity check failed');
  });
});

function testPackage(archive: Buffer): PdfProviderPackage {
  return {
    version: 'test-1',
    popplerVersion: 'test-core',
    sourceUrl: 'https://example.invalid/poppler.zip',
    archiveSha256: createHash('sha256').update(archive).digest('hex'),
  };
}

function response(body: Buffer): { readonly ok: true; readonly status: 200; readonly statusText: 'OK'; readonly headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> } {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? String(body.byteLength) : null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  };
}
