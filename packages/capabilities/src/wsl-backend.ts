import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  appError,
  err,
  isApplicationAuthorized,
  isFullBypassAuthorization,
  ok,
  type InvocationAuthorization,
  type Result,
} from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { prohibitedAgentCommandReason, riskyAgentCommandReason } from './agent-command-policy.js';
import { capabilityTaskOwnerMatches, readCapabilityActiveWorkspaceRoot, readCapabilityTaskOwner, type CapabilityTaskOwner } from './task-ownership.js';

type WslOperation = 'run' | 'status' | 'wait' | 'logs' | 'result' | 'cancel';
type WslExecution = 'foreground' | 'background' | 'auto';

interface WslRequest {
  readonly operation: WslOperation;
  readonly workspaceId?: string;
  readonly distro: string;
  readonly executable?: string;
  readonly arguments: readonly string[];
  readonly cwd?: string;
  readonly activeWorkspaceRoot?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly execution: WslExecution;
  readonly taskId?: string;
  readonly timeoutSeconds: number;
  readonly maxOutputBytes: number;
  readonly tailLines?: number;
  readonly includeStdout: boolean;
  readonly includeStderr: boolean;
  readonly dryRun: boolean;
  readonly userConfirmed: boolean;
  readonly owner: CapabilityTaskOwner;
  readonly metadata?: Readonly<Record<string, unknown>>;
}


export interface WslCapabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly runner: CapabilityBackend;
  readonly allowedRoots: readonly string[];
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
  readonly availabilityProbe?: () => Promise<Result<unknown>>;
  readonly defaultDistro?: string;
  readonly defaultTimeoutSeconds?: number;
  readonly maxOutputBytes?: number;
}

export interface WslFilesystemCapabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly allowedRoots: readonly string[];
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
  readonly availabilityProbe?: () => Promise<Result<unknown>>;
  readonly defaultDistro?: string;
}

interface WslTaskOwner {
  readonly workspaceId: string;
  readonly distro: string;
  readonly owner: CapabilityTaskOwner;
}

const DEFAULT_TIMEOUT_SECONDS = 3_600;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 14_400;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ENVIRONMENT_VALUE_LENGTH = 4_096;
const WSL_OPERATIONS: readonly WslOperation[] = ['run', 'status', 'wait', 'logs', 'result', 'cancel'];
const WSL_EXECUTION_MODES: readonly WslExecution[] = ['foreground', 'background', 'auto'];
const SHELL_STRING_FLAGS = new Set(['-c', '-lc', '-cl', '--command', '-command', '-encodedcommand', '-e', '--eval']);
const SHELL_INTERPRETERS = new Set(['sh', 'dash', 'bash', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd', 'node', 'python', 'python3', 'perl', 'ruby']);

export class WslCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly runner: CapabilityBackend;
  private readonly allowedRoots: readonly string[];
  private readonly allowedRootsProvider: (() => Promise<readonly string[]>) | undefined;
  private readonly availabilityProbe: (() => Promise<Result<unknown>>) | undefined;
  private readonly defaultDistro: string;
  private readonly defaultTimeoutSeconds: number;
  private readonly maxOutputBytes: number;
  private readonly taskOwners = new Map<string, WslTaskOwner>();

  public constructor(options: WslCapabilityOptions) {
    if (options.allowedRoots.length === 0) throw new Error('At least one WSL workspace root is required');
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner;
    this.allowedRoots = options.allowedRoots.map((root) => path.win32.resolve(root));
    this.allowedRootsProvider = options.allowedRootsProvider;
    this.availabilityProbe = options.availabilityProbe;
    this.defaultDistro = normalizeDistro(options.defaultDistro ?? 'default') ?? 'default';
    this.defaultTimeoutSeconds = clampNumber(options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 0.1, MAX_TIMEOUT_SECONDS);
    this.maxOutputBytes = Math.floor(clampNumber(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES));
  }

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const parsed = parseWslRequest(input, this.defaultDistro, this.defaultTimeoutSeconds, this.maxOutputBytes);
    if (!parsed.ok) return parsed;
    if (parsed.value.operation === 'status' && parsed.value.taskId === undefined) return this.status();
    if (parsed.value.workspaceId === undefined) return err(appError('INVALID_INPUT', 'workspaceId is required for WSL task operations'));

    if (parsed.value.operation === 'run') return this.run(parsed.value, signal, authorization);
    const taskOwner = this.taskOwners.get(parsed.value.taskId ?? '');
    if (taskOwner === undefined) return err(appError('PROCESS_NOT_FOUND', 'WSL task was not found'));
    if (taskOwner.workspaceId !== parsed.value.workspaceId) return err(appError('PERMISSION_DENIED', 'WSL task belongs to another workspace'));
    if (taskOwner.distro !== parsed.value.distro) return err(appError('PERMISSION_DENIED', 'WSL task belongs to another distribution'));
    if (!capabilityTaskOwnerMatches(taskOwner.owner, parsed.value.owner)) return err(appError('PERMISSION_DENIED', 'WSL task belongs to another client session'));
    if (parsed.value.operation === 'cancel' && !isApplicationAuthorized(authorization, parsed.value.userConfirmed)) return err(appError('PERMISSION_REQUIRED', 'Cancelling a WSL task requires explicit user confirmation'));

    const forwarded = this.forwardTaskRequest(parsed.value);
    const result = await this.runner.execute(forwarded, signal, authorization);
    return annotateResult(result, this.metadata(parsed.value.workspaceId, parsed.value.distro));
  }

  private async run(request: WslRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return ok({ available: false, ready: false, local: true, backend: 'wsl', reason: 'WSL is only available on Windows' });
    if (request.executable === undefined) return err(appError('INVALID_INPUT', 'WSL executable is required'));
    if (containsShellString(request.executable, request.arguments)) return err(appError('INVALID_INPUT', 'WSL execution accepts argv only; shell command strings are not allowed'));
    if (!request.dryRun && !isFullBypassAuthorization(authorization)) {
      const prohibitedReason = prohibitedAgentCommandReason(request.executable, request.arguments);
      if (prohibitedReason !== undefined) return err(appError('PERMISSION_DENIED', prohibitedReason));
      const riskyReason = riskyAgentCommandReason(request.executable, request.arguments);
      if (riskyReason !== undefined && !isApplicationAuthorized(authorization, request.userConfirmed)) return err(appError('PERMISSION_REQUIRED', riskyReason));
    }

    const cwd = await this.resolveWorkspaceCwd(request.cwd, request.activeWorkspaceRoot, authorization);
    if (!cwd.ok) return cwd;
    const linuxCwd = windowsToWslPath(cwd.value);
    if (!linuxCwd.ok) return linuxCwd;
    if (request.dryRun) {
      return ok({
        dry_run: true,
        backend: 'wsl',
        workspace_id: request.workspaceId,
        distro: request.distro,
        linux_cwd: linuxCwd.value,
        executable: request.executable,
        arguments: [...request.arguments],
      });
    }
    const forwarded = {
      operation: 'run',
      executable: 'wsl.exe',
      arguments: buildWslArguments(request, linuxCwd.value),
      cwd: cwd.value,
      execution: request.execution,
      privilege: 'user',
      workspace_id: request.workspaceId,
      timeout_seconds: request.timeoutSeconds,
      max_output_bytes: request.maxOutputBytes,
      ...(request.tailLines === undefined ? {} : { tail_lines: request.tailLines }),
      include_stdout: request.includeStdout,
      include_stderr: request.includeStderr,
      dry_run: request.dryRun,
      userConfirmed: request.userConfirmed,
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    };
    const result = await this.runner.execute(forwarded, signal, authorization);
    const annotated = annotateResult(result, {
      ...this.metadata(request.workspaceId, request.distro),
      linux_cwd: linuxCwd.value,
    });
    if (annotated.ok && isRecord(annotated.value) && typeof annotated.value.task_id === 'string') {
      this.taskOwners.set(annotated.value.task_id, { workspaceId: request.workspaceId!, distro: request.distro, owner: request.owner });
    }
    return annotated;
  }

  private async status(): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return ok({ available: false, ready: false, local: true, backend: 'wsl', reason: 'WSL is only available on Windows' });
    if (this.availabilityProbe !== undefined) {
      const result = await this.availabilityProbe();
      return annotateResult(result, { backend: 'wsl', local: true });
    }
    return ok({ available: true, ready: true, local: true, backend: 'wsl', reason: 'wsl.exe is available; distribution state is checked on execution' });
  }

  private forwardTaskRequest(request: WslRequest): Record<string, unknown> {
    return {
      operation: request.operation,
      task_id: request.taskId,
      timeout_seconds: request.timeoutSeconds,
      max_output_bytes: request.maxOutputBytes,
      ...(request.tailLines === undefined ? {} : { tail_lines: request.tailLines }),
      include_stdout: request.includeStdout,
      include_stderr: request.includeStderr,
      dry_run: request.dryRun,
      userConfirmed: request.userConfirmed,
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    };
  }

  private metadata(workspaceId: string | undefined, distro: string): Record<string, unknown> {
    return { backend: 'wsl', distro, ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }) };
  }

  private async resolveWorkspaceCwd(
    requestedCwd: string | undefined,
    activeWorkspaceRoot: string | undefined,
    authorization?: InvocationAuthorization,
  ): Promise<Result<string>> {
    if (requestedCwd !== undefined && !path.win32.isAbsolute(requestedCwd) && activeWorkspaceRoot === undefined) {
      return err(appError('INVALID_INPUT', 'WSL cwd must be an absolute Windows path'));
    }
    if (isFullBypassAuthorization(authorization) && requestedCwd !== undefined && path.win32.isAbsolute(requestedCwd)) {
      try {
        const canonical = await realpath(requestedCwd);
        if (!(await stat(canonical)).isDirectory()) return err(appError('INVALID_INPUT', 'WSL cwd must be a directory'));
        return ok(canonical);
      } catch {
        return err(appError('FILE_NOT_FOUND', 'WSL cwd was not found'));
      }
    }
    const configuredRoots = this.allowedRootsProvider === undefined ? this.allowedRoots : (await this.allowedRootsProvider()).map((root) => path.win32.resolve(root));
    if (configuredRoots.length === 0) return err(appError('FILE_NOT_FOUND', 'No registered workspace root is available'));
    if (activeWorkspaceRoot === undefined) {
      const candidate = path.win32.resolve(requestedCwd ?? configuredRoots[0]!);
      if (!configuredRoots.some((root) => isWithinWindowsRoot(root, candidate))) {
        return err(appError('PATH_OUTSIDE_WORKSPACE', 'WSL cwd is outside registered workspace roots'));
      }
      return ok(candidate);
    }
    if (!path.win32.isAbsolute(activeWorkspaceRoot)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Host active workspace root is invalid'));
    }
    const canonicalRoots: string[] = [];
    for (const root of configuredRoots) {
      try {
        const canonicalRoot = await realpath(root);
        if ((await stat(canonicalRoot)).isDirectory()) canonicalRoots.push(canonicalRoot);
      } catch {
        continue;
      }
    }
    if (canonicalRoots.length === 0) return err(appError('FILE_NOT_FOUND', 'No registered workspace root is available'));
    let canonicalActiveRoot: string;
    try {
      canonicalActiveRoot = await realpath(activeWorkspaceRoot);
      if (!(await stat(canonicalActiveRoot)).isDirectory()) return err(appError('INVALID_INPUT', 'Host active workspace root must be a directory'));
    } catch {
      return err(appError('FILE_NOT_FOUND', 'Host active workspace root was not found'));
    }
    if (!canonicalRoots.some((root) => isWithinWindowsRoot(root, canonicalActiveRoot))) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Host active workspace root is outside registered workspace roots'));
    }
    const candidate = requestedCwd === undefined
      ? canonicalActiveRoot
      : path.win32.resolve(canonicalActiveRoot, requestedCwd);
    let canonicalCandidate: string;
    try {
      canonicalCandidate = await realpath(candidate);
      if (!(await stat(canonicalCandidate)).isDirectory()) return err(appError('INVALID_INPUT', 'WSL cwd must be a directory'));
    } catch {
      return err(appError('FILE_NOT_FOUND', 'WSL cwd was not found'));
    }
    if (!canonicalRoots.some((root) => isWithinWindowsRoot(root, canonicalCandidate))) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'WSL cwd is outside registered workspace roots'));
    }
    if (!isWithinWindowsRoot(canonicalActiveRoot, canonicalCandidate)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'WSL cwd is outside the host active workspace'));
    }
    return ok(canonicalCandidate);
  }
}

export class WslFilesystemCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly allowedRoots: readonly string[];
  private readonly allowedRootsProvider: (() => Promise<readonly string[]>) | undefined;
  private readonly availabilityProbe: (() => Promise<Result<unknown>>) | undefined;
  private readonly defaultDistro: string;

  public constructor(options: WslFilesystemCapabilityOptions) {
    if (options.allowedRoots.length === 0) throw new Error('At least one WSL filesystem root is required');
    this.platform = options.platform ?? process.platform;
    this.allowedRoots = options.allowedRoots.map((root) => path.win32.resolve(root));
    this.allowedRootsProvider = options.allowedRootsProvider;
    this.availabilityProbe = options.availabilityProbe;
    this.defaultDistro = normalizeDistro(options.defaultDistro ?? 'default') ?? 'default';
  }

  public async execute(input: unknown, _signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'WSL filesystem input must be an object'));
    if (input.operation === 'status') {
      if (this.platform === 'win32' && this.availabilityProbe !== undefined) {
        const probe = await this.availabilityProbe();
        return annotateResult(probe, { backend: 'wsl_fs', raw_access: false });
      }
      return ok(this.platform === 'win32'
        ? { available: true, ready: true, local: true, backend: 'wsl_fs', raw_access: false }
        : { available: false, ready: false, local: true, backend: 'wsl_fs', raw_access: false, reason: 'WSL is only available on Windows' });
    }
    const workspaceId = readNonEmptyString(input.workspaceId);
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', 'workspaceId is required for WSL filesystem operations'));
    const operation = input.operation === undefined ? 'translate' : input.operation;
    if (operation !== 'translate' && operation !== 'metadata') return err(appError('INVALID_INPUT', 'WSL filesystem operation is invalid'));
    const direction = input.direction;
    if (direction !== 'windows_to_wsl' && direction !== 'wsl_to_windows') return err(appError('INVALID_INPUT', 'WSL filesystem direction is invalid'));
    const rawPath = typeof input.path === 'string' ? input.path : undefined;
    if (rawPath === undefined || rawPath.trim().length === 0 || rawPath.includes('\0')) return err(appError('INVALID_INPUT', 'WSL filesystem path is invalid'));
    const distro = normalizeDistro(typeof input.distro === 'string' ? input.distro : this.defaultDistro);
    if (distro === undefined) return err(appError('INVALID_INPUT', 'WSL distribution is invalid'));

    if (direction === 'windows_to_wsl') {
      const candidate = path.win32.resolve(rawPath);
      const roots = this.allowedRootsProvider === undefined ? this.allowedRoots : (await this.allowedRootsProvider()).map((root) => path.win32.resolve(root));
      if (!isFullBypassAuthorization(authorization) && !roots.some((root) => isWithinWindowsRoot(root, candidate))) return err(appError('PATH_OUTSIDE_WORKSPACE', 'WSL filesystem path is outside registered workspace roots'));
      const translated = windowsToWslPath(candidate);
      if (!translated.ok) return translated;
      if (operation === 'metadata') return this.windowsMetadata(workspaceId, candidate, translated.value, distro);
      return ok({ workspace_id: workspaceId, distro, direction, path: translated.value, windows_path: candidate, raw_access: false });
    }

    const translated = wslToWindowsPath(rawPath, distro);
    if (!translated.ok) return translated;
    if (operation === 'metadata') {
      return ok({ workspace_id: workspaceId, distro, direction, path: translated.value, wsl_path: rawPath, raw_access: false, exists: 'unknown' });
    }
    return ok({ workspace_id: workspaceId, distro, direction, path: translated.value, wsl_path: rawPath, raw_access: false });
  }

  private async windowsMetadata(workspaceId: string, windowsPath: string, wslPath: string, distro: string): Promise<Result<unknown>> {
    try {
      const details = await stat(windowsPath);
      return ok({
        workspace_id: workspaceId,
        distro,
        direction: 'windows_to_wsl',
        path: wslPath,
        windows_path: windowsPath,
        raw_access: false,
        exists: true,
        kind: details.isDirectory() ? 'directory' : 'file',
        size: details.size,
        modified_at: details.mtime.toISOString(),
      });
    } catch {
      return ok({ workspace_id: workspaceId, distro, direction: 'windows_to_wsl', path: wslPath, windows_path: windowsPath, raw_access: false, exists: false });
    }
  }
}

function parseWslRequest(value: unknown, defaultDistro: string, defaultTimeoutSeconds: number, maxOutputBytes: number): Result<WslRequest> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'WSL input must be an object'));
  const operation = value.operation === undefined ? 'run' : value.operation;
  if (!isWslOperation(operation)) return err(appError('INVALID_INPUT', 'WSL operation is invalid'));
  const workspaceId = value.workspaceId === undefined ? undefined : readNonEmptyString(value.workspaceId);
  if (value.workspaceId !== undefined && workspaceId === undefined) return err(appError('INVALID_INPUT', 'workspaceId is invalid'));
  const distro = normalizeDistro(typeof value.distro === 'string' ? value.distro : defaultDistro);
  if (distro === undefined) return err(appError('INVALID_INPUT', 'WSL distribution is invalid'));
  const executable = value.executable === undefined ? undefined : value.executable;
  if (executable !== undefined && (typeof executable !== 'string' || executable.trim().length === 0 || executable.includes('\0'))) return err(appError('INVALID_INPUT', 'WSL executable is invalid'));
  const rawArguments = value.arguments === undefined ? [] : value.arguments;
  if (!Array.isArray(rawArguments) || rawArguments.length > 128 || !rawArguments.every((item) => typeof item === 'string' && !item.includes('\0') && item.length <= 32_768)) return err(appError('INVALID_INPUT', 'WSL arguments are invalid'));
  const cwd = value.cwd === undefined ? undefined : value.cwd;
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.includes('\0'))) return err(appError('INVALID_INPUT', 'WSL cwd is invalid'));
  const taskId = value.task_id === undefined ? undefined : readNonEmptyString(value.task_id);
  if (value.task_id !== undefined && taskId === undefined) return err(appError('INVALID_INPUT', 'WSL task ID is invalid'));
  const execution = value.execution === undefined ? 'auto' : value.execution;
  if (!isWslExecution(execution)) return err(appError('INVALID_INPUT', 'WSL execution mode is invalid'));
  const timeoutSeconds = value.timeout_seconds === undefined ? defaultTimeoutSeconds : value.timeout_seconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0.1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) return err(appError('INVALID_INPUT', 'WSL timeout is invalid'));
  const requestedMaxBytes = value.max_output_bytes === undefined ? maxOutputBytes : value.max_output_bytes;
  if (typeof requestedMaxBytes !== 'number' || !Number.isInteger(requestedMaxBytes) || requestedMaxBytes < 1 || requestedMaxBytes > MAX_OUTPUT_BYTES) return err(appError('INVALID_INPUT', 'WSL output limit is invalid'));
  const tailLines = value.tail_lines === undefined ? undefined : value.tail_lines;
  if (tailLines !== undefined && (typeof tailLines !== 'number' || !Number.isInteger(tailLines) || tailLines < 0 || tailLines > 10_000)) return err(appError('INVALID_INPUT', 'WSL tail limit is invalid'));
  const includeStdout = value.include_stdout === undefined ? true : value.include_stdout;
  const includeStderr = value.include_stderr === undefined ? true : value.include_stderr;
  const dryRun = value.dry_run === undefined ? false : value.dry_run;
  if (typeof includeStdout !== 'boolean' || typeof includeStderr !== 'boolean' || typeof dryRun !== 'boolean') return err(appError('INVALID_INPUT', 'WSL flags are invalid'));
  const userConfirmed = value.userConfirmed === true;
  const owner = readCapabilityTaskOwner(value);
  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  const activeWorkspaceRoot = readCapabilityActiveWorkspaceRoot(value);
  const environment = parseEnvironment(value.environment);
  if (!environment.ok) return environment;
  return ok({ operation, ...(workspaceId === undefined ? {} : { workspaceId }), distro, ...(executable === undefined ? {} : { executable: executable.trim() }), arguments: rawArguments, ...(cwd === undefined ? {} : { cwd }), ...(activeWorkspaceRoot === undefined ? {} : { activeWorkspaceRoot }), environment: environment.value, execution, ...(taskId === undefined ? {} : { taskId }), timeoutSeconds, maxOutputBytes: requestedMaxBytes, ...(tailLines === undefined ? {} : { tailLines }), includeStdout, includeStderr, dryRun, userConfirmed, owner, ...(metadata === undefined ? {} : { metadata }) });
}

function parseEnvironment(value: unknown): Result<Readonly<Record<string, string>>> {
  if (value === undefined) return ok({});
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'WSL environment must be a key/value object'));
  const entries = Object.entries(value);
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) return err(appError('INVALID_INPUT', 'WSL environment has too many entries'));
  const parsed: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== 'string' || item.length > MAX_ENVIRONMENT_VALUE_LENGTH || item.includes('\0')) {
      return err(appError('INVALID_INPUT', 'WSL environment contains an invalid entry'));
    }
    parsed[key] = item;
  }
  return ok(parsed);
}

function buildWslArguments(request: WslRequest, linuxCwd: string): string[] {
  const args = [...(request.distro === 'default' ? [] : ['--distribution', request.distro]), '--cd', linuxCwd, '--exec'];
  const environmentEntries = Object.entries(request.environment).sort(([left], [right]) => left.localeCompare(right));
  if (environmentEntries.length > 0) {
    args.push('env', ...environmentEntries.map(([key, value]) => `${key}=${value}`));
  }
  args.push(request.executable!, ...request.arguments);
  return args;
}

function containsShellString(executable: string, args: readonly string[]): boolean {
  const basename = path.posix.basename(executable.replaceAll('\\', '/')).toLowerCase();
  if (!SHELL_INTERPRETERS.has(basename)) return false;
  return args.some((argument) => SHELL_STRING_FLAGS.has(argument.toLowerCase()));
}

function windowsToWslPath(value: string): Result<string> {
  const normalized = path.win32.normalize(value);
  const match = /^([A-Za-z]):\\(.*)$/.exec(normalized);
  if (match === null) return err(appError('INVALID_INPUT', 'Only drive-letter Windows paths can be mapped to WSL'));
  const drive = match[1]!.toLowerCase();
  const rest = match[2]!.replaceAll('\\', '/');
  return ok(`/mnt/${drive}${rest.length === 0 ? '' : `/${rest}`}`);
}

function wslToWindowsPath(value: string, distro: string): Result<string> {
  if (!value.startsWith('/') || value.includes('\0')) return err(appError('INVALID_INPUT', 'WSL path must be an absolute POSIX path'));
  const segments = value.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '..')) return err(appError('INVALID_INPUT', 'WSL parent traversal is not allowed'));
  const normalized = `/${segments.join('/')}`;
  const mount = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(normalized);
  if (mount !== null) {
    const suffix = mount[2] === undefined ? '' : `\\${mount[2].replaceAll('/', '\\')}`;
    return ok(`${mount[1]!.toUpperCase()}:${suffix}`);
  }
  return ok(`\\\\wsl.localhost\\${distro}${normalized.replaceAll('/', '\\')}`);
}

function isWithinWindowsRoot(root: string, candidate: string): boolean {
  const normalizedRoot = path.win32.resolve(root).toLowerCase();
  const normalizedCandidate = path.win32.resolve(candidate).toLowerCase();
  const relative = path.win32.relative(normalizedRoot, normalizedCandidate);
  if (relative === '') return true;
  if (path.win32.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(path.win32.sep);
  return firstSegment !== '..';
}

function normalizeDistro(value: string): string | undefined {
  const trimmed = value.trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(trimmed) ? trimmed : undefined;
}

function annotateResult(result: Result<unknown>, metadata: Record<string, unknown>): Result<unknown> {
  if (!result.ok || !isRecord(result.value)) return result;
  return ok({ ...result.value, ...metadata });
}

function isWslOperation(value: unknown): value is WslOperation {
  return typeof value === 'string' && WSL_OPERATIONS.some((operation) => operation === value);
}

function isWslExecution(value: unknown): value is WslExecution {
  return typeof value === 'string' && WSL_EXECUTION_MODES.some((mode) => mode === value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
