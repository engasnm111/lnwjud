import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { WindowsProcessTree, type ProcessTreeTerminator } from '@lnwjud/process';
import type { BrowserCdpProtocol, BrowserCdpTab } from './browser-cdp-backend.js';

interface BrowserCdpProtocolOptions {
  readonly port?: number;
  readonly profileDir?: string;
  readonly chromeExecutable?: string;
  readonly terminator?: ProcessTreeTerminator;
  readonly terminationRetryMs?: number;
}

export class NodeBrowserCdpProtocol implements BrowserCdpProtocol {
  public readonly port: number;
  private readonly profileDir: string;
  private readonly chromeExecutable: string | undefined;
  private readonly terminator: ProcessTreeTerminator;
  private readonly terminationRetryMs: number;

  public constructor(options: BrowserCdpProtocolOptions = {}) {
    this.port = options.port ?? readPort(process.env.LNWJUD_BROWSER_CDP_PORT);
    this.profileDir = options.profileDir ?? process.env.LNWJUD_BROWSER_PROFILE ?? path.join(os.tmpdir(), 'lnwjud-browser-profile');
    this.chromeExecutable = options.chromeExecutable ?? process.env.LNWJUD_BROWSER_EXECUTABLE;
    this.terminator = options.terminator ?? new WindowsProcessTree();
    this.terminationRetryMs = Math.max(1, options.terminationRetryMs ?? 250);
  }

  public async status(signal?: AbortSignal): Promise<{ readonly ready: boolean; readonly port: number }> {
    try {
      const response = await fetch(this.endpoint('/json/version'), signal === undefined ? undefined : { signal });
      return { ready: response.ok, port: this.port };
    } catch {
      return { ready: false, port: this.port };
    }
  }

  public async listTabs(signal?: AbortSignal): Promise<readonly BrowserCdpTab[]> {
    const value = await this.requestJson('/json/list', signal);
    if (!Array.isArray(value)) throw new Error('Chrome tabs response was invalid');
    return value.flatMap((item) => {
      const tab = toTab(item);
      return tab === undefined ? [] : [tab];
    });
  }

  public async newTab(url: string, signal?: AbortSignal): Promise<BrowserCdpTab> {
    const response = await fetch(this.endpoint(`/json/new?${encodeURIComponent(url)}`), { method: 'PUT', ...(signal === undefined ? {} : { signal }) });
    if (!response.ok) throw new Error(`Chrome new-tab request failed: ${response.status}`);
    const value: unknown = await response.json();
    const tab = toTab(value);
    if (tab === undefined) throw new Error('Chrome new-tab response was invalid');
    return tab;
  }

  public async closeTab(tabId: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(this.endpoint(`/json/close/${encodeURIComponent(tabId)}`), signal === undefined ? undefined : { signal });
    return { closed: response.ok, tab_id: tabId };
  }

  public async request(tabId: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const tabs = await this.listTabs(signal);
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) throw new Error('Chrome tab was not found');
    const socketUrl = validateWebSocketUrl(tab.webSocketDebuggerUrl, this.port);
    return sendWebSocketRequest(socketUrl, method, params, signal);
  }

  public async launch(url: string | undefined, signal?: AbortSignal): Promise<Result<unknown>> {
    if (isAborted(signal)) return cancelledBrowserLaunch();
    const existing = await this.status(signal);
    if (isAborted(signal)) return cancelledBrowserLaunch();
    if (existing.ready) return ok({ ready: true, port: this.port, launched: false });
    const executable = this.findChromeExecutable();
    if (executable === undefined) return err(appError('EXECUTABLE_NOT_FOUND', 'Google Chrome was not found'));
    try {
      await mkdir(this.profileDir, { recursive: true });
      if (isAborted(signal)) return cancelledBrowserLaunch();
      const args = [
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        ...(url === undefined ? [] : [url]),
      ];
      const child = spawn(executable, args, { shell: false, windowsHide: true, detached: false, stdio: 'ignore' });
      return this.waitForLaunch(child, signal);
    } catch {
      return err(appError('INTERNAL_ERROR', 'Chrome could not be started', true));
    }
  }

  private async waitForLaunch(child: ChildProcess, signal?: AbortSignal): Promise<Result<unknown>> {
    const deadline = Date.now() + 30_000;
    while (Date.now() <= deadline) {
      if (isAborted(signal)) {
        await stopUntilVerified(child, this.terminator, this.terminationRetryMs);
        return cancelledBrowserLaunch();
      }
      const state = await this.status(signal);
      if (isAborted(signal)) {
        await stopUntilVerified(child, this.terminator, this.terminationRetryMs);
        return cancelledBrowserLaunch();
      }
      if (state.ready) return ok({ ready: true, port: this.port, launched: true });
      await delay(100, signal);
    }
    await stopUntilVerified(child, this.terminator, this.terminationRetryMs);
    return err(appError('PROCESS_TIMEOUT', 'Chrome CDP did not become ready', true));
  }

  private endpoint(resource: string): string {
    return `http://127.0.0.1:${this.port}${resource}`;
  }

  private async requestJson(resource: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(this.endpoint(resource), signal === undefined ? undefined : { signal });
    if (!response.ok) throw new Error(`Chrome CDP HTTP request failed: ${response.status}`);
    const value: unknown = await response.json();
    return value;
  }

  private findChromeExecutable(): string | undefined {
    if (this.chromeExecutable !== undefined && this.chromeExecutable.trim().length > 0) return this.chromeExecutable;
    if (process.platform === 'darwin') {
      return darwinChromeCandidates(os.homedir()).find((candidate) => existsSync(candidate));
    }
    if (process.platform !== 'win32') return undefined;
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const candidates = [
      localAppData === undefined ? undefined : path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      programFiles === undefined ? undefined : path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      programFilesX86 === undefined ? undefined : path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localAppData === undefined ? undefined : path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      programFiles === undefined ? undefined : path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      programFilesX86 === undefined ? undefined : path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    return candidates.find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));
  }
}

/** macOS browser bundle locations searched for a CDP-capable Chromium engine;
 * system-wide installs are preferred over the user's own ~/Applications. */
export function darwinChromeCandidates(homedir: string): readonly string[] {
  return [
    path.join('/Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    path.join('/Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
    path.join('/Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    path.join('/Applications', 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'),
    path.join(homedir, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  ];
}

function toTab(value: unknown): BrowserCdpTab | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.url !== 'string' || typeof value.webSocketDebuggerUrl !== 'string') return undefined;
  return { id: value.id, title: value.title, url: value.url, webSocketDebuggerUrl: value.webSocketDebuggerUrl };
}

export function validateWebSocketUrl(value: string, port: number): string {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') || (url.port !== '' && Number(url.port) !== port)) throw new Error('Chrome CDP socket is not local');
  return url.toString();
}

function sendWebSocketRequest(url: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') {
      reject(new Error('WebSocket is not available'));
      return;
    }
    const socket = new WebSocket(url);
    const id = 1;
    let settled = false;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Chrome CDP request timed out'));
    }, 30_000);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.close();
      callback();
    };
    const onAbort = (): void => finish(() => reject(new Error('Chrome CDP request was cancelled')));
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id, method, params })));
    socket.addEventListener('message', (event: MessageEvent) => {
      const value: unknown = typeof event.data === 'string' ? parseJson(event.data) : undefined;
      if (!isRecord(value) || value.id !== id) return;
      finish(() => resolve(value));
    });
    socket.addEventListener('error', () => finish(() => reject(new Error('Chrome CDP socket failed'))));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPort(value: string | undefined): number {
  const port = value === undefined ? 9222 : Number(value);
  return Number.isInteger(port) && port >= 9222 && port <= 9322 ? port : 9222;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function cancelledBrowserLaunch(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Chrome launch was cancelled', true));
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function stopUntilVerified(child: ChildProcess, terminator: ProcessTreeTerminator, retryMs: number): Promise<void> {
  while (true) {
    const pid = child.pid;
    if (pid !== undefined) {
      try {
        await terminator.stop(child, pid);
        return;
      } catch {
        // Do not release the caller while Chrome descendants remain unverified.
        if (child.exitCode !== null || child.signalCode !== null) await neverSettles();
      }
    }
    await delay(retryMs);
  }
}

function neverSettles(): Promise<never> {
  return new Promise<never>(() => undefined);
}
