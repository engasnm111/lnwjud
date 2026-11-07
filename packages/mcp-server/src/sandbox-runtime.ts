import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { constants, copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, isApplicationAuthorized, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import type { McpApplicationServices } from './tools/tool-types.js';
import { buildSandboxExecutionPlan } from './sandbox-contract.js';

/**
 * Wave 5 sandbox runtime: stages the .wsb plan from sandbox-contract.ts,
 * launches WindowsSandbox.exe, and retrieves the artifact-only output.
 * Dry-run is the default; a real detonation additionally requires
 * userConfirmed (enforced here and by the central destructive policy).
 */

export interface SandboxRuntimeOptions {
  readonly platform?: NodeJS.Platform;
  readonly sandboxExecutable?: string;
  readonly pollMs?: number;
  readonly startupGraceSeconds?: number;
  readonly maxArtifactBytes?: number;
  /** Injectable for tests. */
  readonly launcher?: (executable: string, args: readonly string[]) => Promise<Result<void>>;
  readonly waiter?: (file: string, deadlineMs: number, signal?: AbortSignal) => Promise<boolean>;
}

export const SANDBOX_RUNNER_SCRIPT = [
  '$ErrorActionPreference = \'Continue\'',
  'try {',
  '$manifestPath = \'C:\\lnwjud\\output\\job-manifest.json\'',
  '$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json',
  '$quoted = @($manifest.arguments | ForEach-Object {',
  '  $argument = [string]$_',
  "  if ($argument -match '\\s') { '\"' + $argument.Replace('\"', '\\\"') + '\"' } else { $argument }",
  '})',
  '$psi = [System.Diagnostics.ProcessStartInfo]::new()',
  '$psi.FileName = [string]$manifest.executable',
  "$psi.Arguments = $quoted -join ' '",
  '$psi.UseShellExecute = $false',
  '$psi.CreateNoWindow = $true',
  '$psi.RedirectStandardOutput = $true',
  '$psi.RedirectStandardError = $true',
  '$process = $null',
  '$exitCode = 124',
  '$stdoutFile = [System.IO.File]::Create([string]$manifest.stdout)',
  '$stderrFile = [System.IO.File]::Create([string]$manifest.stderr)',
  'try {',
  '  $process = [System.Diagnostics.Process]::Start($psi)',
  "  if ($null -eq $process) { throw 'SANDBOX_PROCESS_START_FAILED' }",
  '  $stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdoutFile)',
  '  $stderrCopy = $process.StandardError.BaseStream.CopyToAsync($stderrFile)',
  '  if ($process.WaitForExit([int]$manifest.timeoutSeconds * 1000)) {',
  '    $drained = [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($stdoutCopy, $stderrCopy), 5000)',
  '    if ($drained) { $exitCode = [int]$process.ExitCode }',
  '  } else {',
  '    $process.Kill()',
  '    $process.WaitForExit()',
  '  }',
  '} catch {',
  '  if ($null -ne $process -and -not $process.HasExited) { $process.Kill() }',
  '} finally {',
  '  $stdoutFile.Dispose()',
  '  $stderrFile.Dispose()',
  '  if ($null -ne $process) { $process.Dispose() }',
  '}',
  "  $receiptTemp = [string]$manifest.exitCode + '.pending'",
  '  [System.IO.File]::WriteAllText($receiptTemp, ([string]$exitCode + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))',
  '  [System.IO.File]::Move($receiptTemp, [string]$manifest.exitCode)',
  '} finally {',
  '  Start-Sleep -Seconds 2',
  "  & (Join-Path $env:SystemRoot 'System32\\shutdown.exe') /s /t 0 /f",
  '}',
].join('\n');

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_STARTUP_GRACE_SECONDS = 60;
const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024;

export class SandboxRuntimeService {
  private readonly platform: NodeJS.Platform;
  private readonly sandboxExecutable: string;
  private readonly pollMs: number;
  private readonly startupGraceSeconds: number;
  private readonly maxArtifactBytes: number;
  private readonly launcher: (executable: string, args: readonly string[]) => Promise<Result<void>>;
  private readonly waiter: (file: string, deadlineMs: number, signal?: AbortSignal) => Promise<boolean>;

  public constructor(
    private readonly services: McpApplicationServices,
    private readonly actor: FileActor,
    options: SandboxRuntimeOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    this.sandboxExecutable = options.sandboxExecutable ?? (systemRoot === undefined
      ? 'WindowsSandbox.exe'
      : path.join(systemRoot, 'System32', 'WindowsSandbox.exe'));
    this.pollMs = Math.max(100, options.pollMs ?? DEFAULT_POLL_MS);
    this.startupGraceSeconds = Math.max(0, options.startupGraceSeconds ?? DEFAULT_STARTUP_GRACE_SECONDS);
    this.maxArtifactBytes = Math.max(1_024, options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES);
    this.launcher = options.launcher ?? defaultLauncher();
    this.waiter = options.waiter ?? defaultWaiter(this.pollMs);
  }

  public async execute(input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return ok(this.unavailable('unsupported_platform'));
    if (!existsSync(this.sandboxExecutable)) return ok(this.unavailable('windows_sandbox_feature_missing'));
    const workspaceId = readTrimmed(input.workspaceId);
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', 'sandbox_exec requires workspaceId'));
    const root = await this.workspaceRoot(workspaceId);
    if (!root.ok) return root;

    const jobId = readTrimmed(input.jobId) ?? `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const staging = path.win32.join(root.value, '.lnwjud', 'sandbox', jobId);
    const inputPath = path.win32.join(staging, 'input');
    const outputPath = path.win32.join(staging, 'output');
    const executable = readTrimmed(input.executable);
    if (executable === undefined) return err(appError('INVALID_INPUT', 'sandbox_exec requires executable'));
    const inputFile = readTrimmed(input.inputFile);
    const inputSha256 = readTrimmed(input.inputSha256);
    if ((inputFile === undefined) !== (inputSha256 === undefined)
      || (inputFile !== undefined && (executable !== 'C:\\lnwjud\\input\\payload.exe' || !/^[a-f0-9]{64}$/.test(inputSha256!)))) {
      return err(appError('INVALID_INPUT', 'Sandbox executable staging requires an exact SHA-256 and fixed guest payload path'));
    }
    if (inputFile !== undefined && !sandboxSourceWithin(root.value, inputFile)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Sandbox input executable must be a file inside the registered workspace'));
    }
    const args = Array.isArray(input.arguments) ? input.arguments.map((value) => String(value)) : [];
    const timeoutSeconds = typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds : undefined;

    const plan = buildSandboxExecutionPlan({
      workspaceId, allowedRoots: [root.value], inputPath, outputPath, executable, arguments: args,
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }), jobId,
    });
    if (!plan.ok) return plan;
    if (input.dryRun !== false) return ok({ ...plan.value, dryRun: true, executed: false });
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Sandbox detonation was cancelled', true));
    if (!isApplicationAuthorized(authorization, input.userConfirmed === true)) {
      return err(appError('PERMISSION_REQUIRED', 'Sandbox detonation requires explicit chat confirmation. Ask the user first, then retry with userConfirmed: true'));
    }

    // Create each job directory exclusively: reusing an ID could make a stale
    // exit-code.txt appear to be proof of a new sandbox execution.
    await mkdir(path.win32.dirname(staging), { recursive: true });
    try {
      await mkdir(staging);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
        return err(appError('INVALID_INPUT', 'Sandbox job ID already exists; previous artifacts cannot be reused'));
      }
      throw error;
    }
    await mkdir(inputPath);
    await mkdir(outputPath);
    if (inputFile !== undefined) {
      const staged = await stageSandboxExecutable(root.value, inputFile, inputSha256!, path.win32.join(inputPath, 'payload.exe'));
      if (!staged.ok) return staged;
    }
    await writeFile(path.win32.join(inputPath, 'sandbox-runner.ps1'), SANDBOX_RUNNER_SCRIPT, 'utf8');
    await writeFile(path.win32.join(outputPath, 'job-manifest.json'), JSON.stringify(plan.value.jobManifest, null, 2), 'utf8');
    const wsbPath = path.win32.join(staging, 'job.wsb');
    await writeFile(wsbPath, plan.value.wsbXml, 'utf8');

    const launched = await this.launcher(this.sandboxExecutable, [wsbPath]);
    if (!launched.ok) return launched;
    const deadlineMs = Date.now() + (plan.value.jobManifest.timeoutSeconds + this.startupGraceSeconds) * 1_000;
    const finished = await this.waiter(path.win32.join(outputPath, 'exit-code.txt'), deadlineMs, signal);
    if (!finished) {
      return err(appError('PROCESS_TIMEOUT', `Sandbox job ${jobId} did not produce exit-code.txt within ${plan.value.jobManifest.timeoutSeconds + this.startupGraceSeconds}s`, true));
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      readBounded(path.win32.join(outputPath, 'exit-code.txt'), 64),
      readBounded(path.win32.join(outputPath, 'stdout.log'), this.maxArtifactBytes),
      readBounded(path.win32.join(outputPath, 'stderr.log'), this.maxArtifactBytes),
    ]);
    const exitCodeText = exitCode.trim();
    if (!/^(?:0|-[1-9][0-9]{0,9}|[1-9][0-9]{0,9})$/.test(exitCodeText)
      || Number(exitCodeText) < -2_147_483_648 || Number(exitCodeText) > 2_147_483_647) {
      return err(appError('INTERNAL_ERROR', 'Sandbox exit-code artifact is missing or invalid', true));
    }
    const parsedExitCode = Number(exitCodeText);
    return ok({
      tool: 'sandbox_exec',
      status: 'ready',
      available: true,
      executed: true,
      jobId,
      networking: 'disabled',
      exitCode: parsedExitCode,
      stdout,
      stderr,
      artifacts: plan.value.outputArtifact.files,
      stagingDirectory: staging,
    });
  }

  private async workspaceRoot(workspaceId: string): Promise<Result<string>> {
    const workspaceInfo = this.services.workspaceInfo;
    if (workspaceInfo === undefined) {
      return err(appError('INTERNAL_ERROR', 'Workspace registry is unavailable; refusing sandbox staging outside a verified registered workspace', true));
    }
    const info = await workspaceInfo.info(this.actor, workspaceId);
    if (!info.ok) return info;
    const rootPath = typeof (info.value as { realRootPath?: unknown }).realRootPath === 'string'
      ? (info.value as { realRootPath: string }).realRootPath
      : undefined;
    return rootPath === undefined
      ? err(appError('INTERNAL_ERROR', 'Workspace root could not be resolved for sandbox staging', true))
      : ok(rootPath);
  }

  private unavailable(reason: string): Record<string, unknown> {
    return {
      tool: 'sandbox_exec', status: this.platform === 'win32' ? 'needs_setup' : 'unsupported', available: false, ready: false, executed: false,
      reason, readinessReason: this.platform === 'win32' ? reason : 'unsupported_platform',
      requirements: ['Windows Sandbox feature', 'interactive user session', 'artifact output directory'],
      primitiveFallbacks: ['read_file', 'search_text', 'workspace_tree'],
    };
  }
}

function defaultLauncher(): (executable: string, args: readonly string[]) => Promise<Result<void>> {
  return (executable, args): Promise<Result<void>> => new Promise((resolve) => {
    const child = spawn(executable, [...args], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', () => resolve(err(appError('INTERNAL_ERROR', 'WindowsSandbox.exe could not start', true))));
    child.once('spawn', () => { child.unref(); resolve(ok(undefined)); });
  });
}

function defaultWaiter(pollMs: number): (file: string, deadlineMs: number, signal?: AbortSignal) => Promise<boolean> {
  return async (file, deadlineMs, signal): Promise<boolean> => {
    while (Date.now() < deadlineMs) {
      if (signal?.aborted === true) return false;
      if (existsSync(file)) return true;
      await delay(pollMs);
    }
    return existsSync(file);
  };
}

async function readBounded(file: string, maxBytes: number): Promise<string> {
  try {
    const content = await readFile(file, 'utf8');
    return Buffer.byteLength(content, 'utf8') <= maxBytes ? content : `${content.slice(0, maxBytes)}\n[truncated]`;
  } catch {
    return '';
  }
}

function readTrimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function sandboxSourceWithin(root: string, source: string): boolean {
  if (!path.win32.isAbsolute(source) || source.includes('\0') || path.win32.extname(source).toLowerCase() !== '.exe') return false;
  const relative = path.win32.relative(path.win32.resolve(root).toLowerCase(), path.win32.resolve(source).toLowerCase());
  return relative.length > 0 && !path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\');
}

async function stageSandboxExecutable(root: string, source: string, expectedSha256: string, destination: string): Promise<Result<void>> {
  try {
    const resolved = await realpath(source);
    if (!sandboxSourceWithin(root, resolved)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Sandbox input resolves outside the workspace'));
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 2_147_483_648) {
      return err(appError('INVALID_INPUT', 'Sandbox input must be a bounded ordinary executable file'));
    }
    await copyFile(resolved, destination, constants.COPYFILE_EXCL);
    const staged = await stat(destination);
    if (!staged.isFile() || staged.size !== info.size) return err(appError('CONFLICT', 'Sandbox input size changed during staging', true));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    if (hash.digest('hex') !== expectedSha256) return err(appError('CONFLICT', 'Sandbox input SHA-256 does not match the approved executable', true));
    return ok(undefined);
  } catch {
    return err(appError('CONFLICT', 'Sandbox input executable could not be staged and verified', true));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
