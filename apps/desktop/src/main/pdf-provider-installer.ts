import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import extractZip from 'extract-zip';

export interface PdfProviderPackage {
  readonly version: string;
  readonly popplerVersion: string;
  readonly sourceUrl: string;
  readonly archiveSha256: string;
}

export interface InstalledPdfProvider {
  readonly providerPath: string;
  readonly version: string;
  readonly sourceUrl: string;
  readonly archiveSha256: string;
  readonly reused: boolean;
}

interface DownloadResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PdfProviderInstallerOptions {
  readonly package?: PdfProviderPackage;
  readonly fetchImpl?: (url: string) => Promise<DownloadResponse>;
  readonly extractImpl?: (archivePath: string, options: { readonly dir: string }) => Promise<void>;
}

export const DEFAULT_PDF_PROVIDER_PACKAGE: PdfProviderPackage = Object.freeze({
  version: '26.02.0-0',
  popplerVersion: '26.02.0',
  sourceUrl: 'https://github.com/oschwartz10612/poppler-windows/releases/download/v26.02.0-0/Release-26.02.0-0.zip',
  archiveSha256: '993e4a94376ed712fafc7058d724ea0b943d118bbd2305cd9ed55174eb85cda5',
});

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const activeInstalls = new Map<string, Promise<InstalledPdfProvider>>();

export function installPdfProvider(dataPath: string, options: PdfProviderInstallerOptions = {}): Promise<InstalledPdfProvider> {
  const packageInfo = options.package ?? DEFAULT_PDF_PROVIDER_PACKAGE;
  const installKey = [path.resolve(dataPath), packageInfo.version, packageInfo.sourceUrl, packageInfo.archiveSha256.toLowerCase()].join('\0');
  const activeInstall = activeInstalls.get(installKey);
  if (activeInstall !== undefined) return activeInstall;
  const operation = installPdfProviderOnce(dataPath, { ...options, package: packageInfo }).finally(() => {
    activeInstalls.delete(installKey);
  });
  activeInstalls.set(installKey, operation);
  return operation;
}

async function installPdfProviderOnce(dataPath: string, options: PdfProviderInstallerOptions): Promise<InstalledPdfProvider> {
  const packageInfo = options.package ?? DEFAULT_PDF_PROVIDER_PACKAGE;
  const fetchImpl = options.fetchImpl ?? (async (url: string): Promise<DownloadResponse> => fetch(url));
  const extractImpl = options.extractImpl ?? extractZip;
  const providerRoot = path.join(dataPath, 'runtime-tools', 'pdf-provider');
  const versionRoot = path.join(providerRoot, packageInfo.version);
  const providerPath = path.join(versionRoot, 'Library', 'bin', 'pdftotext.exe');

  if (await isRegularFile(providerPath)) {
    return { providerPath, version: packageInfo.version, sourceUrl: packageInfo.sourceUrl, archiveSha256: packageInfo.archiveSha256, reused: true };
  }

  await mkdir(providerRoot, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(providerRoot, `.install-${packageInfo.version}-`));
  try {
    const response = await fetchImpl(packageInfo.sourceUrl);
    if (!response.ok) throw new Error(`PDF provider download failed: HTTP ${response.status} ${response.statusText}`.trim());
    const declaredSize = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredSize) && declaredSize > MAX_ARCHIVE_BYTES) throw new Error('PDF provider archive is larger than the allowed download limit');

    const archiveBytes = Buffer.from(await response.arrayBuffer());
    if (archiveBytes.byteLength === 0 || archiveBytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('PDF provider archive size is invalid');
    const actualSha256 = createHash('sha256').update(archiveBytes).digest('hex');
    if (actualSha256 !== packageInfo.archiveSha256.toLowerCase()) {
      throw new Error(`PDF provider integrity check failed: expected ${packageInfo.archiveSha256}, got ${actualSha256}`);
    }

    const archivePath = path.join(stagingRoot, `poppler-${packageInfo.version}.zip`);
    const extractRoot = path.join(stagingRoot, 'extracted');
    await writeFile(archivePath, archiveBytes);
    await mkdir(extractRoot, { recursive: true });
    await extractImpl(archivePath, { dir: extractRoot });

    const extractedRoot = path.join(extractRoot, `poppler-${packageInfo.popplerVersion}`);
    const extractedProvider = path.join(extractedRoot, 'Library', 'bin', 'pdftotext.exe');
    if (!await isRegularFile(extractedProvider)) throw new Error('Downloaded Poppler archive does not contain Library\\bin\\pdftotext.exe');

    await rm(versionRoot, { recursive: true, force: true });
    await rename(extractedRoot, versionRoot);
    await writeFile(path.join(versionRoot, '.lnwjud-provider.json'), `${JSON.stringify({
      provider: 'pdftotext',
      version: packageInfo.version,
      sourceUrl: packageInfo.sourceUrl,
      archiveSha256: packageInfo.archiveSha256,
    }, null, 2)}\n`, 'utf8');

    if (!await isRegularFile(providerPath)) throw new Error('PDF provider installation completed without pdftotext.exe');
    return { providerPath, version: packageInfo.version, sourceUrl: packageInfo.sourceUrl, archiveSha256: packageInfo.archiveSha256, reused: false };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function readPdfProviderInstallEvidence(providerPath: string): Promise<Readonly<Record<string, unknown>> | null> {
  const evidencePath = path.join(path.dirname(path.dirname(path.dirname(providerPath))), '.lnwjud-provider.json');
  try {
    return JSON.parse(await readFile(evidencePath, 'utf8')) as Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}
