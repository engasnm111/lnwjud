import { describe, expect, it } from 'vitest';
import { err } from '@lnwjud/domain';
import { parseCliArgs, runCli, type CliDependencies } from './index.js';

describe('CLI argument parser', () => {
  it('parses workspace, MCP, doctor, and Codex doctor commands', () => {
    expect(parseCliArgs(['workspace', 'add', 'E:\\project'])).toEqual({ ok: true, value: { kind: 'workspace-add', rootPath: 'E:\\project' } });
    expect(parseCliArgs(['mcp', '--http', '--workspace', 'workspace-1'])).toEqual({ ok: true, value: { kind: 'mcp-http', workspaceReference: 'workspace-1' } });
    expect(parseCliArgs(['doctor'])).toEqual({ ok: true, value: { kind: 'doctor' } });
    expect(parseCliArgs(['codex', 'doctor'])).toEqual({ ok: true, value: { kind: 'codex-doctor' } });
  });

  it('rejects ambiguous MCP transport flags', () => {
    const parsed = parseCliArgs(['mcp', '--stdio', '--http']);
    expect(parsed.ok).toBe(false);
  });

  it('prints sanitized Codex discovery diagnostics from codex doctor', async () => {
    const output: string[] = [];
    const dependencies: CliDependencies = {
      status: async () => ({ workspaceCount: 0 }),
      workspaceAdd: async () => err({ code: 'INTERNAL_ERROR', message: 'unused', recoverable: true }),
      workspaceList: async () => [],
      mcpStdio: async () => err({ code: 'INTERNAL_ERROR', message: 'unused', recoverable: true }),
      mcpHttp: async () => err({ code: 'INTERNAL_ERROR', message: 'unused', recoverable: true }),
      doctor: async () => ({ checks: [], exitCode: 0 }),
      codexDoctor: async () => err({
        code: 'CODEX_NOT_AVAILABLE',
        message: 'Codex --version check failed',
        recoverable: true,
        details: {
          stage: '--version',
          executablePath: '%USERPROFILE%\\tools\\codex.exe',
          spawnErrorCode: 'EACCES',
          exitCode: -1,
        },
      }),
      writeError: (text) => output.push(text),
    };

    const exitCode = await runCli(['codex', 'doctor'], dependencies);

    expect(exitCode).toBe(1);
    expect(output).toEqual(['Codex --version check failed (stage=--version, executable=%USERPROFILE%\\tools\\codex.exe, spawnErrorCode=EACCES, exitCode=-1)']);
  });
});
