import { describe, expect, it } from 'vitest';
import { DesktopStartupIntents, shouldHoldSingleInstanceLock, wantsMcpStdio } from '../src/main/instance-lock.js';

describe('instance lock', () => {
  it('skips the single-instance lock for --mcp-stdio so tunnel can launch beside the dashboard', () => {
    expect(wantsMcpStdio(['lnwjud.exe', '--mcp-stdio'])).toBe(true);
    expect(shouldHoldSingleInstanceLock(['lnwjud.exe', '--mcp-stdio'])).toBe(false);
  });

  it('keeps the lock for the dashboard and log viewer', () => {
    expect(shouldHoldSingleInstanceLock(['lnwjud.exe'])).toBe(true);
    expect(shouldHoldSingleInstanceLock(['lnwjud.exe', '--log-viewer'])).toBe(true);
  });

  it('keeps both second-instance actions until admission and runtime are ready', () => {
    const received: string[] = [];
    const intents = new DesktopStartupIntents((intent) => received.push(intent));
    intents.receive(['lnwjud.exe', '--log-viewer']);
    intents.receive(['lnwjud.exe']);
    intents.receive(['lnwjud.exe', '--log-viewer']);
    expect(received).toEqual([]);
    intents.ready();
    expect(received).toEqual(['log-viewer', 'show']);
    intents.ready();
    intents.receive(['lnwjud.exe']);
    expect(received).toEqual(['log-viewer', 'show', 'show']);
  });

  it('discards queued and future actions when admission or startup fails', () => {
    const received: string[] = [];
    const intents = new DesktopStartupIntents((intent) => received.push(intent));
    intents.receive(['lnwjud.exe', '--log-viewer']);
    intents.cancel();
    intents.ready();
    intents.receive(['lnwjud.exe']);
    expect(received).toEqual([]);
  });
});
