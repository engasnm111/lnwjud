import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow } from 'electron';

const mainDirectory = path.dirname(fileURLToPath(import.meta.url));

export function getPreloadPath(): string {
  return path.resolve(mainDirectory, '..', 'preload', 'index.cjs');
}

export function getRendererEntryPath(): string {
  return path.resolve(mainDirectory, '..', 'renderer', 'index.html');
}

/**
 * macOS nativeImage cannot decode .ico files (an empty image silently results),
 * so darwin must consider PNG candidates first; Windows keeps the legacy
 * .ico-first order for the taskbar/window icon.
 */
export function iconCandidatePaths(baseDirectory: string, platform: NodeJS.Platform): readonly string[] {
  const icoCandidates = [
    path.resolve(baseDirectory, '..', 'renderer', 'favicon.ico'),
    path.resolve(baseDirectory, '..', '..', 'build', 'icon.ico'),
    path.resolve(baseDirectory, '..', '..', 'assets', 'logo', 'logo.ico'),
  ];
  const pngCandidates = [
    path.resolve(baseDirectory, '..', 'renderer', 'favicon-32x32.png'),
    path.resolve(baseDirectory, '..', 'renderer', 'favicon-16x16.png'),
    path.resolve(baseDirectory, '..', 'renderer', 'logo.png'),
    path.resolve(baseDirectory, '..', 'renderer', 'logo-512.png'),
    path.resolve(baseDirectory, '..', '..', 'build', 'icon.png'),
    path.resolve(baseDirectory, '..', '..', 'assets', 'logo', 'logo-256x256.png'),
  ];
  return platform === 'darwin' ? [...pngCandidates, ...icoCandidates] : [...icoCandidates, ...pngCandidates];
}

export function getWindowIconPath(): string | undefined {
  for (const candidate of iconCandidatePaths(mainDirectory, process.platform)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function isAllowedRendererUrl(navigationUrl: string, rendererEntryPath: string): boolean {
  try {
    const parsedUrl = new URL(navigationUrl);
    if (parsedUrl.protocol !== 'file:') return false;
    const requestedPath = path.normalize(fileURLToPath(parsedUrl)).toLowerCase();
    const allowedPath = path.normalize(rendererEntryPath).toLowerCase();
    return requestedPath === allowedPath;
  } catch {
    return false;
  }
}

export function createMainWindow(showOnReady = true): BrowserWindow {
  const rendererEntryPath = getRendererEntryPath();
  const iconPath = getWindowIconPath();
  const isMac = process.platform === 'darwin';

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: showOnReady,
    autoHideMenuBar: true,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 12, y: 10 } } : {
      titleBarOverlay: {
        color: '#07090e',
        symbolColor: '#f5c542',
        height: 38,
      },
    }),

    ...(iconPath !== undefined ? { icon: iconPath } : {}),
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isAllowedRendererUrl(navigationUrl, rendererEntryPath)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  const reveal = (): void => {
    if (mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  if (showOnReady) {
    mainWindow.once('ready-to-show', reveal);
    // Fallback if ready-to-show never fires (blank/hung loads).
    setTimeout(reveal, 1_500);
  }
  void mainWindow.loadFile(rendererEntryPath);
  return mainWindow;
}

export function createLogViewerWindow(): BrowserWindow {
  const rendererEntryPath = getRendererEntryPath();
  const iconPath = getWindowIconPath();
  const isMac = process.platform === 'darwin';

  const viewerWindow = new BrowserWindow({
    width: 960,
    height: 680,
    show: true,
    autoHideMenuBar: true,
    title: 'lnwjud — Live Logs',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 12, y: 10 } } : {
      titleBarOverlay: {
        color: '#07090e',
        symbolColor: '#f5c542',
        height: 38,
      },
    }),

    ...(iconPath !== undefined ? { icon: iconPath } : {}),
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  viewerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  viewerWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isAllowedRendererUrl(navigationUrl, rendererEntryPath)) event.preventDefault();
  });
  viewerWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  void viewerWindow.loadFile(rendererEntryPath, { hash: 'log-viewer' });
  return viewerWindow;
}
