import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogHub } from '../src/main/log-hub.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LogHub', () => {
  it('feeds and snapshots lines per source with dedupe', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    hub.feedIfNew('mcp', 'a', 'info', 'first');
    hub.feedIfNew('mcp', 'a', 'info', 'duplicate');
    hub.feedIfNew('mcp', 'b', 'error', 'second');
    hub.feed('process', 'info', 'proc line');

    const snapshot = hub.snapshot();
    expect(snapshot.lines).toHaveLength(3);
    expect(snapshot.lines.map((line) => line.text)).toEqual(['first', 'second', 'proc line']);
    expect(snapshot.tunnelLogExists).toBe(false);
  });

  it('clears a single source', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    hub.feed('tunnel', 'info', 't1');
    hub.feed('mcp', 'info', 'm1');

    hub.clear('tunnel');

    const snapshot = hub.snapshot();
    expect(snapshot.lines.map((line) => line.source)).toEqual(['mcp']);
  });

  it('tails an appended tunnel log file', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-loghub-'));
    temporaryRoots.push(root);
    const logPath = path.join(root, 'lnwjud-tunnel.log');
    await writeFile(logPath, '{"level":"info","msg":"boot"}\n', 'utf8');
    const hub = new LogHub({ tunnelLogPath: logPath });
    hub.start();
    await vi.advanceTimersByTimeAsync(700);
    expect(hub.snapshot().lines.map((line) => line.text)).toContain('boot');

    await appendFile(logPath, 'plain text line\n{"level":"error","msg":"boom"}\n', 'utf8');
    await vi.advanceTimersByTimeAsync(700);
    hub.stop();
    const texts = hub.snapshot().lines.map((line) => line.text);
    expect(texts).toContain('plain text line');
    expect(texts).toContain('boom');
    expect(hub.snapshot().lines.find((line) => line.text === 'boom')?.level).toBe('error');
  });

  it('notifies subscribers of new lines', () => {
    const onLine = vi.fn();
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log', onLine });
    hub.feed('tunnel', 'warn', 'watch out');
    expect(onLine).toHaveBeenCalledWith(expect.objectContaining({ source: 'tunnel', level: 'warn', text: 'watch out' }));
  });
});
