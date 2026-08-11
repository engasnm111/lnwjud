import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { err, ok, type Result } from '@lnwjud/domain';
import { CodexDiscovery, DirectCodexCommandRunner, formatCodexDiscoveryError, PathCodexExecutableResolver, type CodexCommandResult, type CodexCommandRunner, type CodexExecutableResolver } from './codex-discovery.js';

describe('CodexDiscovery', () => {
  it('discovers version and supported instruction capabilities without reading credentials', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const resolver: CodexExecutableResolver = { async resolve(): Promise<Result<string>> { return ok('C:\\tools\\codex.exe'); } };
    const runner: CodexCommandRunner = {
      async run(executable, args): Promise<CodexCommandResult> {
        calls.push({ executable, args });
        return args[0] === '--version'
          ? { exitCode: 0, stdout: 'codex 0.42.1\\n', stderr: '' }
          : { exitCode: 0, stdout: 'Usage: codex [OPTIONS]\\nCommands:\\n  exec  run a task\\nOptions:\\n  --prompt <TEXT>\\n', stderr: '' };
      },
    };

    const result = await new CodexDiscovery(resolver, runner).discover();

    expect(result).toMatchObject({ ok: true, value: { status: {
      installed: true,
      executablePath: 'C:\\tools\\codex.exe',
      version: '0.42.1',
    } } });
    if (result.ok) expect(result.value.capabilities.instructionMode).toBe('exec-argument');
    expect(calls).toEqual([
      { executable: 'C:\\tools\\codex.exe', args: ['--version'] },
      { executable: 'C:\\tools\\codex.exe', args: ['--help'] },
    ]);
  });

  it('reports not installed without attempting any command or credential lookup', async () => {
    let runs = 0;
    const resolver: CodexExecutableResolver = {
      async resolve(): Promise<Result<string>> {
        return err({ code: 'EXECUTABLE_NOT_FOUND', message: 'not found', recoverable: true });
      },
    };
    const runner: CodexCommandRunner = { async run(): Promise<CodexCommandResult> { runs += 1; return { exitCode: 0, stdout: '', stderr: '' }; } };

    const result = await new CodexDiscovery(resolver, runner).discover();

    expect(result).toEqual({ ok: true, value: { status: { installed: false, capabilities: [] }, capabilities: { instructionMode: null, names: [] } } });
    expect(runs).toBe(0);
  });

  it('reports a sanitized spawn error and the version discovery stage', async () => {
    const resolver: CodexExecutableResolver = { async resolve(): Promise<Result<string>> { return ok('C:\\Users\\ABCz\\tools\\codex.exe'); } };
    const runner: CodexCommandRunner = {
      async run(): Promise<CodexCommandResult> {
        return Object.assign(
          { exitCode: -1, stdout: '', stderr: '' },
          { spawnErrorCode: 'EACCES' as const },
        );
      },
    };

    const result = await new CodexDiscovery(resolver, runner).discover();

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'CODEX_NOT_AVAILABLE',
        message: 'Codex --version check failed',
        recoverable: true,
        details: {
          stage: '--version',
          executablePath: '%USERPROFILE%\\tools\\codex.exe',
          spawnErrorCode: 'EACCES',
          exitCode: -1,
        },
      },
    });
  });

  it('reports the help discovery stage when help invocation cannot start', async () => {
    const resolver: CodexExecutableResolver = { async resolve(): Promise<Result<string>> { return ok('C:\\tools\\codex.exe'); } };
    let invocation = 0;
    const runner: CodexCommandRunner = {
      async run(): Promise<CodexCommandResult> {
        invocation += 1;
        return invocation === 1
          ? { exitCode: 0, stdout: 'codex 0.42.1\n', stderr: '' }
          : Object.assign(
            { exitCode: -1, stdout: '', stderr: '' },
            { spawnErrorCode: 'EPERM' as const },
          );
      },
    };

    const result = await new CodexDiscovery(resolver, runner).discover();

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'CODEX_NOT_AVAILABLE',
        message: 'Codex --help check failed',
        details: {
          stage: '--help',
          executablePath: 'codex.exe',
          spawnErrorCode: 'EPERM',
          exitCode: -1,
        },
      },
    });
  });

  it('marks resolver failures with the resolve discovery stage', async () => {
    const resolver: CodexExecutableResolver = {
      async resolve(): Promise<Result<string>> {
        return err({ code: 'INTERNAL_ERROR', message: 'resolver failed', recoverable: true });
      },
    };
    const runner: CodexCommandRunner = { async run(): Promise<CodexCommandResult> { throw new Error('must not run'); } };

    const result = await new CodexDiscovery(resolver, runner).discover();

    expect(result).toMatchObject({ ok: false, error: { details: { stage: 'resolve' } } });
  });

  it('preserves ENOENT from a direct spawn failure', async () => {
    const missingExecutable = path.join(os.tmpdir(), `lnwjud-missing-codex-${process.pid}-${Date.now()}.exe`);

    const result = await new DirectCodexCommandRunner().run(missingExecutable, ['--version']);

    expect(result).toMatchObject({ exitCode: -1, spawnErrorCode: 'ENOENT' });
  });

  it('prefers Windows executable extensions over an extensionless shim', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-codex-resolver-'));
    try {
      await writeFile(path.join(root, 'codex'), '#!/usr/bin/env bash\n', 'utf8');
      await writeFile(path.join(root, 'codex.cmd'), '@echo off\r\n', 'utf8');
      const resolver = new PathCodexExecutableResolver({ Path: root, PATHEXT: '.CMD' });

      await expect(resolver.resolve()).resolves.toMatchObject({ ok: true, value: expect.stringMatching(/\.cmd$/i) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('formats only the allowlisted discovery diagnostics for a user-facing error', () => {
    const message = formatCodexDiscoveryError({
      code: 'CODEX_NOT_AVAILABLE',
      message: 'Codex --version check failed',
      recoverable: true,
      details: {
        stage: '--version',
        executablePath: '%USERPROFILE%\\tools\\codex.exe',
        spawnErrorCode: 'EACCES',
        exitCode: -1,
        secret: 'must-not-display',
      },
    });

    expect(message).toBe('Codex --version check failed (stage=--version, executable=%USERPROFILE%\\tools\\codex.exe, spawnErrorCode=EACCES, exitCode=-1)');
    expect(message).not.toContain('must-not-display');
  });
});
