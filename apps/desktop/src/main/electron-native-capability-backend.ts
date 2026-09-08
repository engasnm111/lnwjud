import os from 'node:os';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { appError, err, isApplicationAuthorized, isFullBypassAuthorization, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from '@lnwjud/capabilities';
import { readCapabilityActiveWorkspaceRoot } from '@lnwjud/capabilities';

export type ElectronNativeCapabilityName = 'system_info' | 'notification' | 'file_dialog' | 'clipboard';

export interface NativeDisplayMetadata {
  readonly id?: number | string;
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly workArea?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly scaleFactor?: number;
  readonly rotation?: number;
  readonly label?: string;
}

export interface NativeDialogOptions {
  readonly title?: string;
  readonly defaultPath?: string;
  readonly filters?: readonly { readonly name: string; readonly extensions: readonly string[] }[];
  readonly properties?: readonly string[];
}

export interface NativeDialogResult {
  readonly canceled: boolean;
  readonly filePaths?: readonly string[];
  readonly filePath?: string;
}

/**
 * Small injected surface around Electron. Keeping Electron out of this file
 * makes the policy and scope checks deterministic in Node tests and allows
 * headless STDIO to report an unavailable UI instead of touching a renderer.
 */
export interface ElectronNativeCapabilityApi {
  readonly getDisplays?: () => readonly NativeDisplayMetadata[];
  readonly showNotification?: (title: string, body: string) => Promise<void> | void;
  readonly showOpenDialog?: (options: NativeDialogOptions) => Promise<NativeDialogResult>;
  readonly showSaveDialog?: (options: NativeDialogOptions) => Promise<NativeDialogResult>;
  readonly readClipboardText?: () => string;
  readonly writeClipboardText?: (value: string) => void;
  readonly readClipboardImageBase64?: () => string | null;
  readonly writeClipboardImageBase64?: (value: string) => void;
  readonly hasWindow?: () => boolean;
}

export interface ElectronNativeCapabilityBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
  readonly api?: ElectronNativeCapabilityApi;
}

const MAX_TEXT_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DIALOG_PROPERTIES = new Set(['openFile', 'openDirectory', 'multiSelections', 'createDirectory', 'showHiddenFiles']);

export function createElectronNativeCapabilityBackends(options: ElectronNativeCapabilityBackendOptions = {}): Partial<Record<ElectronNativeCapabilityName, CapabilityBackend>> {
  return {
    system_info: new ElectronNativeCapabilityBackend('system_info', options),
    notification: new ElectronNativeCapabilityBackend('notification', options),
    file_dialog: new ElectronNativeCapabilityBackend('file_dialog', options),
    clipboard: new ElectronNativeCapabilityBackend('clipboard', options),
  };
}

export class ElectronNativeCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly rootsProvider: () => Promise<readonly string[]>;
  private readonly api: ElectronNativeCapabilityApi;

  public constructor(
    private readonly capability: ElectronNativeCapabilityName,
    options: ElectronNativeCapabilityBackendOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.rootsProvider = options.allowedRootsProvider ?? (async (): Promise<readonly string[]> => []);
    this.api = options.api ?? {};
  }

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (!isRecord(input)) return err(appError('INVALID_INPUT', `${this.capability} input must be an object`));
    const action = readAction(input, this.capability);
    if (action === null) return err(appError('INVALID_INPUT', `${this.capability} action is invalid`));
    if (isAborted(signal)) return cancelled(this.capability);
    if (input.dry_run === true) return ok({ dry_run: true, capability: this.capability, action });
    if (action === 'status') return this.status();
    if (requiresConfirmation(this.capability, action) && !isApplicationAuthorized(authorization, input.userConfirmed === true)) {
      return err(appError('PERMISSION_REQUIRED', `${this.capability} action requires explicit user confirmation`));
    }
    try {
      switch (this.capability) {
        case 'system_info': return this.systemInfo(action);
        case 'notification': return await this.notification(input, signal);
        case 'file_dialog': return await this.fileDialog(action, input, signal, authorization);
        case 'clipboard': return this.clipboard(action, input);
      }
    } catch (error: unknown) {
      if (isAborted(signal)) return cancelled(this.capability);
      return err(appError('INTERNAL_ERROR', `${this.capability} operation failed: ${safeMessage(error)}`, true));
    }
  }

  private status(): Result<unknown> {
    const available = this.capability === 'system_info'
      ? true
      : this.capability === 'notification'
        ? this.api.showNotification !== undefined
        : this.capability === 'file_dialog'
          ? this.api.showOpenDialog !== undefined && this.api.showSaveDialog !== undefined
          : this.api.readClipboardText !== undefined && this.api.writeClipboardText !== undefined;
    const headless = this.capability !== 'system_info' && this.api.hasWindow !== undefined && !this.api.hasWindow();
    return ok({
      available,
      ready: available && !headless,
      local: true,
      backend: 'electron-native',
      platform: this.platform,
      ...(headless ? { readinessReason: 'headless_ui' } : available ? {} : { readinessReason: 'electron_api_unavailable' }),
    });
  }

  private systemInfo(action: string): Result<unknown> {
    if (action !== 'summary' && action !== 'get') return err(appError('INVALID_INPUT', 'system_info supports summary or get'));
    const cpus = os.cpus();
    return ok({
      platform: this.platform,
      release: os.release(),
      arch: process.arch,
      hostname: os.hostname(),
      cpu_count: cpus.length,
      cpu_model: cpus[0]?.model ?? null,
      memory_bytes: { total: os.totalmem(), free: os.freemem() },
      uptime_seconds: os.uptime(),
      displays: this.api.getDisplays?.() ?? [],
      backend: 'electron-native',
    });
  }

  private async notification(input: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    const show = this.api.showNotification;
    if (show === undefined) return unavailable('notification', 'Electron Notification is unavailable in headless mode');
    const title = boundedString(input.title, 'lnwjud', 256);
    const body = boundedString(input.body, '', 4_096);
    if (body.length === 0) return err(appError('INVALID_INPUT', 'notification body is required'));
    if (isAborted(signal)) return cancelled('notification');
    await show(title, body);
    return ok({ shown: true, title });
  }

  private async fileDialog(action: string, input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const method = action === 'open' ? this.api.showOpenDialog : action === 'save' ? this.api.showSaveDialog : undefined;
    if (method === undefined) return unavailable('file_dialog', 'Native file dialogs are unavailable in headless mode');
    const optionsResult = parseDialogOptions(input);
    if (!optionsResult.ok) return optionsResult;
    const options = optionsResult.value;
    if (options.defaultPath !== undefined) {
      const defaultPath = await this.assertPathAllowed(options.defaultPath, 'file_dialog default path', input, authorization);
      if (!defaultPath.ok) return defaultPath;
    }
    if (isAborted(signal)) return cancelled('file_dialog');
    const result = await method(options);
    if (isAborted(signal)) return cancelled('file_dialog');
    if (result.canceled) return ok({ canceled: true, paths: [] });
    const paths = result.filePaths ?? (result.filePath === undefined ? [] : [result.filePath]);
    if (paths.length === 0 || paths.length > 128) return err(appError('INVALID_INPUT', 'Native file dialog returned an invalid path list'));
    for (const selected of paths) {
      const checked = await this.assertPathAllowed(selected, 'file_dialog selected path', input, authorization);
      if (!checked.ok) return checked;
    }
    return ok({ canceled: false, paths });
  }

  private clipboard(action: string, input: Record<string, unknown>): Result<unknown> {
    if (action === 'get_text') {
      if (this.api.readClipboardText === undefined) return unavailable('clipboard', 'Clipboard is unavailable in headless mode');
      return ok({ text: boundedString(this.api.readClipboardText(), '', MAX_TEXT_BYTES) });
    }
    if (action === 'set_text') {
      if (this.api.writeClipboardText === undefined) return unavailable('clipboard', 'Clipboard is unavailable in headless mode');
      const text = boundedString(input.text, '', MAX_TEXT_BYTES);
      if (typeof input.text !== 'string') return err(appError('INVALID_INPUT', 'clipboard text is required'));
      this.api.writeClipboardText(text);
      return ok({ written: true, bytes: Buffer.byteLength(text, 'utf8') });
    }
    if (action === 'get_image') {
      if (this.api.readClipboardImageBase64 === undefined) return unavailable('clipboard', 'Clipboard image access is unavailable');
      const data = this.api.readClipboardImageBase64();
      return ok({ format: 'png', data_base64: data ?? null, empty: data === null || data.length === 0 });
    }
    if (action === 'set_image') {
      if (this.api.writeClipboardImageBase64 === undefined) return unavailable('clipboard', 'Clipboard image access is unavailable');
      const data = input.data_base64;
      if (typeof data !== 'string' || data.length === 0 || Buffer.byteLength(data, 'base64') > MAX_IMAGE_BYTES) return err(appError('INVALID_INPUT', 'clipboard image must be a bounded base64 PNG'));
      this.api.writeClipboardImageBase64(data);
      return ok({ written: true, bytes: Buffer.byteLength(data, 'base64') });
    }
    return err(appError('INVALID_INPUT', 'clipboard action is invalid'));
  }

  private async assertPathAllowed(value: string, label: string, input: Record<string, unknown>, authorization?: InvocationAuthorization): Promise<Result<void>> {
    if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) return err(appError('INVALID_INPUT', `${label} is invalid`));
    const absolute = path.resolve(value);
    const canonical = await canonicalPath(absolute);
    if (canonical === null) return err(appError('FILE_NOT_FOUND', `${label} is unavailable`, true));
    if (isFullBypassAuthorization(authorization)) return ok(undefined);
    const activeRoot = readCapabilityActiveWorkspaceRoot(input);
    const roots = activeRoot === undefined ? await this.rootsProvider() : [activeRoot];
    const canonicalRoots = (await Promise.all(roots.map((root) => canonicalPath(root)))).filter((root): root is string => root !== null);
    if (canonicalRoots.length === 0 || !canonicalRoots.some((root) => isWithin(root, canonical))) return err(appError('PATH_OUTSIDE_WORKSPACE', `${label} is outside the Active Project`));
    return ok(undefined);
  }
}

function readAction(input: Record<string, unknown>, capability: ElectronNativeCapabilityName): string | null {
  const value = input.action === undefined ? capability === 'system_info' ? 'summary' : capability === 'file_dialog' ? 'open' : capability === 'notification' ? 'show' : 'get_text' : input.action;
  if (typeof value !== 'string') return null;
  const valid = capability === 'system_info' ? ['status', 'summary', 'get'] : capability === 'notification' ? ['status', 'show'] : capability === 'file_dialog' ? ['status', 'open', 'save'] : ['status', 'get_text', 'set_text', 'get_image', 'set_image'];
  return valid.includes(value) ? value : null;
}

function requiresConfirmation(capability: ElectronNativeCapabilityName, action: string): boolean {
  return capability === 'notification' ? action === 'show' : capability === 'file_dialog' ? action === 'save' : capability === 'clipboard' ? action === 'set_text' || action === 'set_image' : false;
}

function parseDialogOptions(input: Record<string, unknown>): Result<NativeDialogOptions> {
  const title = input.title === undefined ? undefined : boundedString(input.title, '', 256);
  if (input.title !== undefined && typeof input.title !== 'string') return err(appError('INVALID_INPUT', 'file_dialog title is invalid'));
  const defaultPath = input.default_path === undefined ? undefined : boundedString(input.default_path, '', 4_096);
  if (input.default_path !== undefined && typeof input.default_path !== 'string') return err(appError('INVALID_INPUT', 'file_dialog default_path is invalid'));
  const rawProperties = input.properties === undefined ? [] : input.properties;
  if (!Array.isArray(rawProperties) || rawProperties.length > 8 || !rawProperties.every((entry) => typeof entry === 'string' && DIALOG_PROPERTIES.has(entry))) return err(appError('INVALID_INPUT', 'file_dialog properties are invalid'));
  const rawFilters = input.filters === undefined ? [] : input.filters;
  if (!Array.isArray(rawFilters) || rawFilters.length > 32) return err(appError('INVALID_INPUT', 'file_dialog filters are invalid'));
  const filters = [];
  for (const entry of rawFilters) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !Array.isArray(entry.extensions) || entry.extensions.length > 32 || !entry.extensions.every((extension) => typeof extension === 'string' && /^[A-Za-z0-9*?._-]{1,32}$/.test(extension))) return err(appError('INVALID_INPUT', 'file_dialog filter is invalid'));
    filters.push({ name: boundedString(entry.name, '', 128), extensions: entry.extensions as string[] });
  }
  return ok({ ...(title === undefined ? {} : { title }), ...(defaultPath === undefined ? {} : { defaultPath }), properties: rawProperties as string[], filters });
}

async function canonicalPath(candidate: string): Promise<string | null> {
  try {
    const resolved = await realpath(candidate);
    return (await stat(resolved)).isDirectory() || (await stat(resolved)).isFile() ? resolved : null;
  } catch {
    try {
      const parent = await realpath(path.dirname(candidate));
      return (await stat(parent)).isDirectory() ? path.join(parent, path.basename(candidate)) : null;
    } catch { return null; }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && !relative.split(path.sep).includes('..'));
}

function unavailable(capability: string, message: string): Result<never> {
  return err(appError('INTERNAL_ERROR', `${message} (unsupported_ui_state)`, true));
}

function cancelled(capability: string): Result<never> {
  return err(appError('PROCESS_TIMEOUT', `${capability} operation was cancelled before dispatch`, true));
}

function isAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }

function boundedString(value: unknown, fallback: string, maxBytes: number): string {
  if (typeof value !== 'string') return fallback;
  return Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : 'unknown error';
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
