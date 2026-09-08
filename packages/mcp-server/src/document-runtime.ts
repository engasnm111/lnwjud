import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import {
  appError,
  err,
  isApplicationAuthorized,
  isFullBypassAuthorization,
  ok,
  type InvocationAuthorization,
  type Result,
} from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import { hostPathApi, isAbsoluteHostPath, isHostPathWithin, resolveHostPath } from '@lnwjud/workspace';
import { withReplacementRecoveryDetails } from './replacement-recovery.js';
import type { McpApplicationServices } from './tools/tool-types.js';

/**
 * Wave 7 document runtimes. Document paths are resolved through a registered
 * workspace before any provider is invoked, so optional PDF/Office providers
 * cannot become a filesystem-policy bypass.
 */

const PROVIDER_ENV = 'LNWJUD_PDF_PROVIDER';
const PROVIDER_CANDIDATES = ['pdftotext.exe', 'pdftotext'];
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;

export interface DocumentRuntimeOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly pdfProvider?: string;
  /** Injectable for tests: runs the provider with argv and returns stdout. */
  readonly pdfRunner?: (provider: string, args: readonly string[], signal?: AbortSignal) => Promise<Result<string>>;
  /** Test/fixture override; production uses the actual host platform. */
  readonly platform?: NodeJS.Platform;
}

export class DocumentRuntimeService {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly pdfProviderOverride: string | undefined;
  private readonly pdfRunner: (provider: string, args: readonly string[], signal?: AbortSignal) => Promise<Result<string>>;
  private readonly platform: NodeJS.Platform;
  private providerCache: string | null | undefined;

  public constructor(
    private readonly services: McpApplicationServices,
    private readonly actor: FileActor,
    options: DocumentRuntimeOptions = {},
  ) {
    this.environment = options.environment ?? process.env;
    this.pdfProviderOverride = options.pdfProvider;
    this.pdfRunner = options.pdfRunner ?? runPdfProvider;
    this.platform = options.platform ?? process.platform;
  }

  public async extractTables(input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const file = readString(input.file_path ?? input.path ?? input.file);
    if (file === undefined) return err(appError('INVALID_INPUT', 'pdf tools require file_path'));
    const workspaceId = readString(input.workspaceId);
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', 'pdf tools require workspaceId'));
    const provider = this.resolveProvider();
    if (provider === null) return unavailable('pdf_extract_tables', 'no local PDF provider', ['local PDF provider', 'bounded document size']);
    const target = await this.boundedFile(workspaceId, file, authorization);
    if (!target.ok) return target;

    const layout = await this.pdfRunner(provider, ['-layout', target.value, '-'], signal);
    if (!layout.ok) return layout;
    return ok({
      tool: 'pdf_extract_tables', status: 'ready', available: true,
      workspaceId,
      file: target.value,
      mode: 'layout-text',
      note: 'Tables are extracted as pdftotext -layout text; structured cell parsing is provider-dependent',
      text: layout.value.slice(0, MAX_TEXT_CHARS),
      truncated: layout.value.length > MAX_TEXT_CHARS,
    });
  }

  public async inspectPdf(input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const result = await this.extractTables(input, signal, authorization);
    if (!result.ok) {
      const payload = result as { error?: { message?: string } };
      if (result.error?.code === 'INVALID_INPUT' || result.error?.code === 'PATH_OUTSIDE_WORKSPACE' || result.error?.code === 'FILE_NOT_FOUND') return result;
      return ok({
        tool: 'inspect_pdf', status: 'needs_setup', available: false, ready: false, executed: false,
        reason: payload.error?.message ?? 'PDF provider unavailable',
        requirements: ['local PDF provider'],
        primitiveFallbacks: ['read_file', 'search_text'],
      });
    }
    const raw = result.value as { workspaceId?: unknown; file?: unknown; text?: unknown; truncated?: unknown; available?: unknown; status?: unknown; requirements?: unknown; reason?: unknown };
    if (raw.available === false) {
      return ok({
        tool: 'inspect_pdf', status: raw.status === 'unsupported' ? 'unsupported' : 'needs_setup', available: false, ready: false, executed: false,
        reason: typeof raw.reason === 'string' ? raw.reason : 'PDF provider unavailable',
        requirements: Array.isArray(raw.requirements) ? raw.requirements : ['local PDF provider'],
        primitiveFallbacks: ['read_file', 'search_text'],
      });
    }
    if (typeof raw.workspaceId !== 'string' || typeof raw.file !== 'string' || typeof raw.text !== 'string') {
      return err(appError('INTERNAL_ERROR', 'PDF provider returned an unexpected success shape', true));
    }
    const value = { workspaceId: raw.workspaceId, file: raw.file, text: raw.text, truncated: raw.truncated === true };
    const pages = Math.max(1, (value.text.match(/\f/g) ?? []).length);
    return ok({
      tool: 'inspect_pdf', status: 'ready', available: true,
      workspaceId: value.workspaceId,
      file: value.file, pages, characters: value.text.length,
      preview: value.text.slice(0, 4_000),
    });
  }

  public async inspectWorkbook(input: Record<string, unknown>, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const file = readString(input.file_path ?? input.path ?? input.file);
    const workspaceId = readString(input.workspaceId);
    if (file === undefined || workspaceId === undefined) return err(appError('INVALID_INPUT', 'inspect_workbook requires workspaceId and file_path'));
    const capabilities = this.services.capabilities;
    if (capabilities === undefined) {
      return unavailable('inspect_workbook', 'Office capability is not configured', ['local Excel provider (Office installation)']);
    }
    const target = await this.boundedFile(workspaceId, file, authorization);
    if (!target.ok) return target;

    const sheetsResult = await capabilities.execute('office', { app: 'excel', action: 'sheets', file_path: target.value }, undefined, authorization);
    if (!sheetsResult.ok) return sheetsResult;
    const sheets = (sheetsResult.value as { sheets?: unknown }).sheets;
    if (!Array.isArray(sheets)) return err(appError('INTERNAL_ERROR', 'Workbook sheet listing returned an unexpected shape', true));
    const sample = await capabilities.execute('office', { app: 'excel', action: 'read', file_path: target.value, range: 'A1:C8' }, undefined, authorization);
    const sampleValues = sample.ok && typeof (sample.value as { values?: unknown }).values !== 'undefined'
      ? (sample.value as { values: unknown }).values
      : undefined;
    return ok({
      tool: 'inspect_workbook', status: 'ready', available: true,
      workspaceId,
      file: target.value,
      sheets,
      sampleRange: 'A1:C8',
      sample: sampleValues,
    });
  }

  public async renderWorkbookPreview(input: Record<string, unknown>, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const inspected = await this.inspectWorkbook(input, authorization);
    if (!inspected.ok) return inspected;
    const value = inspected.value as { status?: unknown; available?: unknown; workspaceId?: unknown; file?: unknown; sheets?: unknown; sampleRange?: unknown; sample?: unknown; requirements?: unknown; reason?: unknown };
    if (value.available === false) return inspected;
    return ok({
      tool: 'render_excel_preview', status: 'ready', available: true, ready: true, executed: true,
      workspaceId: value.workspaceId, file: value.file, sheets: value.sheets,
      preview: { range: value.sampleRange, values: value.sample },
      format: 'structured_cell_preview', bounded: true,
    });
  }

  public async compareWorkbookLayout(input: Record<string, unknown>, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const workspaceId = readString(input.workspaceId);
    const baseline = readString(input.baseline_path ?? input.baseline ?? input.left_path ?? input.left);
    const actual = readString(input.actual_path ?? input.actual ?? input.right_path ?? input.right);
    if (workspaceId === undefined || baseline === undefined || actual === undefined) {
      return err(appError('INVALID_INPUT', 'compare_workbook_layout requires workspaceId plus baseline_path/actual_path'));
    }
    const [left, right] = await Promise.all([
      this.inspectWorkbook({ workspaceId, file_path: baseline }, authorization),
      this.inspectWorkbook({ workspaceId, file_path: actual }, authorization),
    ]);
    if (!left.ok) return left;
    if (!right.ok) return right;
    const leftValue = left.value as Record<string, unknown>;
    const rightValue = right.value as Record<string, unknown>;
    if (leftValue.available === false) return left;
    if (rightValue.available === false) return right;
    const leftSheets = Array.isArray(leftValue.sheets) ? leftValue.sheets.map(String) : [];
    const rightSheets = Array.isArray(rightValue.sheets) ? rightValue.sheets.map(String) : [];
    const sampleEqual = JSON.stringify(leftValue.sample ?? null) === JSON.stringify(rightValue.sample ?? null);
    return ok({
      tool: 'compare_workbook_layout', status: 'ready', available: true, ready: true, executed: true,
      workspaceId, baseline: leftValue.file, actual: rightValue.file,
      equal: sampleEqual && JSON.stringify(leftSheets) === JSON.stringify(rightSheets),
      sheetNamesEqual: JSON.stringify(leftSheets) === JSON.stringify(rightSheets),
      baselineSheets: leftSheets, actualSheets: rightSheets,
      sampledRange: 'A1:C8', sampledValuesEqual: sampleEqual,
      bounded: true,
    });
  }

  public async comparePdfPages(input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const workspaceId = readString(input.workspaceId);
    const baseline = readString(input.baseline_path ?? input.baseline ?? input.left_path ?? input.left);
    const actual = readString(input.actual_path ?? input.actual ?? input.right_path ?? input.right);
    if (workspaceId === undefined || baseline === undefined || actual === undefined) {
      return err(appError('INVALID_INPUT', 'compare_pdf_pages requires workspaceId plus baseline_path/actual_path'));
    }
    const [left, right] = await Promise.all([
      this.inspectPdf({ workspaceId, file_path: baseline }, signal, authorization),
      this.inspectPdf({ workspaceId, file_path: actual }, signal, authorization),
    ]);
    if (!left.ok) return left;
    if (!right.ok) return right;
    const leftValue = left.value as Record<string, unknown>;
    const rightValue = right.value as Record<string, unknown>;
    if (leftValue.available === false) return left;
    if (rightValue.available === false) return right;
    const leftPreview = typeof leftValue.preview === 'string' ? leftValue.preview : '';
    const rightPreview = typeof rightValue.preview === 'string' ? rightValue.preview : '';
    return ok({
      tool: 'compare_pdf_pages', status: 'ready', available: true, ready: true, executed: true,
      workspaceId, baseline: leftValue.file, actual: rightValue.file,
      baselinePages: leftValue.pages ?? null, actualPages: rightValue.pages ?? null,
      pageCountEqual: leftValue.pages === rightValue.pages,
      previewTextEqual: leftPreview === rightPreview,
      equal: leftValue.pages === rightValue.pages && leftPreview === rightPreview,
      boundedPreviewCharacters: 4_000,
    });
  }

  public async docxMerge(input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const workspaceId = readString(input.workspaceId);
    const primary = readString(input.file_path ?? input.primary);
    const target = readString(input.target_path ?? input.target);
    const mergePaths = (Array.isArray(input.merge_paths) ? input.merge_paths : []).map(String).map((value) => value.trim()).filter((value) => value.length > 0);
    if (workspaceId === undefined || primary === undefined || target === undefined || mergePaths.length === 0) {
      return err(appError('INVALID_INPUT', 'docx_merge requires workspaceId, file_path, merge_paths, and target_path'));
    }

    const resolvedPrimary = await this.resolveWorkspacePath(workspaceId, primary, true, authorization);
    if (!resolvedPrimary.ok) return resolvedPrimary;
    const resolvedMergePaths: string[] = [];
    for (const mergePath of mergePaths) {
      const resolved = await this.resolveWorkspacePath(workspaceId, mergePath, true, authorization);
      if (!resolved.ok) return resolved;
      resolvedMergePaths.push(resolved.value);
    }
    const resolvedTarget = await this.resolveWorkspacePath(workspaceId, target, false, authorization);
    if (!resolvedTarget.ok) return resolvedTarget;

    const plan = {
      tool: 'docx_merge', workspaceId,
      primary: resolvedPrimary.value, mergePaths: resolvedMergePaths, target: resolvedTarget.value,
      mutationPolicy: 'explicit-confirmation-and-dry-run',
      provider: 'Word COM',
    };
    if (input.dryRun !== false && input.dry_run !== false) return ok({ ...plan, dryRun: true, applied: false });
    if (!isApplicationAuthorized(authorization, input.userConfirmed === true)) return err(appError('PERMISSION_REQUIRED', 'docx_merge requires explicit chat confirmation. Ask the user first, then retry with userConfirmed: true'));

    const capabilities = this.services.capabilities;
    if (capabilities === undefined) return unavailable('docx_merge', 'Office capability is not configured', ['local DOCX provider (Word installation)', 'edit approval']);
    const fileSafety = this.services.file;
    if (fileSafety === undefined) return err(appError('INTERNAL_ERROR', 'File safety service is unavailable; refusing DOCX merge', true));
    const prepared = await fileSafety.prepareExternalFileMutation(this.actor, workspaceId, {
      sourcePaths: [resolvedPrimary.value, ...resolvedMergePaths],
      targetPath: resolvedTarget.value,
      ...(input.userConfirmed === true ? { userConfirmed: true } : {}),
    }, signal, authorization);
    if (!prepared.ok) return prepared;
    const merged = await capabilities.execute('office', {
      app: 'word',
      action: 'merge',
      file_path: prepared.value.sourcePaths[0],
      merge_paths: prepared.value.sourcePaths.slice(1),
      target_path: prepared.value.targetPath,
      ...(input.userConfirmed === true ? { userConfirmed: true } : {}),
    }, signal, authorization);
    if (!merged.ok) return withReplacementRecoveryDetails(merged, prepared.value.replacementBackup);
    return ok({
      ...plan,
      dryRun: false,
      applied: true,
      result: merged.value,
      ...(prepared.value.replacementBackup === undefined ? {} : { replacementBackup: prepared.value.replacementBackup }),
    });
  }

  private resolveProvider(): string | null {
    if (this.providerCache !== undefined) return this.providerCache;
    const settingsProvider = this.services.localProviders?.().pdfProvider;
    const configured = readString(settingsProvider) ?? readString(this.environment[PROVIDER_ENV]);
    if (configured !== undefined) {
      const resolved = resolveHostPath(configured, this.platform);
      this.providerCache = resolved !== null && existsSync(resolved) ? resolved : null;
      return this.providerCache;
    }
    if (this.pdfProviderOverride !== undefined) {
      const resolved = resolveHostPath(this.pdfProviderOverride, this.platform);
      this.providerCache = resolved !== null && existsSync(resolved) ? resolved : null;
      return this.providerCache;
    }
    for (const candidate of PROVIDER_CANDIDATES) {
      const resolved = lookupOnPath(candidate, this.environment.PATH, this.platform);
      if (resolved !== null) {
        this.providerCache = resolved;
        return resolved;
      }
    }
    this.providerCache = null;
    return null;
  }

  private async boundedFile(workspaceId: string, requested: string, authorization?: InvocationAuthorization): Promise<Result<string>> {
    const resolved = await this.resolveWorkspacePath(workspaceId, requested, true, authorization);
    if (!resolved.ok) return resolved;
    const size = await stat(resolved.value);
    if (!size.isFile()) return err(appError('INVALID_INPUT', 'Document target must be a file'));
    if (size.size > MAX_DOCUMENT_BYTES) return err(appError('FILE_TOO_LARGE', 'Document exceeds the bounded size limit'));
    return resolved;
  }

  private async resolveWorkspacePath(workspaceId: string, requested: string, mustExist: boolean, authorization?: InvocationAuthorization): Promise<Result<string>> {
    const root = await this.workspaceRoot(workspaceId);
    if (!root.ok) return root;
    let canonicalRoot: string;
    try {
      const resolvedRoot = resolveHostPath(root.value, this.platform);
      if (resolvedRoot === null) return err(appError('INVALID_INPUT', 'Workspace root uses a foreign host path syntax'));
      canonicalRoot = await realpath(resolvedRoot);
    } catch {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root could not be resolved'));
    }
    // Windows can expose the same physical location under an 8.3 short path
    // while realpath() returns the long spelling. Do not make a lexical
    // containment decision until the candidate (or its parent) is canonical.
    if (this.platform !== 'win32' && requested.includes('\\')) {
      return err(appError('INVALID_INPUT', `Document path uses a foreign host syntax: ${requested}`));
    }
    const api = hostPathApi(this.platform);
    const absoluteRequest = isAbsoluteHostPath(requested, this.platform);
    const candidate = absoluteRequest
      ? resolveHostPath(requested, this.platform)
      : resolveHostPath(api.join(canonicalRoot, requested), this.platform);
    if (candidate === null) return err(appError('INVALID_INPUT', `Document path uses a foreign host syntax: ${requested}`));
    const allowOutsideAbsolute = absoluteRequest && isFullBypassAuthorization(authorization);

    if (mustExist) {
      if (!existsSync(candidate)) return err(appError('FILE_NOT_FOUND', `File was not found: ${candidate}`));
      try {
        const canonical = await realpath(candidate);
        return allowOutsideAbsolute || isHostPathWithin(canonicalRoot, canonical, this.platform)
          ? ok(canonical)
          : err(appError('PATH_OUTSIDE_WORKSPACE', `Document path resolves outside the registered workspace: ${requested}`));
      } catch {
        return err(appError('FILE_NOT_FOUND', `File could not be resolved: ${candidate}`));
      }
    }

    const parent = api.dirname(candidate);
    try {
      const canonicalParent = await realpath(parent);
      if (!allowOutsideAbsolute && !isHostPathWithin(canonicalRoot, canonicalParent, this.platform)) return err(appError('PATH_OUTSIDE_WORKSPACE', `Document target resolves outside the registered workspace: ${requested}`));
      return ok(api.join(canonicalParent, api.basename(candidate)));
    } catch {
      return err(appError('FILE_NOT_FOUND', `Document target parent was not found: ${parent}`));
    }
  }

  private async workspaceRoot(workspaceId: string): Promise<Result<string>> {
    const workspaceInfo = this.services.workspaceInfo;
    if (workspaceInfo === undefined) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace service is not configured'));
    const info = await workspaceInfo.info(this.actor, workspaceId);
    if (!info.ok) return info;
    const rootPath = typeof (info.value as { realRootPath?: unknown }).realRootPath === 'string'
      ? (info.value as { realRootPath: string }).realRootPath
      : undefined;
    if (rootPath === undefined) return err(appError('INTERNAL_ERROR', 'Workspace root could not be resolved', true));
    const resolved = resolveHostPath(rootPath, this.platform);
    return resolved === null
      ? err(appError('INVALID_INPUT', 'Workspace root uses a foreign host path syntax'))
      : ok(resolved);
  }
}

function lookupOnPath(executable: string, pathValue: string | undefined, platform: NodeJS.Platform): string | null {
  const api = hostPathApi(platform);
  const directories = (pathValue ?? '').split(api.delimiter).filter((directory) => directory.trim().length > 0);
  for (const directory of directories) {
    const candidate = api.join(directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function runPdfProvider(provider: string, args: readonly string[], signal?: AbortSignal): Promise<Result<string>> {
  return new Promise((resolve) => {
    const child = spawn(provider, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const finish = (result: Result<string>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(err(appError('PROCESS_TIMEOUT', 'PDF provider timed out', true)));
    }, 60_000);
    const onAbort = (): void => {
      child.kill();
      finish(err(appError('PROCESS_TIMEOUT', 'PDF provider was cancelled', true)));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_TEXT_CHARS + 1) stdout += chunk.toString('utf8');
    });
    child.stderr?.resume();
    child.once('error', () => finish(err(appError('EXECUTABLE_NOT_FOUND', `PDF provider could not start: ${provider}`))));
    child.once('close', (code) => {
      if (code === 0) finish(ok(stdout));
      else finish(err(appError('INTERNAL_ERROR', `PDF provider exited with code ${code ?? 'unknown'}`, true)));
    });
  });
}

function unavailable(tool: string, reason: string, requirements: readonly string[]): Result<unknown> {
  return ok({
    tool, status: 'needs_setup', available: false, ready: false, executed: false,
    reason, requirements,
    primitiveFallbacks: ['read_file', 'search_text', 'workspace_tree'],
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
