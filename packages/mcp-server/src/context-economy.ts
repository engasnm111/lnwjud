import {
  classifyContextPath,
  fingerprintContent,
  isBinaryContent,
  isGeneratedContent,
  summarizeContextText,
  createLineDiff,
  type ContextDiscoveryMode,
  type ContextPathClassification,
  type ContextTextSummary,
} from '@lnwjud/search';

export type ContextDeliveryKind = 'content' | 'diff' | 'reference' | 'unchanged' | 'metadata';

export interface ContextEconomyPrepared {
  readonly workspaceId: string;
  readonly path: string;
  readonly fingerprint: string;
  readonly byteLength: number;
  readonly classification: ContextPathClassification;
  readonly summary: ContextTextSummary;
  readonly delivery: ContextDeliveryKind;
  readonly diff?: string;
  readonly referencePath?: string;
  readonly unchangedSince?: string;
}

export interface ContextEconomyStats {
  readonly requests: number;
  readonly filesDiscovered: number;
  readonly filesDelivered: number;
  readonly rawContextBytes: number;
  readonly contextSentBytes: number;
  readonly duplicateContextBytes: number;
  readonly previouslySeenBytesAvoided: number;
  readonly generatedFilesSkipped: number;
  readonly generatedBytesSkipped: number;
  readonly binaryFilesSkipped: number;
  readonly defaultIgnoredPaths: number;
  readonly ledgerHits: number;
  readonly ledgerEntries: number;
  readonly estimatedContextSavedRatio: number;
}

interface StoredEntry {
  readonly workspaceId: string;
  readonly path: string;
  readonly fingerprint: string;
  readonly byteLength: number;
  readonly contextId: string;
  readonly content?: string;
}

interface MutableStats {
  requests: number;
  filesDiscovered: number;
  filesDelivered: number;
  rawContextBytes: number;
  contextSentBytes: number;
  duplicateContextBytes: number;
  previouslySeenBytesAvoided: number;
  generatedFilesSkipped: number;
  generatedBytesSkipped: number;
  binaryFilesSkipped: number;
  defaultIgnoredPaths: number;
  ledgerHits: number;
}

export interface ContextEconomyOptions {
  readonly maxEntries?: number;
  readonly maxStoredBytes?: number;
  /** Test/fixture override; production composition uses the real host. */
  readonly platform?: NodeJS.Platform;
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_STORED_BYTES = 4 * 1024 * 1024;

export class ContextEconomyRuntime {
  private readonly byPath = new Map<string, StoredEntry>();
  private readonly byFingerprint = new Map<string, StoredEntry>();
  private readonly maxEntries: number;
  private readonly maxStoredBytes: number;
  private readonly platform: NodeJS.Platform;
  private storedBytes = 0;
  private readonly delivered = new WeakSet<object>();
  private readonly stats: MutableStats = {
    requests: 0,
    filesDiscovered: 0,
    filesDelivered: 0,
    rawContextBytes: 0,
    contextSentBytes: 0,
    duplicateContextBytes: 0,
    previouslySeenBytesAvoided: 0,
    generatedFilesSkipped: 0,
    generatedBytesSkipped: 0,
    binaryFilesSkipped: 0,
    defaultIgnoredPaths: 0,
    ledgerHits: 0,
  };

  public constructor(options: ContextEconomyOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.maxStoredBytes = Math.max(0, Math.floor(options.maxStoredBytes ?? DEFAULT_MAX_STORED_BYTES));
    this.platform = options.platform ?? process.platform;
  }

  public beginRequest(): void {
    this.stats.requests += 1;
  }

  public prepare(request: {
    readonly workspaceId: string;
    readonly path: string;
    readonly content: string;
    readonly contextId: string;
    readonly discovery?: ContextDiscoveryMode;
  }): ContextEconomyPrepared {
    const discovery = request.discovery ?? 'automatic';
    const byteLength = Buffer.byteLength(request.content, 'utf8');
    const fingerprint = fingerprintContent(request.content);
    let classification = classifyContextPath(request.path, discovery);
    if (isGeneratedContent(request.content) && classification.kind !== 'ignored' && classification.kind !== 'binary') {
      classification = {
        ...classification,
        kind: 'generated',
        tier: discovery === 'explicit' ? 3 : 0,
        discoverable: discovery === 'explicit',
        reason: discovery === 'explicit' ? 'explicit generated-file read is allowed' : 'generated content is not sent to automatic text context',
      };
    }
    if (isBinaryContent(request.content) && classification.kind !== 'ignored') {
      classification = {
        ...classification,
        kind: 'binary',
        tier: discovery === 'explicit' ? 3 : 0,
        discoverable: discovery === 'explicit',
        reason: discovery === 'explicit' ? 'explicit binary read is represented as metadata' : 'binary content is not sent to text context',
      };
    }
    this.stats.filesDiscovered += 1;
    this.stats.rawContextBytes += byteLength;

    if (!classification.discoverable) this.recordSkippedClassification(classification, byteLength);

    const key = this.entryKey(request.workspaceId, request.path);
    const previous = this.byPath.get(key);
    const previousContent = previous?.content;
    const duplicate = this.byFingerprint.get(fingerprint);
    let delivery: ContextDeliveryKind = 'content';
    let diff: string | undefined;
    let referencePath: string | undefined;
    let unchangedSince: string | undefined;
    const largeMetadata = discovery === 'automatic'
      && byteLength > 128 * 1024
      && /\.(?:json|jsonl|ndjson|log|csv)$/i.test(classification.path);
    if (classification.kind === 'binary' || (classification.kind === 'generated' && discovery === 'automatic') || (classification.kind === 'metadata' && discovery === 'automatic') || largeMetadata) {
      delivery = 'metadata';
    } else if (previous?.fingerprint === fingerprint) {
      delivery = 'unchanged';
      unchangedSince = previous.contextId;
      this.stats.ledgerHits += 1;
      this.stats.previouslySeenBytesAvoided += byteLength;
    } else if (duplicate !== undefined && `${duplicate.workspaceId}\0${duplicate.path}` !== key) {
      delivery = 'reference';
      referencePath = duplicate.path;
      this.stats.ledgerHits += 1;
      this.stats.duplicateContextBytes += byteLength;
      this.stats.previouslySeenBytesAvoided += byteLength;
    } else if (previousContent !== undefined) {
      delivery = 'diff';
      diff = createLineDiff(previousContent, request.content);
      this.stats.ledgerHits += 1;
      this.stats.previouslySeenBytesAvoided += Math.max(0, byteLength - Buffer.byteLength(diff ?? request.content, 'utf8'));
    }

    const prepared: ContextEconomyPrepared = {
      workspaceId: request.workspaceId,
      path: request.path,
      fingerprint,
      byteLength,
      classification,
      summary: classification.kind === 'binary'
        ? { byteLength, lineCount: 0, imports: [], exports: [], symbols: [] }
        : summarizeContextText(request.content),
      delivery,
      ...(diff === undefined ? {} : { diff }),
      ...(referencePath === undefined ? {} : { referencePath }),
      ...(unchangedSince === undefined ? {} : { unchangedSince }),
    };
    this.remember({
      workspaceId: request.workspaceId,
      path: request.path,
      fingerprint,
      byteLength,
      contextId: request.contextId,
      ...(byteLength <= this.maxStoredBytes ? { content: request.content } : {}),
    });
    return prepared;
  }

  public recordSkipped(path: string, byteLength = 0): void {
    this.recordSkippedClassification(classifyContextPath(path, 'automatic'), byteLength);
  }

  public recordDelivery(prepared: ContextEconomyPrepared, deliveredBytes: number): void {
    if (this.delivered.has(prepared)) return;
    this.delivered.add(prepared);
    this.stats.filesDelivered += 1;
    this.stats.contextSentBytes += Math.max(0, Math.floor(deliveredBytes));
  }

  public snapshot(): ContextEconomyStats {
    const saved = Math.max(0, this.stats.rawContextBytes - this.stats.contextSentBytes);
    return {
      ...this.stats,
      ledgerEntries: this.byPath.size,
      estimatedContextSavedRatio: this.stats.rawContextBytes === 0 ? 0 : Number((saved / this.stats.rawContextBytes).toFixed(4)),
    };
  }

  public reset(): void {
    this.byPath.clear();
    this.byFingerprint.clear();
    this.storedBytes = 0;
    for (const key of Object.keys(this.stats) as Array<keyof MutableStats>) this.stats[key] = 0;
  }

  public invalidate(workspaceId?: string, filePath?: string): number {
    const normalizedPath = filePath?.replaceAll('\\', '/').toLowerCase();
    let removed = 0;
    for (const [key, entry] of [...this.byPath.entries()]) {
      if (workspaceId !== undefined && entry.workspaceId !== workspaceId) continue;
      if (normalizedPath !== undefined) {
        const entryPath = entry.path.replaceAll('\\', '/').toLowerCase();
        if (entryPath !== normalizedPath && !entryPath.startsWith(`${normalizedPath}/`)) continue;
      }
      this.byPath.delete(key);
      this.storedBytes -= entry.content === undefined ? 0 : entry.byteLength;
      removed += 1;
    }
    this.byFingerprint.clear();
    for (const entry of this.byPath.values()) {
      if (entry.content !== undefined && !this.byFingerprint.has(entry.fingerprint)) this.byFingerprint.set(entry.fingerprint, entry);
    }
    return removed;
  }

  private recordSkippedClassification(classification: ContextPathClassification, byteLength: number): void {
    if (classification.kind === 'ignored') this.stats.defaultIgnoredPaths += 1;
    if (classification.kind === 'generated') {
      this.stats.generatedFilesSkipped += 1;
      this.stats.generatedBytesSkipped += byteLength;
    }
    if (classification.kind === 'binary') this.stats.binaryFilesSkipped += 1;
  }

  private remember(entry: StoredEntry): void {
    const key = this.entryKey(entry.workspaceId, entry.path);
    const previous = this.byPath.get(key);
    if (previous !== undefined) {
      this.storedBytes -= previous.content === undefined ? 0 : previous.byteLength;
      if (this.byFingerprint.get(previous.fingerprint) === previous) this.byFingerprint.delete(previous.fingerprint);
      this.byPath.delete(key);
    }
    this.byPath.set(key, entry);
    if (entry.content !== undefined) {
      this.storedBytes += entry.byteLength;
      if (!this.byFingerprint.has(entry.fingerprint)) this.byFingerprint.set(entry.fingerprint, entry);
    }
    while (this.byPath.size > this.maxEntries || this.storedBytes > this.maxStoredBytes) {
      const oldest = this.byPath.entries().next().value as [string, StoredEntry] | undefined;
      if (oldest === undefined) break;
      this.byPath.delete(oldest[0]);
      this.storedBytes -= oldest[1].content === undefined ? 0 : oldest[1].byteLength;
      if (this.byFingerprint.get(oldest[1].fingerprint) === oldest[1]) this.byFingerprint.delete(oldest[1].fingerprint);
    }
  }

  private entryKey(workspaceId: string, filePath: string): string {
    const normalized = filePath.replaceAll('\\', '/');
    return `${workspaceId}\0${this.platform === 'win32' ? normalized.toLowerCase() : normalized}`;
  }
}
