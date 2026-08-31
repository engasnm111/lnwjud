import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  '$manifestPath = \'C:\\lnwjud\\output\\job-manifest.json\'',
  '$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json',
  '$quoted = @($manifest.arguments | ForEach-Object {',
  '  $argument = [string]$_',
  "  if ($argument -match '\\s') { '\"' + $argument.Replace('\"', '\\\"') + '\"' } else { $argument }",
  '})',
  '$process = Start-Process -FilePath $manifest.executable -ArgumentList $quoted -RedirectStandardOutput $manifest.stdout -RedirectStandardError $manifest.stderr -NoNewWindow -PassThru',
  '$exitCode = 0',
  'try {',
  '  $process | Wait-Process -Timeout ([int]$manifest.timeoutSeconds) -ErrorAction Stop',
  '  $exitCode = $process.ExitCode',
  '} catch {',
  '  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue',
  '  $exitCode = 124',
  '}',
  'Set-Content -Path $manifest.exitCode -Value $exitCode',
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
    if (this.platform !== 'win32' || !existsSync(this.sandboxExecutable)) {
      return ok(this.unavailable('windows_sandbox_feature_missing'));
    }
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

    await mkdir(inputPath, { recursive: true });
    await mkdir(outputPath, { recursive: true });
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
    return ok({
      tool: 'sandbox_exec',
      status: 'ready',
      available: true,
      executed: true,
      jobId,
      networking: 'disabled',
      exitCode: Number.isNaN(Number.parseInt(exitCode, 10)) ? null : Number.parseInt(exitCode, 10),
      stdout,
      stderr,
      artifacts: plan.value.outputArtifact.files,
      stagingDirectory: staging,
    });
  }

  private async workspaceRoot(workspaceId: string): Promise<Result<string>> {
    const workspaceInfo = this.services.workspaceInfo;
    if (workspaceInfo === undefined) return ok(path.resolve('.'));
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
      reason, requirements: ['Windows Sandbox feature', 'interactive user session', 'artifact output directory'],
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
