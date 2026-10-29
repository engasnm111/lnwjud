import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Result } from '@lnwjud/domain';
import type { ExecutableResolver } from './executable-resolver.js';
import { DirectProcessRunner, RipgrepAdapter, type ProcessRunResult, type ProcessRunner } from './ripgrep-adapter.js';

describe('RipgrepAdapter', () => {
  it('terminates an over-budget ripgrep process and reports a timed-out partial result', async () => {
    const runner = new DirectProcessRunner();

    const result = await runWithVerifiedTermination((markerPath) => runner.run(
      process.execPath,
      ['-e', "setTimeout(() => { require('node:fs').writeFileSync(process.argv[1], 'survived'); process.stdout.write('late'); }, 2_000)", markerPath],
      process.cwd(),
      { timeoutMs: 40 },
    ));

    expect(result.timedOut).toBe(true);
    expect(result.stdout).not.toContain('late');
  }, 15_000);

  it('stops a high-volume child after enough stdout lines without retaining the full stream', async () => {
    const runner = new DirectProcessRunner();
    let observed = 0;
    const script = [
      "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'survived'), 2_000);",
      "let i = 0;",
      "const write = () => {",
      "  while (i < 200000 && process.stdout.write(`line-${i++}\\n`)) {}",
      "  if (i < 200000) process.stdout.once('drain', write); else setTimeout(() => {}, 2000);",
      "};",
      "write();",
    ].join(' ');

    const result = await runWithVerifiedTermination((markerPath) => runner.run(process.execPath, ['-e', script, markerPath], process.cwd(), {
      timeoutMs: 5_000,
      stopAfterStdoutLine: () => {
        observed += 1;
        return observed > 100;
      },
    }));

    expect(result.stoppedEarly).toBe(true);
    expect(result.timedOut).not.toBe(true);
    expect(observed).toBeGreaterThan(100);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThan(1024 * 1024);
  }, 15_000);

  it('terminates a ripgrep child when the MCP invocation is aborted', async () => {
    const runner = new DirectProcessRunner();
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 30);

    const result = await runWithVerifiedTermination((markerPath) => runner.run(
      process.execPath,
      ['-e', "setTimeout(() => { require('node:fs').writeFileSync(process.argv[1], 'survived'); process.stdout.write('late'); }, 2_000)", markerPath],
      process.cwd(),
      { timeoutMs: 1_000, signal: controller.signal },
    ));
    clearTimeout(abortTimer);

    expect(result.timedOut).toBe(true);
    expect(result.stdout).not.toContain('late');
  }, 15_000);

  it('passes the invocation abort signal to process-backed text search', async () => {
    const controller = new AbortController();
    let childWasAborted = false;
    const runner: ProcessRunner = {
      async run(_command, _args, _cwd, options): Promise<ProcessRunResult> {
        return new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () => {
            childWasAborted = true;
            resolve({ exitCode: -1, stdout: '', stderr: '', timedOut: true });
          }, { once: true });
          controller.abort();
        });
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    await expect(adapter.searchText({ rootPath: 'C:\\workspace', query: 'needle', signal: controller.signal })).resolves.toEqual({
      ok: true,
      value: { matches: [], truncated: true },
    });
    expect(childWasAborted).toBe(true);
  });

  it('finds failureLegacyBotName() as a literal query without regex parsing', async () => {
    let receivedArgs: readonly string[] = [];
    const runner: ProcessRunner = {
      async run(_command, args): Promise<ProcessRunResult> {
        receivedArgs = args;
        const fixed = args.includes('--fixed-strings');
        return fixed
          ? {
              exitCode: 0,
              stdout: JSON.stringify({ type: 'match', data: { path: { text: 'src\\fixture.js' }, line_number: 7, lines: { text: 'failureLegacyBotName()\n' } } }) + '\n',
              stderr: '',
            }
          : { exitCode: 2, stdout: '', stderr: 'regex parse error: unclosed group' };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    await expect(adapter.searchText({ rootPath: 'C:\\workspace', query: 'failureLegacyBotName()' })).resolves.toEqual({
      ok: true,
      value: {
        matches: [{ path: 'src\\fixture.js', line: 7, text: 'failureLegacyBotName()' }],
        truncated: false,
      },
    });
    expect(receivedArgs).toContain('--fixed-strings');
    expect(receivedArgs).toContain('failureLegacyBotName()');
  });

  it('passes query metacharacters as one literal argument without shell side effects', async () => {
    let executable = '';
    let receivedArgs: readonly string[] = [];
    const runner: ProcessRunner = {
      async run(command: string, args: readonly string[]): Promise<ProcessRunResult> {
        executable = command;
        receivedArgs = args;
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);
    const query = 'literal & echo side-effect | $(not-a-command)';

    const result = await adapter.searchText({ rootPath: 'C:\\workspace', query, maxResults: 200 });

    expect(result).toEqual({ ok: true, value: { matches: [], truncated: false } });
    expect(executable).toBe('rg.exe');
    expect(receivedArgs).toContain('--no-ignore');
    expect(receivedArgs).toContain('--hidden');
    expect(receivedArgs).toContain('--fixed-strings');
    expect(receivedArgs).toContain(query);
    expect(receivedArgs).not.toContain(receivedArgs.join(' '));
  });

  it('enables ripgrep regex semantics only when regex is explicitly true', async () => {
    let receivedArgs: readonly string[] = [];
    const runner: ProcessRunner = {
      async run(_command, args): Promise<ProcessRunResult> {
        receivedArgs = args;
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    await expect(adapter.searchText({ rootPath: 'C:\\workspace', query: 'failureLegacyBotName\\(\\)', regex: true })).resolves.toEqual({
      ok: true,
      value: { matches: [], truncated: false },
    });
    expect(receivedArgs).not.toContain('--fixed-strings');
    expect(receivedArgs).toContain('failureLegacyBotName\\(\\)');
  });

  it('uses an explicit text-search target instead of searching the whole cwd', async () => {
    let receivedArgs: readonly string[] = [];
    let receivedCwd = '';
    const runner: ProcessRunner = {
      async run(_command, args, cwd): Promise<ProcessRunResult> {
        receivedArgs = args;
        receivedCwd = cwd;
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    await expect(adapter.searchText({ rootPath: 'C:\\workspace', targetPath: 'fixture.ts', query: 'needle' })).resolves.toEqual({
      ok: true,
      value: { matches: [], truncated: false },
    });
    expect(receivedCwd).toBe('C:\\workspace');
    expect(receivedArgs.slice(-3)).toEqual(['--', 'needle', 'fixture.ts']);
  });

  it('reports access-denied ripgrep failures as recoverable PERMISSION_DENIED', async () => {
    const runner: ProcessRunner = {
      async run(): Promise<ProcessRunResult> {
        return { exitCode: 2, stdout: '', stderr: 'rg: ./Local\\Temp\\WinSAT: Access is denied. (os error 5)' };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    await expect(adapter.searchFiles({ rootPath: 'C:\\workspace' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED', recoverable: true },
    });
  });

  it('reports unrecognized ripgrep exit-code 2 failures as recoverable INTERNAL_ERROR', async () => {
    const runner: ProcessRunner = {
      async run(): Promise<ProcessRunResult> {
        return { exitCode: 2, stdout: '', stderr: 'rg: unexpected process failure' };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    await expect(adapter.searchText({ rootPath: 'C:\\workspace', query: 'needle' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', recoverable: true },
    });
  });

  it('reports malformed explicit regex as recoverable INVALID_INPUT with retry guidance', async () => {
    const runner: ProcessRunner = { async run(): Promise<ProcessRunResult> { return { exitCode: 2, stdout: '', stderr: 'regex parse error: unclosed group\n' }; } };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);
    await expect(adapter.searchText({ rootPath: 'C:\\workspace', query: 'broken(', regex: true })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: expect.stringContaining('unclosed group'),
        recoverable: true,
        details: { argumentKind: 'regex', suggestedAction: 'retry_as_literal_or_fix_regex' },
      },
    });
  });

  it('asks the process runner to stop after maxResults plus one visible match', async () => {
    let stoppedByObserver = false;
    const lines = [
      JSON.stringify({ type: 'match', data: { path: { text: 'src\\a.ts' }, line_number: 1, lines: { text: 'needle a\\n' } } }),
      JSON.stringify({ type: 'match', data: { path: { text: 'src\\b.ts' }, line_number: 2, lines: { text: 'needle b\\n' } } }),
      JSON.stringify({ type: 'match', data: { path: { text: 'src\\c.ts' }, line_number: 3, lines: { text: 'needle c\\n' } } }),
    ];
    const runner: ProcessRunner = {
      async run(_command, _args, _cwd, options): Promise<ProcessRunResult> {
        const captured: string[] = [];
        for (const line of lines) {
          captured.push(line);
          if (options?.stopAfterStdoutLine?.(line) === true) {
            stoppedByObserver = true;
            break;
          }
        }
        return { exitCode: -1, stdout: captured.join('\n'), stderr: '', ...(stoppedByObserver ? { stoppedEarly: true } : {}) };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    const result = await adapter.searchText({ rootPath: 'C:\\workspace', query: 'needle', maxResults: 1 });

    expect(stoppedByObserver).toBe(true);
    expect(result).toEqual({
      ok: true,
      value: {
        matches: [{ path: 'src\\a.ts', line: 1, text: 'needle a\\n' }],
        truncated: true,
      },
    });
  });

  it('parses bounded JSON match records and reports truncation', async () => {
    const runner: ProcessRunner = {
      async run(): Promise<ProcessRunResult> {
        return {
          exitCode: 0,
          stderr: '',
          stdout: [
            JSON.stringify({ type: 'match', data: { path: { text: 'src\\a.ts' }, line_number: 3, lines: { text: 'const a = 1;\n' } } }),
            JSON.stringify({ type: 'match', data: { path: { text: 'src\\b.ts' }, line_number: 4, lines: { text: 'const b = 2;\n' } } }),
          ].join('\n'),
        };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    const result = await adapter.searchText({ rootPath: 'C:\\workspace', query: 'const', maxResults: 1 });

    expect(result).toEqual({
      ok: true,
      value: {
        matches: [{ path: 'src\\a.ts', line: 3, text: 'const a = 1;' }],
        truncated: true,
      },
    });
  });

  it('applies context-economy filters to automatic discovery and allows explicit enumeration', async () => {
    let receivedArgs: readonly string[] = [];
    const runner: ProcessRunner = {
      async run(_command: string, args: readonly string[]): Promise<ProcessRunResult> {
        receivedArgs = args;
        return { exitCode: 0, stderr: '', stdout: ['src/app.ts', '.env', 'node_modules/pkg/index.js', 'dist/app.js'].join('\n') };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    const automatic = await adapter.searchFiles({ rootPath: 'C:\\workspace' });
    expect(automatic).toEqual({ ok: true, value: { paths: ['src/app.ts', '.env'], truncated: false } });
    expect(receivedArgs).toContain('!**/node_modules/**');

    await adapter.searchText({ rootPath: 'C:\\workspace', query: 'needle' });
    expect(receivedArgs).not.toContain('--binary-files');

    const explicit = await adapter.searchFiles({ rootPath: 'C:\\workspace', discovery: 'explicit' });
    expect(explicit).toEqual({
      ok: true,
      value: { paths: ['src/app.ts', '.env', 'node_modules/pkg/index.js', 'dist/app.js'], truncated: false },
    });
  });
});

async function runWithVerifiedTermination(
  run: (markerPath: string) => Promise<ProcessRunResult>,
): Promise<ProcessRunResult> {
  const root = await mkdtemp(path.join(tmpdir(), 'lnwjud-search-process-stop-'));
  const markerPath = path.join(root, 'survived');
  try {
    const result = await run(markerPath);
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(existsSync(markerPath)).toBe(false);
    if (process.platform === 'darwin') {
      expect(result.stderr).toMatch(/^POSIX process (?:identity changed or root exited|group identity could not be verified); targeted termination refused$/);
    } else {
      expect(result.stderr).toBe('');
    }
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
