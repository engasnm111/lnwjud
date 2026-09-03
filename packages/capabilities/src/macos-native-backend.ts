import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, isApplicationAuthorized, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';

export type MacOsCapabilityName = 'notification' | 'file_dialog' | 'clipboard';

export interface MacOsCapabilityBridge {
  execute(request: { readonly capability: MacOsCapabilityName; readonly input: Record<string, unknown> }, signal?: AbortSignal): Promise<Result<unknown>>;
}

export class MacOsNativeCapabilityBackend implements CapabilityBackend {
  public constructor(
    private readonly capability: MacOsCapabilityName,
    private readonly bridge: MacOsCapabilityBridge,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (this.platform !== 'darwin') return err(appError('INTERNAL_ERROR', 'macOS capability is unavailable on this platform', true));
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'macOS capability input must be an object'));
    if (input.dry_run === true) return ok({ dry_run: true, capability: this.capability });
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'macOS capability operation was cancelled', true));
    if (this.capability === 'clipboard' && input.action === 'set_text' && !isApplicationAuthorized(authorization, input.userConfirmed === true)) {
      return err(appError('PERMISSION_REQUIRED', 'clipboard set_text action requires explicit user confirmation'));
    }
    return this.bridge.execute({ capability: this.capability, input }, signal);
  }
}

export class MacOsCommandCapabilityBridge implements MacOsCapabilityBridge {
  public constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  public async execute(request: { readonly capability: MacOsCapabilityName; readonly input: Record<string, unknown> }, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'darwin') return err(appError('INTERNAL_ERROR', 'macOS command bridge is unavailable on this platform', true));
    try {
      switch (request.capability) {
        case 'notification': return ok(await showNotification(request.input, signal));
        case 'file_dialog': return ok(await showFileDialog(request.input, signal));
        case 'clipboard': return ok(await useClipboard(request.input, signal));
      }
    } catch (error) {
      return err(appError('INTERNAL_ERROR', `${request.capability} failed: ${errorMessage(error)}`, true));
    }
  }
}

async function showNotification(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const title = requiredString(input.title, 'title');
  const message = requiredString(input.message, 'message');
  const script = [
    'on run argv',
    'display notification (item 2 of argv) with title (item 1 of argv)',
    'return "shown"',
    'end run',
  ].join('\n');
  await runProcess('/usr/bin/osascript', ['-e', script, '--', title, message], undefined, signal);
  return { shown: true, provider: 'notification_center' };
}

async function showFileDialog(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const action = input.action;
  if (action !== 'open' && action !== 'save') throw new Error('Unsupported file_dialog action');
  const initialDirectory = optionalString(input.initial_directory);
  const filter = optionalString(input.filter);
  const multiSelect = input.multi_select === true;
  const fileName = optionalString(input.file_name);

  const script = action === 'open' ? OPEN_DIALOG_SCRIPT : SAVE_DIALOG_SCRIPT;
  const args = action === 'open'
    ? [initialDirectory, multiSelect ? 'true' : 'false']
    : [initialDirectory, fileName];
  const result = await runProcess('/usr/bin/osascript', ['-e', script, '--', ...args], undefined, signal, true);
  if (result.exitCode !== 0) {
    if (isUserCancelled(result.stderr)) return action === 'open' ? { canceled: true, paths: [] } : { canceled: true, path: null };
    throw new Error(result.stderr.trim() || `osascript exited with ${result.exitCode}`);
  }
  const output = result.stdout.replace(/\r?\n$/, '');
  if (action === 'save') return { canceled: false, path: output, filter_applied: false };
  const paths = output.length === 0 ? [] : output.split('\u001e');
  return { canceled: false, paths, filter_applied: filter.length === 0 ? true : false };
}

async function useClipboard(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  switch (input.action) {
    case 'get_text': {
      const result = await runProcess('/usr/bin/pbpaste', [], undefined, signal);
      return { text: result.stdout };
    }
    case 'set_text': {
      const text = typeof input.text === 'string' ? input.text : null;
      if (text === null || text.length > 1_000_000) throw new Error('Clipboard text must be a string of at most 1000000 characters');
      await runProcess('/usr/bin/pbcopy', [], text, signal);
      return { set: true, length: text.length };
    }
    case 'get_image': return readClipboardPng(signal);
    default: throw new Error('Unsupported clipboard action');
  }
}

async function readClipboardPng(signal?: AbortSignal): Promise<unknown> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-clipboard-'));
  const outputPath = path.join(root, 'clipboard.png');
  try {
    const result = await runProcess('/usr/bin/osascript', ['-e', CLIPBOARD_PNG_SCRIPT, '--', outputPath], undefined, signal, true);
    if (result.exitCode !== 0 || result.stdout.trim() === 'NO_IMAGE') return { present: false };
    const png = await readFile(outputPath);
    if (png.byteLength > 16 * 1024 * 1024) throw new Error('Clipboard image is too large');
    const dimensions = pngDimensions(png);
    if (dimensions === null) throw new Error('Clipboard PNG payload is invalid');
    return {
      present: true,
      format: 'png',
      mime_type: 'image/png',
      width: dimensions.width,
      height: dimensions.height,
      data_base64: png.toString('base64'),
    };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

const OPEN_DIALOG_SCRIPT = [
  'on run argv',
  'set initialDir to item 1 of argv',
  'set allowMulti to (item 2 of argv) is "true"',
  'try',
  'if initialDir is "" then',
  'set picked to choose file with multiple selections allowed allowMulti',
  'else',
  'set picked to choose file default location (POSIX file initialDir) with multiple selections allowed allowMulti',
  'end if',
  'on error number -128',
  'error number -128',
  'end try',
  'if allowMulti then',
  'set output to ""',
  'repeat with itemRef in picked',
  'if output is not "" then set output to output & character id 30',
  'set output to output & POSIX path of itemRef',
  'end repeat',
  'return output',
  'end if',
  'return POSIX path of picked',
  'end run',
].join('\n');

const SAVE_DIALOG_SCRIPT = [
  'on run argv',
  'set initialDir to item 1 of argv',
  'set defaultName to item 2 of argv',
  'try',
  'if initialDir is "" and defaultName is "" then',
  'set picked to choose file name',
  'else if initialDir is "" then',
  'set picked to choose file name default name defaultName',
  'else if defaultName is "" then',
  'set picked to choose file name default location (POSIX file initialDir)',
  'else',
  'set picked to choose file name default location (POSIX file initialDir) default name defaultName',
  'end if',
  'on error number -128',
  'error number -128',
  'end try',
  'return POSIX path of picked',
  'end run',
].join('\n');

const CLIPBOARD_PNG_SCRIPT = [
  'on run argv',
  'set outputPath to item 1 of argv',
  'try',
  'set pngData to the clipboard as «class PNGf»',
  'on error',
  'return "NO_IMAGE"',
  'end try',
  'set outputFile to open for access (POSIX file outputPath) with write permission',
  'try',
  'set eof outputFile to 0',
  'write pngData to outputFile',
  'close access outputFile',
  'on error errMsg',
  'try',
  'close access outputFile',
  'end try',
  'error errMsg',
  'end try',
  'return "OK"',
  'end run',
].join('\n');

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runProcess(
  executable: string,
  args: readonly string[],
  input?: string,
  signal?: AbortSignal,
  allowNonZero = false,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      const exitCode = code ?? -1;
      if (!allowNonZero && exitCode !== 0) {
        reject(new Error(stderr.trim() || `${path.basename(executable)} exited with ${exitCode}`));
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

function pngDimensions(png: Buffer): { readonly width: number; readonly height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.byteLength < 24 || !png.subarray(0, 8).equals(signature)) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isUserCancelled(stderr: string): boolean {
  return stderr.includes('(-128)') || stderr.toLowerCase().includes('user canceled');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
