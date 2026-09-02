import { describe, expect, it } from 'vitest';
import { toPlatformSpawnInvocation } from './spawn-invocation.js';

describe('platform spawn invocation', () => {
  it('preserves Windows cmd wrapping without claiming a POSIX process group', () => {
    const result = toPlatformSpawnInvocation('C:\\tools\\script.cmd', ['alpha beta'], { platform: 'win32' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.executable.toLowerCase()).toContain('cmd');
    expect(result.value.ownsProcessGroup).toBe(false);
  });

  it.each(['linux', 'darwin'] as const)('uses direct argv and an owned process group on %s', (platform) => {
    const result = toPlatformSpawnInvocation('/usr/bin/tool', ['a b', '$HOME', '*.txt'], { platform });
    expect(result).toEqual({
      ok: true,
      value: {
        executable: '/usr/bin/tool',
        args: ['a b', '$HOME', '*.txt'],
        ownsProcessGroup: true,
      },
    });
  });
});
