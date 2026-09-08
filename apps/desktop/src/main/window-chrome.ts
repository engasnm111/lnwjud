export interface WindowChromeOptions {
  readonly titleBarStyle?: 'default' | 'hidden' | 'hiddenInset' | 'customButtonsOnHover';
  readonly titleBarOverlay?: boolean | {
    readonly color?: string;
    readonly symbolColor?: string;
    readonly height?: number;
  };
  readonly trafficLightPosition?: { readonly x: number; readonly y: number };
}

/** Keep platform-specific frame behavior at the Electron composition edge. */
export function windowChromeOptions(platform: NodeJS.Platform = process.platform): WindowChromeOptions {
  if (platform === 'darwin') {
    // Keep the native traffic lights visible while allowing the app header to
    // draw into the title-bar area. Electron owns the buttons and lifecycle.
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 12 } };
  }
  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#07090e', symbolColor: '#f5c542', height: 38 },
    };
  }
  // Linux window managers have their own decoration and button conventions;
  // do not send Windows overlay options to GTK/KDE hosts.
  return {};
}
