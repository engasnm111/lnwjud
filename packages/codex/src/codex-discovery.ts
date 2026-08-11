import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { access, constants, stat } from 'node:fs/promises';
import { err, ok, type AppError, type Result } from '@lnwjud/domain';
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
  public constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  public async resolve(): Promise<Result<string>> {
    const pathValue = this.environment.Path ?? this.environment.PATH ?? '';
    const entries = pathValue.split(path.delimiter).filter(Boolean);
    const candidates = entries.flatMap((entry) => this.withWindowsExtensions(path.join(entry, 'codex')));
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
    if (process.platform !== 'win32') return [candidate];
    const extensions = (this.environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';');
    return [candidate, ...extensions.map((extension) => `${candidate}${extension.toLowerCase()}`)];
  }
}

export class DirectCodexCommandRunner implements CodexCommandRunner {
  public run(executable: string, args: readonly string[]): Promise<CodexCommandResult> {
    return new Promise((resolve) => {
      const child = spawn(executable, [...args], { shell: false, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-1024 * 1024); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-1024 * 1024); });
      child.once('error', (error: NodeJS.ErrnoException) => resolve({
        exitCode: -1,
        stdout,
        stderr,
        spawnErrorCode: sanitizeSpawnErrorCode(error.code),
      }));
      child.once('close', (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
    });
  }
}

export class CodexDiscovery {
  public constructor(
    private readonly resolver: CodexExecutableResolver = new PathCodexExecutableResolver(),
    private readonly runner: CodexCommandRunner = new DirectCodexCommandRunner(),
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
    if (versionResult.exitCode !== 0) return commandFailure(resolved.value, '--version', versionResult);
    const helpResult = await this.runner.run(resolved.value, ['--help']);
    if (helpResult.exitCode !== 0) return commandFailure(resolved.value, '--help', helpResult);
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

function commandFailure(executable: string, stage: Exclude<CodexDiscoveryStage, 'resolve'>, result: CodexCommandResult): Result<never> {
  return err({
    code: 'CODEX_NOT_AVAILABLE',
    message: `Codex ${stage} check failed`,
    recoverable: true,
    details: {
      stage,
      executablePath: sanitizeExecutablePath(executable),
      exitCode: result.exitCode,
      ...(result.spawnErrorCode === undefined ? {} : { spawnErrorCode: result.spawnErrorCode }),
    },
  });
}

function sanitizeSpawnErrorCode(value: string | undefined): CodexSpawnErrorCode {
  return value === 'EACCES' || value === 'EPERM' || value === 'ENOENT' ? value : 'UNKNOWN';
}

function sanitizeExecutablePath(value: string): string {
  const home = os.homedir();
  const relative = path.relative(home, value);
  if (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `%USERPROFILE%${path.sep}${relative}`;
  }
  const windowsBaseName = path.win32.basename(value);
  return windowsBaseName === value ? path.basename(value) : windowsBaseName;
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
