import { describe, expect, it } from 'vitest';
import { CodexInvocationBuilder, capabilitiesFromHelp } from './codex-capabilities.js';

describe('Codex workspace-write sandbox capability', () => {
  it('discovers --sandbox workspace-write support and builds an explicit sandboxed invocation', () => {
    const capabilities = capabilitiesFromHelp([
      'Usage: codex exec [OPTIONS] [PROMPT]',
      'Commands:',
      '  exec  run a task',
      'Options:',
      '  --sandbox <MODE>  Sandbox policy [possible values: read-only, workspace-write]',
    ].join('\n'));

    expect(capabilities.names).toEqual(expect.arrayContaining(['exec', 'sandbox', 'workspace-write']));
    expect(new CodexInvocationBuilder().build('codex.exe', capabilities, 'review project')).toEqual({
      ok: true,
      value: {
        executable: 'codex.exe',
        args: ['exec', '--sandbox', 'workspace-write', 'review project'],
      },
    });
  });

  it('fails closed when workspace-write sandbox support was not observed', () => {
    const capabilities = capabilitiesFromHelp('Usage: codex\nCommands:\n  exec  run a task\n');

    expect(new CodexInvocationBuilder().build('codex.exe', capabilities, 'edit project')).toMatchObject({
      ok: false,
      error: { code: 'CODEX_NOT_AVAILABLE' },
    });
  });
});
