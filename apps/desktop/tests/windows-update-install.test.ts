import { describe, expect, it, vi } from 'vitest';
import { installWindowsUpdate } from '../src/main/windows-update-install.js';

describe('confirmed Windows update installation', () => {
  it('requests silent installation and relaunch after the consent gate', () => {
    const updater = { quitAndInstall: vi.fn() };
    installWindowsUpdate(updater);
    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
  });
});
