import { existsSync } from 'node:fs';
import path from 'node:path';

export type LinuxSessionType = 'wayland' | 'x11' | 'headless' | 'unknown';

export interface LinuxSessionProfile {
  readonly platform: 'linux';
  readonly arch: string;
  readonly supportTier: 'supported' | 'preview' | 'unsupported';
  readonly sessionType: LinuxSessionType;
  readonly displayServer: 'wayland' | 'x11' | 'none' | 'unknown';
  readonly dbusAvailable: boolean;
  readonly portalAvailable: boolean;
  readonly secretServiceAvailable: boolean;
  readonly pipewireAvailable: boolean;
  readonly atSpiAvailable: boolean;
  readonly headless: boolean;
  readonly notes: readonly string[];
}

export interface LinuxSessionProfileInput {
  readonly arch: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly commandExists?: (command: string) => boolean;
}

/** Detect session/dependency hints without treating them as permission grants. */
export function detectLinuxSessionProfile(input: LinuxSessionProfileInput): LinuxSessionProfile {
  const env = input.env ?? process.env;
  const commandExists = input.commandExists ?? ((command: string): boolean => commandInPath(command, env));
  const session = readSessionType(env);
  const dbusAvailable = typeof env.DBUS_SESSION_BUS_ADDRESS === 'string' && env.DBUS_SESSION_BUS_ADDRESS.trim().length > 0;
  const busTool = commandExists('busctl') || commandExists('gdbus');
  const portalAvailable = dbusAvailable && busTool;
  const secretServiceAvailable = dbusAvailable && busTool;
  const pipewireAvailable = commandExists('pw-cli') || commandExists('pipewire');
  const atSpiAvailable = dbusAvailable && busTool;
  const supportTier = input.arch === 'x64' ? 'supported' : input.arch === 'arm64' ? 'preview' : 'unsupported';
  const notes: string[] = [];
  if (session === 'wayland') notes.push('Wayland control is limited to user-approved portal sessions.');
  if (session === 'x11') notes.push('X11 input/capture providers require the active display session.');
  if (session === 'headless') notes.push('Headless mode exposes core MCP and non-UI tools only.');
  if (!dbusAvailable) notes.push('DBus session bus was not detected; portal, AT-SPI, and Secret Service providers are dependency-gated.');
  if (!portalAvailable && session === 'wayland') notes.push('Desktop portal command/session is unavailable.');
  if (!secretServiceAvailable) notes.push('Secret Service availability is not proven; secure secret writes remain blocked until Electron safeStorage confirms it.');
  return {
    platform: 'linux',
    arch: input.arch,
    supportTier,
    sessionType: session,
    displayServer: session === 'wayland' ? 'wayland' : session === 'x11' ? 'x11' : session === 'headless' ? 'none' : 'unknown',
    dbusAvailable,
    portalAvailable,
    secretServiceAvailable,
    pipewireAvailable,
    atSpiAvailable,
    headless: session === 'headless',
    notes,
  };
}

function commandInPath(command: string, env: Readonly<Record<string, string | undefined>>): boolean {
  if (path.isAbsolute(command)) return existsSync(command);
  const entries = (env.PATH ?? '').split(path.delimiter).filter((entry) => entry.length > 0);
  return entries.some((entry) => existsSync(path.join(entry, command)));
}

function readSessionType(env: Readonly<Record<string, string | undefined>>): LinuxSessionType {
  const explicit = env.XDG_SESSION_TYPE?.trim().toLowerCase();
  if (explicit === 'wayland' || explicit === 'x11') return explicit;
  if (env.WAYLAND_DISPLAY?.trim()) return 'wayland';
  if (env.DISPLAY?.trim()) return 'x11';
  if (env.SSH_CONNECTION?.trim() || env.TERM?.trim()) return 'headless';
  return 'unknown';
}
