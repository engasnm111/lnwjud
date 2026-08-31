import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('titlebar update notification', () => {
  it('turns the top-left version chip into an update action with visual states', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const shell = await readFile(path.join(root, 'src', 'renderer', 'features', 'shell', 'AppShell.tsx'), 'utf8');
    const app = await readFile(path.join(root, 'src', 'renderer', 'App.tsx'), 'utf8');
    const main = await readFile(path.join(root, 'src', 'main', 'main.ts'), 'utf8');
    const styles = await readFile(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');

    expect(shell).toContain("className={`titlebar-version update-${props.updateStatus?.phase ?? 'idle'}`}");
    expect(shell).toContain('onClick={props.onUpdateAction}');
    expect(shell).toContain("status.phase === 'ready'");
    expect(shell).toContain("status.phase === 'downloading'");
    expect(app).toContain('window.lnwjud.onUpdateStatus');
    expect(app).toContain('window.lnwjud.installUpdate()');
    expect(main).toContain('confirmTunnelStopForUpdate');
    expect(main).toContain('runtime.services.stopTunnel()');
    expect(main).toContain('updaterTunnelStopConfirm');
    expect(main.indexOf('await stopTunnelForUpdateInstall(runtime)')).toBeLessThan(main.indexOf("phase: 'installing'"));
    expect(main).toContain('maxWaitMs: 5_000');
    expect(styles).toContain('.titlebar-version.update-ready');
    expect(styles).toContain('@keyframes update-ready-pulse');
  });
});