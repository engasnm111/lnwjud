export type LinuxDesktopSession = 'headless' | 'x11' | 'wayland';

export interface LinuxSessionProfile {
  readonly platformSupported: boolean;
  readonly session: LinuxDesktopSession;
  readonly interactive: boolean;
  readonly display: string | undefined;
  readonly waylandDisplay: string | undefined;
  readonly dbusSessionAvailable: boolean;
}

export interface LinuxSessionDetectionOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Detects Linux desktop-session evidence only. This intentionally does not
 * infer native-tool permission or portal authorization from the presence of
 * DISPLAY/DBus variables.
 */
export function detectLinuxSessionProfile(options: LinuxSessionDetectionOptions = {}): LinuxSessionProfile {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== 'linux') {
    return {
      platformSupported: false,
      session: 'headless',
      interactive: false,
      display: undefined,
      waylandDisplay: undefined,
      dbusSessionAvailable: false,
    };
  }

  const sessionType = normalized(env.XDG_SESSION_TYPE);
  const display = nonEmpty(env.DISPLAY);
  const waylandDisplay = nonEmpty(env.WAYLAND_DISPLAY);
  const session: LinuxDesktopSession = sessionType === 'wayland' || waylandDisplay !== undefined
    ? 'wayland'
    : sessionType === 'x11' || display !== undefined
      ? 'x11'
      : 'headless';

  return {
    platformSupported: true,
    session,
    interactive: session !== 'headless',
    display,
    waylandDisplay,
    dbusSessionAvailable: nonEmpty(env.DBUS_SESSION_BUS_ADDRESS) !== undefined,
  };
}

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
