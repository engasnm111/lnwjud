import { describe, expect, it } from 'vitest';
import type { GitRunOptions, GitRunResult, GitRunner } from './git-runner.js';
import { GitAdapter } from './git-adapter.js';

class FakeGitRunner implements GitRunner {
  public readonly calls: { args: readonly string[]; cwd: string; options?: GitRunOptions }[] = [];
  public constructor(private readonly result: GitRunResult) {}

  public async run(args: readonly string[], cwd: string, options?: GitRunOptions): Promise<GitRunResult> {
    this.calls.push({ args, cwd, ...(options === undefined ? {} : { options }) });
    return this.result;
  }
}

describe('GitAdapter', () => {
  it('uses direct read-only status arguments and parses porcelain output', async () => {
    const runner = new FakeGitRunner({ exitCode: 0, stdout: ' M file.txt\0', stderr: '' });
    const result = await new GitAdapter(runner).status('C:\\workspace');

    expect(result).toMatchObject({ ok: true, value: { entries: [{ path: 'file.txt', kind: 'modified' }] } });
    expect(runner.calls).toEqual([{ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: 'C:\\workspace' }]);
  });

  it('enumerates nested untracked files in summary instead of collapsing directory', async () => {
    const runner = new FakeGitRunner({ exitCode: 0, stdout: '?? artifacts/model.glb\0?? artifacts/nested/data.xlsx\0', stderr: '' });
    const result = await new GitAdapter(runner).statusSummary('C:\\workspace');

    expect(result).toMatchObject({ ok: true, value: { entries: [{ path: 'artifacts/model.glb', kind: 'untracked' }, { path: 'artifacts/nested/data.xlsx', kind: 'untracked' }] } });
    expect(runner.calls).toEqual([{ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: 'C:\\workspace' }]);
  });

  it('queries the current branch name', async () => {
    const runner = new FakeGitRunner({ exitCode: 0, stdout: 'main\n', stderr: '' });
    const result = await new GitAdapter(runner).branch('C:\\workspace');

    expect(result).toEqual({ ok: true, value: 'main' });
    expect(runner.calls).toEqual([{ args: ['branch', '--show-current'], cwd: 'C:\\workspace' }]);
  });

  it('bounds diff output and keeps the path as a separate argument', async () => {
    const runner = new FakeGitRunner({ exitCode: 0, stdout: '0123456789', stderr: '' });
    const result = await new GitAdapter(runner).diff('C:\\workspace', { path: 'src\\space file.txt', maxBytes: 5 });

    expect(result).toEqual({ ok: true, value: { patch: '01234', truncated: true } });
    expect(runner.calls[0]).toEqual({
      args: ['diff', '--no-ext-diff', '--no-color', '--', 'src\\space file.txt'],
      cwd: 'C:\\workspace',
    });
  });

  it('parses bounded structured log records', async () => {
    const runner = new FakeGitRunner({
      exitCode: 0,
      stdout: 'abc\u001fname\u001f2026-08-10T10:00:00Z\u001fsubject\u001e',
      stderr: '',
    });
    const result = await new GitAdapter(runner).log('C:\\workspace', { maxCommits: 3 });

    expect(result).toEqual({
      ok: true,
      value: { entries: [{ hash: 'abc', author: 'name', date: '2026-08-10T10:00:00Z', subject: 'subject' }], truncated: false },
    });
    expect(runner.calls[0]?.args).toEqual(['log', '--no-color', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', '-n', '3', '--']);
  });

  it('returns stdout, stderr, and a non-zero exit code for a failing git command', async () => {
    const runner = new FakeGitRunner({ exitCode: 1, stdout: '', stderr: 'nothing to commit' });
    const result = await new GitAdapter(runner).run('C:\\workspace', ['commit', '-m', 'empty']);

    expect(result).toEqual({ ok: true, value: { exitCode: 1, stdout: '', stderr: 'nothing to commit' } });
    expect(runner.calls).toEqual([{
      args: ['commit', '-m', 'empty'],
      cwd: 'C:\\workspace',
      options: { timeoutMs: 60_000 },
    }]);
  });

  it('forwards cancellation to every MCP-exposed Git command', async () => {
    const runner = new FakeGitRunner({ exitCode: 0, stdout: '', stderr: '' });
    const adapter = new GitAdapter(runner);
    const signal = new AbortController().signal;

    await adapter.status('C:\\workspace', signal);
    await adapter.diff('C:\\workspace', {}, signal);
    await adapter.log('C:\\workspace', {}, signal);
    await adapter.run('C:\\workspace', ['status'], undefined, signal);

    expect(runner.calls.map((call) => call.options?.signal)).toEqual([signal, signal, signal, signal]);
  });

  it('rejects an empty git argv', async () => {
    const runner = new FakeGitRunner({ exitCode: 0, stdout: '', stderr: '' });
    await expect(new GitAdapter(runner).run('C:\\workspace', [])).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(runner.calls).toEqual([]);
  });

  it('maps a non-repository exit to a structured error', async () => {
    const runner = new FakeGitRunner({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' });

    await expect(new GitAdapter(runner).status('C:\\workspace')).resolves.toMatchObject({
      ok: false,
      error: { code: 'GIT_NOT_REPOSITORY' },
    });
  });
});
