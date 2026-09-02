import type { PlatformContext } from './platform-context.js';

export function executableName(baseName: string, context: Pick<PlatformContext, 'platform'>): string {
  if (baseName.length === 0) throw new Error('Executable base name is required');
  if (context.platform !== 'win32') return baseName;
  return baseName.toLowerCase().endsWith('.exe') ? baseName : `${baseName}.exe`;
}

export function stdioLauncherName(context: Pick<PlatformContext, 'platform'>): string {
  return context.platform === 'win32' ? 'lnwjud-mcp-stdio.cmd' : 'lnwjud-mcp-stdio';
}
