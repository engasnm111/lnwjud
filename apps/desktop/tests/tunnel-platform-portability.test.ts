import { describe, expect, it } from 'vitest';
import { parsePosixTunnelProcessPids, parseTunnelClientVersionOutput } from '../src/main/tunnel-controller.js';

describe('Secure Tunnel platform portability helpers', () => {
  it('discovers only tunnel-client processes that carry an lnwjud ownership marker', () => {
    const ps = [
      '  101 /opt/lnwjud/tunnel-client run --profile lnwjud --profile-dir /home/me/.config/tunnel-client',
      '  102 /opt/lnwjud/tunnel-client run --profile other',
      '  103 /usr/local/bin/tunnel-client runtimes connect --alias=lnwjud',
      '  104 /usr/local/bin/not-tunnel-client run --profile lnwjud',
      '  105 "/Applications/lnwjud.app/Contents/Resources/tunnel-client" run --profile "lnwjud"',
      '  106 /usr/local/bin/tunnel-client run --config /home/me/lnwjud.yaml',
      '  107 /usr/local/bin/tunnel-client run --profile lnwjud-helper',
      '  108 /usr/bin/node helper.js --profile lnwjud',
      '  0 /usr/local/bin/tunnel-client run --profile lnwjud',
    ].join('\n');

    expect(parsePosixTunnelProcessPids(ps)).toEqual([101, 103, 105, 106]);
  });

  it('parses bounded semantic version output from stdout or stderr and ignores non-version diagnostics', () => {
    expect(parseTunnelClientVersionOutput('tunnel-client v0.0.13+build.7\n')).toBe('tunnel-client v0.0.13+build.7');
    expect(parseTunnelClientVersionOutput('', 'tunnel-client 0.0.13\n')).toBe('tunnel-client 0.0.13');
    expect(parseTunnelClientVersionOutput('warning: runtime unavailable\n')).toBeNull();
  });
});
