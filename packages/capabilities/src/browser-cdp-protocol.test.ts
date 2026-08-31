import { describe, expect, it } from 'vitest';
import { darwinChromeCandidates, validateWebSocketUrl } from './browser-cdp-protocol.js';

describe('darwinChromeCandidates', () => {
  it('searches system-wide browser bundles before the user Applications directory', () => {
    expect(darwinChromeCandidates('/Users/tester')).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Users/tester/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]);
  });
});

describe('validateWebSocketUrl', () => {
  it('accepts a loopback debug socket on the expected port', () => {
    expect(validateWebSocketUrl('ws://127.0.0.1:9222/devtools/page/ABC', 9222)).toBe('ws://127.0.0.1:9222/devtools/page/ABC');
    expect(validateWebSocketUrl('ws://localhost/devtools/browser/DEF', 80)).toBe('ws://localhost/devtools/browser/DEF');
  });

  it('rejects non-local or wrong-port debug sockets', () => {
    expect(() => validateWebSocketUrl('ws://192.168.1.10:9222/devtools/page/ABC', 9222)).toThrow('not local');
    expect(() => validateWebSocketUrl('ws://127.0.0.1:9223/devtools/page/ABC', 9222)).toThrow('not local');
    expect(() => validateWebSocketUrl('http://127.0.0.1:9222/devtools/page/ABC', 9222)).toThrow();
  });
});
