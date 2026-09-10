import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { access, constants, stat } from 'node:fs/promises';
import { err, ok, type AppError, type Result } from '@lnwjud/domain';
import { toSpawnInvocation } from '@lnwjud/process';
import { capabilitiesFromHelp, type CodexDiscoveryResult } from './codex-capabilities.js';

export interface CodexCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnErrorCode?: CodexSpawnErrorCode;
}

export type CodexSpawnErrorCode = 'EACCES' | 'EPERM' | 'ENOENT' | 'UNKNOWN';
export type CodexDiscoveryStage = 'resolve' | '--version' | '--help';

export interface CodexCommandRunner {
  run(executable: string, args: readonly string[]): Promise<CodexCommandResult>;
}

export interface CodexExecutableResolver {
  resolve(): Promise<Result<string>>;
}

export class PathCodexExecutableResolver implements CodexExecutableResolver {
  public constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public async resolve(): Promise<Result<string>> {
    const pathValue = this.environment.Path ?? this.environment.PATH ?? '';
    const pathApi = this.platform === 'win32' ? path.win32 : path.posix;
    const entries = pathValue.split(this.platform === 'win32' ? ';' : ':').filter(Boolean);
    const candidates = entries.flatMap((entry) => this.withWindowsExtensions(pathApi.join(entry, 'codex')));
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.F_OK);
        if ((await stat(candidate)).isFile()) return ok(candidate);
      } catch {
        continue;
      }
    }
    return err({ code: 'EXECUTABLE_NOT_FOUND', message: 'Codex executable was not found', recoverable: true });
  }

  private withWindowsExtensions(candidate: string): string[] {
    if (this.platform !== 'win32') return [candidate];
    const configured = (this.environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map((extension) => extension.trim().toUpperCase())
      .filter(Boolean);
    const preferred = ['.EXE', '.COM', '.CMD', '.BAT'];
    const ordered = [...preferred.filter((extension) => configured.includes(extension)), ...configured.filter((extension) => !preferred.includes(extension))];
    return [...ordered.map((extension) => `${candidate}${extension.toLowerCase()}`), candidate];
  }
}

export class DirectCodexCommandRunner implements CodexCommandRunner {
  public constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  public run(executable: string, args: readonly string[]): Promise<CodexCommandResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const finishSpawnError = (error: NodeJS.ErrnoException): void => resolve({
        exitCode: -1,
        stdout,
        stderr,
        spawnErrorCode: sanitizeSpawnErrorCode(error.code),
      });

      try {
        const invocation = toSpawnInvocation(executable, args, {}, this.platform);
        if (!invocation.ok) {
          resolve({ exitCode: -1, stdout, stderr, spawnErrorCode: 'UNKNOWN' });
          return;
        }
        const child = spawn(invocation.value.executable, [...invocation.value.args], {
          shell: false,
          windowsHide: true,
          ...(invocation.value.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.value.windowsVerbatimArguments }),
        });
        child.stdout?.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-1024 * 1024); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-1024 * 1024); });
        child.once('error', finishSpawnError);
        child.once('close', (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
      } catch (error: unknown) {
        finishSpawnError(error as NodeJS.ErrnoException);
      }
    });
  }
}

export class CodexDiscovery {
  public constructor(
    private readonly resolver: CodexExecutableResolver = new PathCodexExecutableResolver(),
    private readonly runner: CodexCommandRunner = new DirectCodexCommandRunner(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public async discover(): Promise<Result<CodexDiscoveryResult>> {
    const resolved = await this.resolver.resolve();
    if (!resolved.ok) {
      if (resolved.error.code === 'EXECUTABLE_NOT_FOUND') {
        return ok({ status: { installed: false, capabilities: [] }, capabilities: { instructionMode: null, names: [] } });
      }
      return err({ ...resolved.error, details: { ...(resolved.error.details ?? {}), stage: 'resolve' } });
    }
    const versionResult = await this.runner.run(resolved.value, ['--version']);
    if (versionResult.exitCode !== 0) return commandFailure(resolved.value, '--version', versionResult, this.platform);
    const helpResult = await this.runner.run(resolved.value, ['--help']);
    if (helpResult.exitCode !== 0) return commandFailure(resolved.value, '--help', helpResult, this.platform);
    const helpText = `${helpResult.stdout}\n${helpResult.stderr}`;
    const capabilities = capabilitiesFromHelp(helpText);
    const statusCapabilities = ['version', 'help', ...capabilities.names];
    const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    return ok({
      status: {
        installed: true,
        executablePath: resolved.value,
        ...(version === undefined ? {} : { version }),
        capabilities: statusCapabilities,
      },
      capabilities,
    });
  }
}

export function formatCodexDiscoveryError(error: AppError): string {
  const details = error.details;
  if (details === undefined) return error.message;
  const fields: string[] = [];
  appendStringField(fields, details, 'stage');
  appendStringField(fields, details, 'executablePath', 'executable');
  appendStringField(fields, details, 'spawnErrorCode');
  if (typeof details.exitCode === 'number') fields.push(`exitCode=${details.exitCode}`);
  return fields.length === 0 ? error.message : `${error.message} (${fields.join(', ')})`;
}

function commandFailure(executable: string, stage: Exclude<CodexDiscoveryStage, 'resolve'>, result: CodexCommandResult, platform: NodeJS.Platform = process.platform): Result<never> {
  return err({
    code: 'CODEX_NOT_AVAILABLE',
    message: `Codex ${stage} check failed`,
    recoverable: true,
    details: {
      stage,
      executablePath: sanitizeExecutablePath(executable, platform),
      exitCode: result.exitCode,
      ...(result.spawnErrorCode === undefined ? {} : { spawnErrorCode: result.spawnErrorCode }),
    },
  });
}

function sanitizeSpawnErrorCode(value: string | undefined): CodexSpawnErrorCode {
  return value === 'EACCES' || value === 'EPERM' || value === 'ENOENT' ? value : 'UNKNOWN';
}

function sanitizeExecutablePath(value: string, platform: NodeJS.Platform = process.platform): string {
  const home = os.homedir();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const relative = pathApi.relative(home, value);
  if (relative.length > 0 && !pathApi.isAbsolute(relative) && relative.split(pathApi.sep)[0] !== '..') {
    return platform === 'win32' ? `%USERPROFILE%${pathApi.sep}${relative}` : `$HOME${pathApi.sep}${relative}`;
  }
  const baseName = pathApi.basename(value);
  return baseName === value ? baseName : path.posix.basename(value.replaceAll('\\', '/'));
}

function appendStringField(
  fields: string[],
  details: Readonly<Record<string, string | number>>,
  key: string,
  label = key,
): void {
  if (typeof details[key] === 'string') fields.push(`${label}=${details[key]}`);
}

function parseVersion(value: string): string | undefined {
  return value.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
}
