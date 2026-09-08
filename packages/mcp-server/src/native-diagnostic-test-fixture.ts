import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Unit-test providers only. Exercise the real process transport and parser,
// but do not depend on the runner's journal, installed runtimes or user systemd.
export async function withNativeDiagnosticFixture<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (process.platform === 'win32') return run();
  const mac = process.platform === 'darwin';
  const uid = process.getuid?.() ?? 0;
  const event = JSON.stringify({ MESSAGE: 'fixture event', eventMessage: 'fixture event' });
  const commands: Array<readonly [string, string, string]> = [];
  switch (name) {
    case 'service_context':
      commands.push(mac ? ['launchctl', `print gui/${uid}/EventLog`, 'fixture service']
        : ['systemctl', '--user status EventLog --no-pager --plain', 'fixture service']);
      break;
    case 'process_context': commands.push(['ps', '-axo pid=,ppid=,comm=,%cpu=,%mem=', '42 1 fixture 0.0 0.0']); break;
    case 'port_context': commands.push(mac ? ['lsof', '-nP -iTCP -sTCP:LISTEN', 'fixture listener'] : ['ss', '-ltnp', 'fixture listener']); break;
    case 'startup_context':
      commands.push(mac ? ['launchctl', `print-disabled gui/${uid}`, 'fixture startup']
        : ['systemctl', '--user list-unit-files --state=enabled --no-pager --plain', 'fixture startup']);
      break;
    case 'installed_runtime_context':
      for (const command of ['npm', 'corepack', 'git', 'python3', 'pwsh']) commands.push([command, '--version', 'fixture version 1.0']);
      break;
    case 'event_log_context':
    case 'event_watch': commands.push(mac ? ['log', 'show --style ndjson --no-pager --last 24h', event]
      : ['journalctl', '--no-pager --output=json -n 1 --user', event]); break;
    case 'crash_trace': commands.push(mac
      ? ['log', 'show --style ndjson --no-pager --last 1h --predicate (eventMessage CONTAINS[c] "crash" OR eventMessage CONTAINS[c] "exception")', event]
      : ['journalctl', '--no-pager --output=json -n 1 -p err..emerg', event]); break;
    default: return run();
  }
  const root = await mkdtemp(path.join(tmpdir(), 'lnwjud-diagnostic-fixture-'));
  const originalPath = process.env.PATH;
  const originalMixedPath = process.env.Path;
  try {
    for (const [command, args, stdout] of commands) {
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
      await writeFile(path.join(root, command),
        `#!/bin/sh\nif [ "$*" != ${quote(args)} ]; then echo 'unexpected diagnostic arguments' >&2; exit 64; fi\nprintf '%s\\n' ${quote(stdout)}\n`, { mode: 0o755 });
    }
    process.env.PATH = `${root}${path.delimiter}${originalPath ?? ''}`;
    process.env.Path = process.env.PATH;
    return await run();
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalMixedPath === undefined) delete process.env.Path; else process.env.Path = originalMixedPath;
    await rm(root, { recursive: true, force: true });
  }
}
