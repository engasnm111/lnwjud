import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { readCapabilityActiveWorkspaceRoot } from './task-ownership.js';

const execFileAsync = promisify(execFile);

/**
 * Truthful availability payload for the office capability, which has no native
 * macOS automation backend yet. Consumers translate this into the runtime's
 * truthful_unavailable result instead of misreading the stub as success.
 */
export const MACOS_OFFICE_UNAVAILABLE_REASON = 'Native Microsoft Office automation is not available on macOS yet.';

export type MacosCapabilityName =
  | 'accessibility'
  | 'input_event'
  | 'vision'
  | 'window'
  | 'system_info'
  | 'notification'
  | 'file_dialog'
  | 'clipboard'
  | 'audio'
  | 'screen_record'
  | 'office';

export interface MacosNativeBackendOptions {
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
}

type NativePathField = 'file_path' | 'output_path' | 'target_path' | 'merge_paths';

const PATH_FIELDS: Readonly<Record<MacosCapabilityName, readonly NativePathField[]>> = {
  accessibility: [], input_event: [], vision: [], window: [], system_info: [], notification: [], file_dialog: [], clipboard: [],
  audio: ['file_path', 'output_path'], screen_record: ['output_path'], office: ['file_path', 'target_path', 'merge_paths'],
};

export class MacosNativeCapabilityBackend implements CapabilityBackend {
  public constructor(
    private readonly capability: MacosCapabilityName,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly options: MacosNativeBackendOptions = {},
  ) {}

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'darwin') return err(appError('INTERNAL_ERROR', 'macOS capability is unavailable on this platform', true));
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Native capability input must be an object'));
    if (input.dry_run === true) {
      // Availability must be visible even to dry runs so callers can refuse
      // mutations (and their backups) before promising work they cannot do.
      return this.capability === 'office'
        ? ok({ dry_run: true, capability: this.capability, platform: 'darwin', available: false, ready: false, reason: MACOS_OFFICE_UNAVAILABLE_REASON })
        : ok({ dry_run: true, capability: this.capability, platform: 'darwin' });
    }
    if (signal?.aborted === true) return cancelledOperation();
    const pathCheck = await this.assertPathsAllowed(input);
    if (!pathCheck.ok) return pathCheck;
    if (requiresExplicitConfirmation(this.capability, input) && input.userConfirmed !== true) {
      return err(appError('PERMISSION_REQUIRED', `${this.capability} action requires explicit user confirmation`));
    }
    try {
      switch (this.capability) {
        case 'system_info': return ok(await executeSystemInfo(input, signal));
        case 'notification': return ok(await executeNotification(input, signal));
        case 'file_dialog': return ok(await executeFileDialog(input, signal));
        case 'clipboard': return ok(await executeClipboard(input, signal));
        case 'vision': return ok(await executeVision(input, signal));
        case 'window': return ok(await executeWindow(input, signal));
        case 'accessibility': return ok(await executeAccessibility(input, signal));
        case 'input_event': return ok(await executeInputEvent(input, signal));
        case 'audio': return ok(await executeAudio(input, signal));
        case 'screen_record': return ok(await executeScreenRecord(input, signal));
        case 'office': return ok({ available: false, ready: false, reason: MACOS_OFFICE_UNAVAILABLE_REASON });
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return cancelledOperation();
      return err(appError('INTERNAL_ERROR', extractError(error, `macOS ${this.capability} capability failed`), true));
    }
  }

  private async assertPathsAllowed(input: Record<string, unknown>): Promise<Result<void>> {
    const targets: { field: NativePathField; value: string }[] = [];
    for (const field of PATH_FIELDS[this.capability]) {
      const value = input[field];
      if (typeof value === 'string' && value.trim()) targets.push({ field, value: value.trim() });
      if (Array.isArray(value)) for (const entry of value) if (typeof entry === 'string' && entry.trim()) targets.push({ field, value: entry.trim() });
    }
    if (targets.length === 0) return ok(undefined);
    const roots = await this.canonicalAllowedRoots(input);
    if (roots.length === 0) return err(appError('PATH_OUTSIDE_WORKSPACE', `${this.capability} path operation requires an available Active Project root`));
    for (const target of targets) {
      const canonical = await canonicalizeNativePath(target.field, target.value);
      if (canonical === null || !roots.some((root) => isWithin(root, canonical))) return err(appError('PATH_OUTSIDE_WORKSPACE', `${this.capability} target path is outside the Active Project`));
    }
    return ok(undefined);
  }

  private async canonicalAllowedRoots(input: Record<string, unknown>): Promise<readonly string[]> {
    if (this.options.allowedRootsProvider === undefined) return [];
    let configured: readonly string[];
    try { configured = await this.options.allowedRootsProvider(); } catch { return []; }
    const roots: string[] = [];
    for (const candidate of configured) {
      try { const canonical = await realpath(path.resolve(candidate)); if ((await stat(canonical)).isDirectory()) roots.push(canonical); } catch { continue; }
    }
    if (roots.length === 0) return [];
    const active = readCapabilityActiveWorkspaceRoot(input);
    if (active === undefined) return roots;
    // The Active Project root arrives in client-suppliable metadata, so it may
    // only narrow the configured roots, never widen them (mirrors resolveCwd in
    // shell-backend). An untrusted root fails closed to "no roots available".
    try {
      const canonicalActive = await realpath(path.resolve(active));
      if ((await stat(canonicalActive)).isDirectory() && roots.some((root) => isWithin(root, canonicalActive))) return [canonicalActive];
    } catch { /* fall through */ }
    return [];
  }
}

async function executeSystemInfo(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const operation = typeof input.operation === 'string' && input.operation ? input.operation : 'all';
  if (operation === 'cpu') return cpuInfo();
  if (operation === 'memory') return memoryInfo();
  if (operation === 'disks') return diskInfo(signal);
  if (operation === 'battery') return batteryInfo(signal);
  if (operation === 'uptime') return uptimeInfo();
  if (operation === 'os') return osInfo(signal);
  if (operation === 'processes') return processInfo(readTopCount(input.top_count), signal);
  if (operation === 'all') return { os: await osInfo(signal), cpu: cpuInfo(), memory: memoryInfo(), disks: await diskInfo(signal), battery: await batteryInfo(signal), uptime: uptimeInfo(), top_processes: await processInfo(readTopCount(input.top_count), signal) };
  throw new Error(`Unsupported system_info operation: ${operation}`);
}

function cpuInfo(): Record<string, unknown> {
  const cpus = os.cpus(); const logical = cpus.length;
  const oneMinuteLoad = os.loadavg()[0] ?? 0;
  return { model: cpus[0]?.model ?? os.arch(), cores: logical, logical_processors: logical, load_percent: logical === 0 ? 0 : Math.max(0, Math.min(100, Math.round((oneMinuteLoad / logical) * 100))) };
}
function memoryInfo(): Record<string, unknown> { const total = os.totalmem(); const free = os.freemem(); return { total_bytes: total, free_bytes: free, used_percent: total === 0 ? 0 : Math.round((1 - free / total) * 100) }; }
function uptimeInfo(): Record<string, unknown> { const seconds = Math.round(os.uptime()); return { boot_time: new Date(Date.now() - seconds * 1000).toISOString(), uptime_seconds: seconds }; }
async function diskInfo(signal?: AbortSignal): Promise<Record<string, unknown>> {
  const { stdout } = await execText('/bin/df', ['-Pk'], signal); const drives: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/).slice(1)) { const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/.exec(line.trim()); if (match) drives.push({ device: match[1], volume: match[5], total_bytes: Number(match[2]) * 1024, free_bytes: Number(match[4]) * 1024 }); }
  return { drives };
}
async function batteryInfo(signal?: AbortSignal): Promise<Record<string, unknown>> { try { const { stdout } = await execText('/usr/bin/pmset', ['-g', 'batt'], signal); const percent = /(\d+)%/.exec(stdout)?.[1]; if (!percent) return { present: false }; return { present: true, percent: Number(percent), status: /;\s*([^;]+);/.exec(stdout)?.[1]?.trim() ?? 'unknown' }; } catch { return { present: false }; } }
async function osInfo(signal?: AbortSignal): Promise<Record<string, unknown>> { return { name: await commandValue('/usr/bin/sw_vers', ['-productName'], signal, 'macOS'), version: await commandValue('/usr/bin/sw_vers', ['-productVersion'], signal, os.release()), build: await commandValue('/usr/bin/sw_vers', ['-buildVersion'], signal, os.release()), architecture: os.arch(), computer_name: os.hostname(), manufacturer: 'Apple Inc.', model: await commandValue('/usr/sbin/sysctl', ['-n', 'hw.model'], signal, 'Mac') }; }
async function processInfo(limit: number, signal?: AbortSignal): Promise<Record<string, unknown>> { const { stdout } = await execText('/bin/ps', ['-axo', 'pid=,rss=,time=,comm='], signal); const processes = stdout.split(/\r?\n/).map((line) => /^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line.trim())).filter((m): m is RegExpExecArray => m !== null).map((m) => ({ name: path.basename(m[4]!), pid: Number(m[1]), memory_bytes: Number(m[2]) * 1024, cpu_time_seconds: parsePsTime(m[3]!) })).sort((a, b) => b.memory_bytes - a.memory_bytes).slice(0, limit); return { processes }; }

async function executeNotification(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> { const title = String(input.title ?? ''); const message = String(input.message ?? ''); if (!title || !message) throw new Error('Notification title and message are required'); await runJxa("function run(a){const app=Application.currentApplication();app.includeStandardAdditions=true;app.displayNotification(a[1],{withTitle:a[0]});return 'ok';}", [title, message], signal); return { shown: true, backend: 'macOS Notification Center' }; }
async function executeFileDialog(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> { const action = String(input.action ?? ''); const raw = await runJxa(FILE_DIALOG_JXA, [JSON.stringify({ action, initialDirectory: input.initial_directory, multiSelect: input.multi_select === true, fileName: input.file_name })], signal); return parseJsonObject(raw); }
async function executeClipboard(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const action = String(input.action ?? '');
  if (action === 'get_text') return { text: (await execText('/usr/bin/pbpaste', [], signal)).stdout };
  if (action === 'set_text') {
    const text = input.text;
    if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Clipboard text must be a string of at most 1000000 characters');
    await spawnWithInput('/usr/bin/pbcopy', [], text, signal);
    return { set: true, length: text.length };
  }
  if (action === 'get_image') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-clipboard-'));
    const output = path.join(dir, 'clipboard.png');
    try {
      const result = await execText('/usr/bin/osascript', ['-e', CLIPBOARD_IMAGE_APPLESCRIPT, output], signal).catch(() => ({ stdout: 'NO_IMAGE', stderr: '' }));
      if (result.stdout.trim() !== 'OK') return { present: false };
      const data = await readFile(output);
      if (data.byteLength > 16 * 1024 * 1024) throw new Error('Clipboard image is too large');
      return { present: true, format: 'png', mime_type: 'image/png', ...pngSize(data), data_base64: data.toString('base64') };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  throw new Error(`Unsupported clipboard action: ${action}`);
}
async function executeVision(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> { const action = String(input.action ?? ''); if (action === 'ocr') return { available: false, ready: false, reason: 'macOS Vision OCR is not wired yet' }; if (action === 'annotate') return { available: false, ready: false, reason: 'macOS image annotation is not wired yet' }; const dir = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-capture-')); const output = path.join(dir, 'capture.png'); try { const args = ['-x', '-t', 'png']; let originX = 0; let originY = 0; if (action === 'capture_display') args.push(`-D${typeof input.display_id === 'string' && /^\d+$/.test(input.display_id) ? input.display_id : '1'}`); else if (action === 'capture_region') { if (!isRecord(input.region)) throw new Error('Region is required'); const x = readInteger(input.region.x, 'region.x'), y = readInteger(input.region.y, 'region.y'), w = readPositiveInteger(input.region.width, 'region.width'), h = readPositiveInteger(input.region.height, 'region.height'); originX = x; originY = y; args.push(`-R${x},${y},${w},${h}`); } else if (action === 'capture_window') { const params = isRecord(input.app) ? { ...input.app } : {}; if (typeof input.window_index === 'number') params.window_index = input.window_index; const win = await resolveWindow(params, signal); if (!isRecord(win.bounds)) throw new Error('Window bounds unavailable'); const x = readInteger(win.bounds.x, 'x'), y = readInteger(win.bounds.y, 'y'), w = readPositiveInteger(win.bounds.width, 'width'), h = readPositiveInteger(win.bounds.height, 'height'); originX = x; originY = y; args.push(`-R${x},${y},${w},${h}`); } else throw new Error(`Unsupported vision action: ${action}`); args.push(output); await execText('/usr/sbin/screencapture', args, signal); const data = await readFile(output); return { format: 'png', mime_type: 'image/png', data_base64: data.toString('base64'), ...pngSize(data), origin_x: originX, origin_y: originY, source: action, backend: 'macOS screencapture' }; } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); } }
async function executeWindow(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> { return parseJsonObject(await runJxa(WINDOW_JXA, [String(input.operation ?? ''), JSON.stringify(isRecord(input.parameters) ? input.parameters : {})], signal)); }
async function executeAccessibility(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> { const action = String(input.action ?? ''); if (action === 'status') { try { return parseJsonObject(await runJxa("function run(){ObjC.import('ApplicationServices');const trusted=Boolean($.AXIsProcessTrusted());return JSON.stringify({available:true,ready:trusted,backend:'macOS Accessibility',reason:trusted?undefined:'Grant Accessibility permission in System Settings > Privacy & Security > Accessibility'});}", [], signal)); } catch (e) { return { available: false, ready: false, reason: extractError(e, 'Accessibility permission required') }; } } if (action === 'list_windows') return executeWindow({ operation: 'list', parameters: input.parameters }, signal); if (action === 'activate_app') return executeWindow({ operation: 'activate', parameters: input.parameters }, signal); return parseJsonObject(await runJxa(ACCESSIBILITY_JXA, [action, JSON.stringify(isRecord(input.parameters) ? input.parameters : {})], signal)); }
async function executeInputEvent(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> { return parseJsonObject(await runJxa(INPUT_JXA, [String(input.operation ?? ''), JSON.stringify(isRecord(input.parameters) ? input.parameters : input)], signal)); }
async function executeAudio(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> { const action = String(input.action ?? ''); if (action === 'play') { const filePath = String(input.file_path ?? ''); await execText('/usr/bin/afplay', [filePath], signal); return { played: true, file_path: filePath }; } if (action === 'record') return { available: false, ready: false, reason: 'Microphone recording requires an optional macOS AVFoundation/ffmpeg backend' }; if (action === 'stop') return { stopped: true }; throw new Error(`Unsupported audio action: ${action}`); }
async function executeScreenRecord(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  void signal;
  const action = String(input.action ?? '');
  const statePath = await screenRecordStatePath();
  if (action === 'status') {
    const state = await readScreenRecordingState(statePath);
    const recording = state !== null && processAlive(state.pid);
    if (state !== null && !recording) await rm(statePath, { force: true }).catch(() => undefined);
    return { available: true, ready: true, backend: 'macOS screencapture', recording, ...(state === null ? {} : { pid: state.pid, output_path: state.outputPath }) };
  }
  if (action === 'start') {
    const existing = await readScreenRecordingState(statePath);
    if (existing !== null && processAlive(existing.pid)) throw new Error('A screen recording is already active');
    const out = String(input.output_path ?? '');
    if (!out) throw new Error('output_path is required');
    const args = ['-x', '-v', '-V3600'];
    if (typeof input.width === 'number' && typeof input.height === 'number') args.push(`-R${Number(input.offset_x ?? 0)},${Number(input.offset_y ?? 0)},${input.width},${input.height}`);
    else args.push('-D1');
    args.push(out);
    const child = spawn('/usr/sbin/screencapture', args, { detached: true, stdio: 'ignore' });
    if (child.pid === undefined) throw new Error('Unable to start macOS screen recording');
    child.unref();
    await writeFile(statePath, JSON.stringify({ pid: child.pid, outputPath: out }), { encoding: 'utf8', mode: 0o600 });
    return { recording: true, pid: child.pid, output_path: out, backend: 'macOS screencapture', max_duration_seconds: 3600 };
  }
  if (action === 'stop') {
    const state = await readScreenRecordingState(statePath);
    if (state === null) return { recording: false, reason: 'No active recording' };
    // The state file records a bare pid; before signalling it, prove the pid
    // still belongs to our screencapture child so a recycled pid cannot make us
    // SIGINT an unrelated process.
    if (await isScreencaptureProcess(state.pid)) {
      try { process.kill(state.pid, 'SIGINT'); } catch { /* already stopped */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(statePath, { force: true }).catch(() => undefined);
    return { recording: false, output_path: state.outputPath };
  }
  throw new Error(`Unsupported screen_record action: ${action}`);
}

async function screenRecordStatePath(): Promise<string> {
  // A fixed state file directly in the shared tmpdir is steerable by other
  // local processes; keep it inside a user-scoped 0700 directory instead.
  const directory = path.join(os.tmpdir(), `lnwjud-screen-record-${process.getuid?.() ?? 0}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  return path.join(directory, 'state.json');
}

async function isScreencaptureProcess(pid: number): Promise<boolean> {
  try {
    const inspected = await execText('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
    return /screencapture/i.test(inspected.stdout.trim());
  } catch {
    return false;
  }
}

async function resolveWindow(parameters: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> { return parseJsonObject(await runJxa(WINDOW_JXA, ['resolve', JSON.stringify(parameters)], signal)); }
async function execText(executable: string, args: readonly string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> { const result = await execFileAsync(executable, [...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) }); return { stdout: typeof result.stdout === 'string' ? result.stdout : '', stderr: typeof result.stderr === 'string' ? result.stderr : '' }; }
async function commandValue(executable: string, args: readonly string[], signal: AbortSignal | undefined, fallback: string): Promise<string> { try { return (await execText(executable, args, signal)).stdout.trim() || fallback; } catch { return fallback; } }
async function runJxa(script: string, args: readonly string[], signal?: AbortSignal): Promise<string> { return (await execText('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args], signal)).stdout.trim(); }
function spawnWithInput(executable: string, args: readonly string[], input: string, signal?: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const child = spawn(executable, [...args], { stdio: ['pipe', 'ignore', 'pipe'] }); let stderr = ''; child.stderr?.setEncoding('utf8'); child.stderr?.on('data', (chunk: string) => { stderr += chunk; }); const abort = (): void => { child.kill('SIGTERM'); }; signal?.addEventListener('abort', abort, { once: true }); child.once('error', reject); child.once('exit', (code) => { signal?.removeEventListener('abort', abort); if (code === 0) resolve(); else reject(new Error(stderr || `${executable} exited ${code}`)); }); child.stdin?.end(input); }); }
function parseJsonObject(value: string): Record<string, unknown> { const parsed: unknown = JSON.parse(value); if (!isRecord(parsed)) throw new Error('Native macOS backend returned invalid data'); return parsed; }
function pngSize(data: Buffer): Record<string, number> { return data.byteLength >= 24 && data.toString('ascii', 1, 4) === 'PNG' ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) } : {}; }
function parsePsTime(value: string): number { const parts = value.split(':').map(Number); return parts.length === 3 ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]! : parts.length === 2 ? parts[0]! * 60 + parts[1]! : 0; }
function readTopCount(value: unknown): number { if (value === undefined) return 10; const n = readPositiveInteger(value, 'top_count'); if (n > 50) throw new Error('top_count must be from 1 to 50'); return n; }
function readInteger(value: unknown, name: string): number { if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name} must be an integer`); return value; }
function readPositiveInteger(value: unknown, name: string): number { const n = readInteger(value, name); if (n < 1) throw new Error(`${name} must be positive`); return n; }
function extractError(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message.slice(0, 1000) : fallback; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
async function readScreenRecordingState(filePath: string): Promise<{ pid: number; outputPath: string } | null> { try { const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8')); return isRecord(parsed) && typeof parsed.pid === 'number' && typeof parsed.outputPath === 'string' ? { pid: parsed.pid, outputPath: parsed.outputPath } : null; } catch { return null; } }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function cancelledOperation(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'macOS capability operation was cancelled', true)); }
async function canonicalizeNativePath(field: NativePathField, value: string): Promise<string | null> { const absolute = path.resolve(value); try { return await realpath(absolute); } catch { if (field !== 'output_path' && field !== 'target_path') return null; try { const parent = await realpath(path.dirname(absolute)); return path.join(parent, path.basename(absolute)); } catch { return null; } } }
function isWithin(root: string, candidate: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..'); }
function requiresExplicitConfirmation(capability: MacosCapabilityName, input: Record<string, unknown>): boolean { const action = typeof input.action === 'string' ? input.action : typeof input.operation === 'string' ? input.operation : ''; if (capability === 'accessibility') return !['status', 'list_windows', 'observe', 'observe_summary', 'observe_changes', 'inspect_elements', 'find_element', 'read_value'].includes(action); if (capability === 'input_event') return true; if (capability === 'window') return !['list', 'get_active', 'get_bounds', 'get_display', 'resolve'].includes(action); if (capability === 'clipboard') return !['get_text', 'get_image'].includes(action); return capability === 'audio' || (capability === 'screen_record' && action !== 'status') || capability === 'office'; }

const CLIPBOARD_IMAGE_APPLESCRIPT = String.raw`on run argv
  set outputPath to item 1 of argv
  try
    set pngData to the clipboard as «class PNGf»
  on error
    return "NO_IMAGE"
  end try
  set fileRef to open for access POSIX file outputPath with write permission
  try
    set eof fileRef to 0
    write pngData to fileRef
    close access fileRef
  on error errMsg
    try
      close access fileRef
    end try
    error errMsg
  end try
  return "OK"
end run`;

const FILE_DIALOG_JXA = String.raw`function run(argv){const p=JSON.parse(argv[0]);const a=Application.currentApplication();a.includeStandardAdditions=true;const o={};if(p.initialDirectory)o.defaultLocation=Path(p.initialDirectory);try{if(p.action==='open'){if(p.multiSelect)o.multipleSelectionsAllowed=true;const c=a.chooseFile(o);const v=Array.isArray(c)?c:[c];return JSON.stringify({canceled:false,paths:v.map(x=>x.toString())});}if(p.action==='save'){if(p.fileName)o.defaultName=p.fileName;const c=a.chooseFileName(o);return JSON.stringify({canceled:false,path:c.toString()});}throw new Error('Unsupported file dialog action');}catch(e){if(String(e).includes('-128'))return JSON.stringify(p.action==='open'?{canceled:true,paths:[]}:{canceled:true,path:null});throw e;}}`;
const WINDOW_JXA = String.raw`function run(argv){const op=argv[0],p=JSON.parse(argv[1]||'{}'),se=Application('System Events');function s(f,d){try{const v=f();return v===undefined?d:v}catch(e){return d}}function all(){const r=[];s(()=>se.processes(),[]).forEach(pr=>{if(!s(()=>pr.visible(),false))return;const n=s(()=>pr.name(),''),pid=s(()=>pr.unixId(),0);s(()=>pr.windows(),[]).forEach((w,i)=>{const pos=s(()=>w.position(),[0,0]),sz=s(()=>w.size(),[0,0]);r.push({id:String(pid)+':'+i,window_index:i,title:s(()=>w.name(),''),process_name:n,pid,frontmost:s(()=>pr.frontmost(),false),bounds:{x:Number(pos[0]||0),y:Number(pos[1]||0),width:Number(sz[0]||0),height:Number(sz[1]||0)}})});});return r}function res(){let w=all();if(p.process_name)w=w.filter(x=>String(x.process_name).toLowerCase()===String(p.process_name).toLowerCase());if(p.title)w=w.filter(x=>String(x.title).toLowerCase().includes(String(p.title).toLowerCase()));if(p.id)w=w.filter(x=>x.id===String(p.id));if(Number.isInteger(p.window_index))w=w.filter(x=>x.window_index===p.window_index);if(!w.length)throw new Error('Window not found');return w[0]}if(op==='list')return JSON.stringify({windows:all()});if(op==='get_active')return JSON.stringify({window:all().find(x=>x.frontmost)||null});const r=res();if(op==='resolve')return JSON.stringify(r);if(op==='get_bounds')return JSON.stringify(r.bounds);if(op==='get_display')return JSON.stringify({display_id:'1',primary:true,bounds:r.bounds});const pr=s(()=>se.processes(),[]).find(x=>s(()=>x.unixId(),-1)===r.pid);if(!pr)throw new Error('Process not found');const w=s(()=>pr.windows(),[])[r.window_index];if(op==='activate'){pr.frontmost=true;return JSON.stringify({activated:true,window:r})}if(op==='close'){w.close();return JSON.stringify({closed:true,id:r.id})}if(op==='minimize'){w.attributes.byName('AXMinimized').value=true;return JSON.stringify({minimized:true,id:r.id})}if(op==='restore'){try{w.attributes.byName('AXMinimized').value=false}catch(e){}return JSON.stringify({restored:true,id:r.id})}if(op==='move'){w.position=[Number(p.x),Number(p.y)];return JSON.stringify({moved:true,id:r.id})}if(op==='resize'){w.size=[Number(p.width),Number(p.height)];return JSON.stringify({resized:true,id:r.id})}if(op==='set_window_frame'){w.position=[Number(p.x),Number(p.y)];w.size=[Number(p.width),Number(p.height)];return JSON.stringify({framed:true,id:r.id})}if(op==='maximize'){try{w.attributes.byName('AXFullScreen').value=true}catch(e){w.position=[0,0]}return JSON.stringify({maximized:true,id:r.id})}throw new Error('Unsupported window operation: '+op)}`;
const ACCESSIBILITY_JXA = String.raw`function run(argv){const action=argv[0],p=JSON.parse(argv[1]||'{}'),se=Application('System Events');function s(f,d){try{const v=f();return v===undefined?d:v}catch(e){return d}}const procs=s(()=>se.processes(),[]),pr=p.process_name?procs.find(x=>String(s(()=>x.name(),'')).toLowerCase()===String(p.process_name).toLowerCase()):procs.find(x=>s(()=>x.frontmost(),false));if(!pr)throw new Error('Process not found');let ws=s(()=>pr.windows(),[]);if(p.title)ws=ws.filter(w=>String(s(()=>w.name(),'')).toLowerCase().includes(String(p.title).toLowerCase()));const root=ws[Number.isInteger(p.window_index)?p.window_index:0];if(!root)throw new Error('Window not found');const els=[root].concat(s(()=>root.entireContents(),[])).slice(0,Math.min(500,Number(p.max_items||200)));function rec(e){const pos=s(()=>e.position(),[0,0]),sz=s(()=>e.size(),[0,0]);return{name:s(()=>e.name(),''),automation_id:s(()=>e.description(),''),control_type:s(()=>e.role(),''),value:s(()=>e.value(),undefined),bounds:{x:Number(pos[0]||0),y:Number(pos[1]||0),width:Number(sz[0]||0),height:Number(sz[1]||0)}}}if(['observe','observe_summary','observe_changes','inspect_elements'].includes(action))return JSON.stringify({elements:els.map(e=>({depth:0,element:rec(e)})),count:els.length});const found=els.find(e=>(p.name&&String(s(()=>e.name(),'')).toLowerCase()===String(p.name).toLowerCase())||(p.automation_id&&String(s(()=>e.description(),'')).toLowerCase()===String(p.automation_id).toLowerCase()));if(!found)throw new Error('UI element not found');if(action==='find_element')return JSON.stringify({element:rec(found)});if(action==='read_value')return JSON.stringify({value:s(()=>found.value(),s(()=>found.name(),''))});if(action==='focus'){found.focused=true;return JSON.stringify({focused:true,element:rec(found)})}if(action==='set_value'){found.value=String(p.value||'');return JSON.stringify({set:true})}if(['click','select_item','menu_select'].includes(action)){found.click();return JSON.stringify({clicked:true,element:rec(found)})}throw new Error('Unsupported accessibility action: '+action)}`;
const INPUT_JXA = String.raw`function run(argv){const op=argv[0],p=JSON.parse(argv[1]||'{}'),se=Application('System Events');ObjC.import('CoreGraphics');function mouse(type,x,y,b){const e=$.CGEventCreateMouseEvent(null,type,$.CGPointMake(Number(x),Number(y)),b);$.CGEventPost($.kCGHIDEventTap,e)}function click(x,y,right,count){const d=right?$.kCGEventRightMouseDown:$.kCGEventLeftMouseDown,u=right?$.kCGEventRightMouseUp:$.kCGEventLeftMouseUp,b=right?$.kCGMouseButtonRight:$.kCGMouseButtonLeft;for(let i=0;i<count;i++){mouse(d,x,y,b);mouse(u,x,y,b)}}const codes={enter:36,return:36,tab:48,space:49,backspace:51,delete:117,escape:53,esc:53,left:123,right:124,down:125,up:126,home:115,end:119};function using(v){return(v||[]).map(x=>{x=String(x).toLowerCase();return x==='cmd'||x==='command'||x==='win'?'command down':x==='ctrl'||x==='control'?'control down':x==='alt'||x==='option'?'option down':x+' down'})}function press(k,m){const x=String(k).toLowerCase(),u=using(m);if(codes[x]!==undefined)se.keyCode(codes[x],u.length?{using:u}:{});else se.keystroke(String(k),u.length?{using:u}:{})}if(op==='type_text'||op==='paste_text'){se.keystroke(String(p.text||''));return JSON.stringify({typed:op==='type_text',pasted:op==='paste_text'})}if(op==='press_key'){press(p.key,[]);return JSON.stringify({pressed:true})}if(op==='hotkey'){press(p.key,p.modifiers);return JSON.stringify({pressed:true})}if(op==='mouse_move'){mouse($.kCGEventMouseMoved,p.x,p.y,$.kCGMouseButtonLeft);return JSON.stringify({moved:true})}if(op==='click'||op==='double_click'||op==='right_click'){mouse($.kCGEventMouseMoved,p.x,p.y,$.kCGMouseButtonLeft);click(p.x,p.y,op==='right_click',op==='double_click'?2:1);return JSON.stringify({clicked:true})}if(op==='scroll'){const e=$.CGEventCreateScrollWheelEvent(null,$.kCGScrollEventUnitPixel,2,Number(p.delta_y||0),Number(p.delta_x||0));$.CGEventPost($.kCGHIDEventTap,e);return JSON.stringify({scrolled:true})}return JSON.stringify({available:false,ready:false,reason:op+' is not implemented on macOS yet'})}`;
