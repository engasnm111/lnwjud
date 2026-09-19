import { createHash } from 'node:crypto';

export type ContextDiscoveryMode = 'automatic' | 'explicit';
export type ContextEconomyTier = 0 | 1 | 2 | 3;
export type ContextPathKind = 'binary' | 'ignored' | 'generated' | 'metadata' | 'source';

export interface ContextPathClassification {
  readonly path: string;
  readonly kind: ContextPathKind;
  readonly tier: ContextEconomyTier;
  readonly discoverable: boolean;
  readonly reason: string;
}

export interface ContextTextSummary {
  readonly byteLength: number;
  readonly lineCount: number;
  readonly imports: readonly string[];
  readonly exports: readonly string[];
  readonly symbols: readonly string[];
}

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'artifacts',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'cache',
  '.codegraph',
  '.local-artifacts',
  '.pnpm-store',
  '.serena',
  '.superpowers',
  '.worktrees',
  'playwright-report',
  'test-results',
  'vendor',
  'target',
  'bin',
  'obj',
  '.venv',
  'venv',
  '__pycache__',
]);

const BINARY_EXTENSIONS = new Set([
  '.7z', '.avi', '.bin', '.class', '.db', '.dll', '.dmg', '.exe', '.gif', '.gz', '.ico', '.jpeg', '.jpg', '.png',
  '.m4a', '.mkv', '.mov', '.mp3', '.mp4', '.pdf', '.pyc', '.rar', '.sqlite', '.sqlite3', '.tar', '.ttf',
  '.wasm', '.webp', '.woff', '.woff2', '.zip',
]);

const METADATA_FILES = new Set([
  'cargo.lock',
  'composer.lock',
  'go.sum',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'yarn.lock',
]);

export const DEFAULT_CONTEXT_IGNORE_GLOBS: readonly string[] = [
  '!**/node_modules/**',
  '!**/.git/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/artifacts/**',
  '!**/coverage/**',
  '!**/.next/**',
  '!**/.turbo/**',
  '!**/.cache/**',
  '!**/cache/**',
  '!**/.codegraph/**',
  '!**/.local-artifacts/**',
  '!**/.pnpm-store/**',
  '!**/.serena/**',
  '!**/.superpowers/**',
  '!**/.worktrees/**',
  '!**/playwright-report/**',
  '!**/test-results/**',
  '!**/vendor/**',
  '!**/target/**',
  '!**/bin/**',
  '!**/obj/**',
  '!**/.venv/**',
  '!**/venv/**',
  '!**/__pycache__/**',
  '!**/*.map',
  '!**/*.min.js',
  '!**/*.min.css',
  '!**/*.bundle.js',
  '!**/*.bundle.css',
  '!**/*.generated.*',
  '!**/*.generated',
  '!**/*.gen.*',
];

const GENERATED_FILE_PATTERNS = [
  /(?:^|[._-])generated(?:[._-]|$)/i,
  /(?:^|[._-])autogen(?:[._-]|$)/i,
  /(?:^|[._-])auto-generated(?:[._-]|$)/i,
  /(?:^|[._-])bundle(?:[._-]|$)/i,
  /\.min\.(?:js|css)$/i,
  /\.map$/i,
];

const unique = (values: readonly string[]): string[] => [...new Set(values.filter((value) => value.length > 0))];

export function normalizeContextPath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function classifyContextPath(filePath: string, mode: ContextDiscoveryMode = 'automatic'): ContextPathClassification {
  const normalizedPath = normalizeContextPath(filePath);
  const lowerPath = normalizedPath.toLowerCase();
  const segments = lowerPath.split('/').filter(Boolean);
  const basename = segments.at(-1) ?? lowerPath;
  const extension = basename.includes('.') ? `.${basename.split('.').at(-1)}` : '';
  const ignoredDirectory = segments.find((segment) => DEFAULT_IGNORED_DIRECTORIES.has(segment));
  const isBinary = BINARY_EXTENSIONS.has(extension);
  const isGenerated = GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(basename)) || lowerPath.includes('/generated/');
  const isMetadata = METADATA_FILES.has(basename);
  const kind: ContextPathKind = ignoredDirectory !== undefined
    ? 'ignored'
    : isBinary
      ? 'binary'
      : isGenerated
        ? 'generated'
        : isMetadata
          ? 'metadata'
          : 'source';

  if (mode === 'explicit') {
    return {
      path: normalizedPath,
      kind,
      tier: 3,
      discoverable: true,
      reason: 'explicit request bypasses automatic discovery filters',
    };
  }

  if (kind === 'ignored') {
    return {
      path: normalizedPath,
      kind,
      tier: 0,
      discoverable: false,
      reason: `default ignored directory: ${ignoredDirectory}`,
    };
  }
  if (kind === 'binary') {
    return { path: normalizedPath, kind, tier: 0, discoverable: false, reason: 'binary content is not sent to text context' };
  }
  if (kind === 'generated') {
    return { path: normalizedPath, kind, tier: 0, discoverable: false, reason: 'generated artifact is deferred until explicitly requested or relevant' };
  }
  if (kind === 'metadata') {
    return { path: normalizedPath, kind, tier: 1, discoverable: true, reason: 'metadata is available without expanding it as source context' };
  }
  return { path: normalizedPath, kind, tier: 2, discoverable: true, reason: 'relevant source/config context' };
}

export function isBinaryContent(content: Uint8Array | string): boolean {
  if (typeof content === 'string') return content.includes('\u0000');
  const sample = content.subarray(0, Math.min(content.byteLength, 8192));
  return sample.includes(0);
}

export function isGeneratedContent(content: string): boolean {
  return /(?:^|\n)\s*(?:\/\/|#|\/\*|<!--)?\s*(?:code )?(?:auto[- ]?generated|generated by|do not edit|machine generated)/i.test(content.slice(0, 8192));
}

export function fingerprintContent(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function summarizeContextText(content: string): ContextTextSummary {
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  const imports = unique([
    ...matchAll(content, /\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g),
    ...matchAll(content, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...matchAll(content, /\bfrom\s+['"]([^'"]+)['"]/g),
  ]).slice(0, 128);
  const exports = unique([
    ...matchAll(content, /\bexport\s+(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g),
    ...matchAll(content, /\bexport\s*\{([^}]+)\}/g).flatMap((value) => value.split(',').map((item) => item.trim().split(/\s+as\s+/i)[0] ?? '')),
  ]).slice(0, 128);
  const symbols = unique([
    ...matchAll(content, /\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g),
    ...matchAll(content, /\b(?:def|fn)\s+([A-Za-z_$][\w$]*)/g),
  ]).slice(0, 256);
  return {
    byteLength: Buffer.byteLength(content, 'utf8'),
    lineCount: lines.length,
    imports,
    exports,
    symbols,
  };
}

export function createLineDiff(previous: string, current: string, maxLines = 160): string | undefined {
  if (previous === current) return undefined;
  const previousLines = previous.split(/\r?\n/);
  const currentLines = current.split(/\r?\n/);
  let prefix = 0;
  while (prefix < previousLines.length && prefix < currentLines.length && previousLines[prefix] === currentLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < previousLines.length - prefix
    && suffix < currentLines.length - prefix
    && previousLines[previousLines.length - 1 - suffix] === currentLines[currentLines.length - 1 - suffix]
  ) suffix += 1;
  const removed = previousLines.slice(prefix, previousLines.length - suffix);
  const added = currentLines.slice(prefix, currentLines.length - suffix);
  const lines = [
    `@@ lines ${prefix + 1}-${Math.max(prefix + removed.length, prefix + added.length)} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  return lines.slice(0, maxLines).join('\n');
}

function matchAll(content: string, pattern: RegExp): string[] {
  return [...content.matchAll(pattern)].flatMap((match) => match[1] === undefined ? [] : [match[1]]);
}
