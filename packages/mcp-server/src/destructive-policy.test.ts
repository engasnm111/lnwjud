import { describe, expect, it } from 'vitest';
import { inspectDestructiveOperation } from './destructive-policy.js';

describe('central destructive policy', () => {
  it.each([
    [['reset', '--hard'], true],
    [['clean', '-fd'], true],
    [['rm', 'file.txt'], true],
    [['checkout', '--', 'file.txt'], true],
    [['checkout', '-B', 'main', 'HEAD~1'], true],
    [['switch', '-C', 'main', 'HEAD~1'], true],
    [['branch', '-f', 'main', 'HEAD~1'], true],
    [['branch', '-D', 'old'], true],
    [['tag', '-f', 'v1'], true],
    [['stash', 'pop'], true],
    [['stash', 'clear'], true],
    [['reflog', 'expire', '--expire=now', '--all'], true],
    [['push', '--force', 'origin', 'main'], true],
    [['status', '--short'], false],
    [['diff'], false],
    [['reflog', 'show'], false],
  ])('classifies git %j destructive=%s', (args, destructive) => {
    expect(inspectDestructiveOperation('git', { args }).destructive).toBe(destructive);
  });

  it('detects destructive commands hidden behind process_start node scripts', () => {
    expect(inspectDestructiveOperation('process_start', {
      executable: 'node',
      args: ['-e', "require('fs').rmSync('x', { recursive: true })"],
    }).destructive).toBe(true);
  });

  it.each([
    ['git', { args: ['-C', 'E:\\outside', 'clean', '-fd'] }],
    ['git', { args: ['-c', 'alias.wipe=!rm -rf .', 'wipe'] }],
    ['shell', { operation: 'run', executable: 'pwsh.exe', arguments: ['-EncodedCommand', 'VwByAGkAdABlAC0ATwB1AHQAcAB1AHQA'] }],
    ['web_fetch', { method: 'POST', url: 'https://example.test/item' }],
    ['web_fetch', { method: 'PUT', url: 'https://example.test/item' }],
  ])('keeps the legacy %s adapter fail-closed for bypass inputs', (tool, input) => {
    expect(inspectDestructiveOperation(tool, input).destructive).toBe(true);
  });


  it('does not mark ordinary argv execution as destructive', () => {
    expect(inspectDestructiveOperation('shell', { operation: 'run', executable: 'node.exe', arguments: ['cleanup.js'] }).destructive).toBe(false);
    expect(inspectDestructiveOperation('process_start', { executable: 'node.exe', args: ['script.js'] }).destructive).toBe(false);
  });

  it.each(['rm', 'del'])('detects PowerShell %s aliases hidden behind process_start', (command) => {
    expect(inspectDestructiveOperation('process_start', {
      executable: 'powershell',
      args: ['-Command', `${command} x.txt`],
    }).destructive).toBe(true);
  });

  it('treats opaque UI and delegated-agent mutation boundaries conservatively', () => {
    expect(inspectDestructiveOperation('dom_cdp', { action: 'click', parameters: { selector: '#submit' } }).destructive).toBe(true);
    expect(inspectDestructiveOperation('accessibility', { action: 'click', parameters: { name: 'OK' } }).destructive).toBe(true);
    expect(inspectDestructiveOperation('input_event', { operation: 'type_text', parameters: { text: 'del x' } }).destructive).toBe(true);
    expect(inspectDestructiveOperation('codex_run', { instruction: 'edit files' }).destructive).toBe(true);
    expect(inspectDestructiveOperation('mcp_call', { server: 'child', tool: 'read_file' }).destructive).toBe(true);
  });

  it('guards persistent removals exposed by upgrade tools', () => {
    expect(inspectDestructiveOperation('plugin_remove', { name: 'x' }).destructive).toBe(true);
    expect(inspectDestructiveOperation('hook_remove', { name: 'x' }).destructive).toBe(true);
  });
});
