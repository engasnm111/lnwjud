import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { resolveTunnelProfileDirectory } from '../src/main/tunnel-controller.js';

/** Keep native profile lookup inside a disposable test root on every host. */
export function isolateTunnelProfile(root: string): string {
  vi.stubEnv('APPDATA', path.join(root, 'appdata'));
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  return resolveTunnelProfileDirectory();
}
