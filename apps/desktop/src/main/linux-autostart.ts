import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DESKTOP_FILE_NAME = 'lnwjud.desktop';

export interface LinuxAutostartOptions {
  readonly homeDirectory?: string;
  readonly configDirectory?: string;
  readonly executablePath: string;
  readonly enabled: boolean;
}

/** Manage only lnwjud's own XDG autostart entry. */
export async function configureLinuxAutostart(options: LinuxAutostartOptions): Promise<string> {
  const configDirectory = path.resolve(options.configDirectory ?? path.join(options.homeDirectory ?? os.homedir(), '.config', 'autostart'));
  const desktopPath = path.join(configDirectory, DESKTOP_FILE_NAME);
  if (!options.enabled) {
    await rm(desktopPath, { force: true });
    return desktopPath;
  }
  // The entry is a Linux desktop file, so preserve an already POSIX-absolute
  // executable path even when this module is unit-tested from a Windows host.
  const executablePath = options.executablePath.startsWith('/')
    ? options.executablePath
    : path.resolve(options.executablePath);
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=lnwjud',
    `Exec=${escapeDesktopExecArg(executablePath)}`,
    `TryExec=${escapeDesktopExecArg(executablePath)}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
  await mkdir(configDirectory, { recursive: true });
  const temporary = path.join(configDirectory, `.${DESKTOP_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporary, desktopPath);
  } catch (error: unknown) {
    await rm(temporary, { force: true });
    throw error;
  }
  return desktopPath;
}

function escapeDesktopExecArg(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(' ', '\\s')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"')
    .replaceAll('`', '\\`');
}
