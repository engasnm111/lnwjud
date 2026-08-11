import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { BrowserCdpProtocol, BrowserCdpTab } from './browser-cdp-backend.js';

interface BrowserCdpProtocolOptions {
  readonly port?: number;
  readonly profileDir?: string;
  readonly chromeExecutable?: string;
}

export class NodeBrowserCdpProtocol implements BrowserCdpProtocol {
  public readonly port: number;
  private readonly profileDir: string;
  private readonly chromeExecutable: string | undefined;

  public constructor(options: BrowserCdpProtocolOptions = {}) {
    this.port = options.port ?? readPort(process.env.LNWJUD_BROWSER_CDP_PORT);
    this.profileDir = options.profileDir ?? process.env.LNWJUD_BROWSER_PROFILE ?? path.join(os.tmpdir(), 'lnwjud-browser-profile');
    this.chromeExecutable = options.chromeExecutable ?? process.env.LNWJUD_BROWSER_EXECUTABLE;
  }

  public async status(): Promise<{ readonly ready: boolean; readonly port: number }> {
    try {
      const response = await fetch(this.endpoint('/json/version'));
      return { ready: response.ok, port: this.port };
    } catch {
      return { ready: false, port: this.port };
    }
  }

  public async listTabs(): Promise<readonly BrowserCdpTab[]> {
    const value = await this.requestJson('/json/list');
    if (!Array.isArray(value)) throw new Error('Chrome tabs response was invalid');
    return value.flatMap((item) => {
      const tab = toTab(item);
      return tab === undefined ? [] : [tab];
    });
  }

  public async newTab(url: string): Promise<BrowserCdpTab> {
    const response = await fetch(this.endpoint(`/json/new?${encodeURIComponent(url)}`), { method: 'PUT' });
    if (!response.ok) throw new Error(`Chrome new-tab request failed: ${response.status}`);
    const value: unknown = await response.json();
    const tab = toTab(value);
    if (tab === undefined) throw new Error('Chrome new-tab response was invalid');
    return tab;
  }

  public async closeTab(tabId: string): Promise<unknown> {
    const response = await fetch(this.endpoint(`/json/close/${encodeURIComponent(tabId)}`));
    return { closed: response.ok, tab_id: tabId };
  }

  public async request(tabId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const tabs = await this.listTabs();
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) throw new Error('Chrome tab was not found');
    const socketUrl = validateWebSocketUrl(tab.webSocketDebuggerUrl, this.port);
    return sendWebSocketRequest(socketUrl, method, params);
  }

  public async launch(url: string | undefined): Promise<Result<unknown>> {
    const existing = await this.status();
    if (existing.ready) return ok({ ready: true, port: this.port, launched: false });
    const executable = this.findChromeExecutable();
    if (executable === undefined) return err(appError('EXECUTABLE_NOT_FOUND', 'Google Chrome was not found'));
    try {
      await mkdir(this.profileDir, { recursive: true });
      const args = [
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        ...(url === undefined ? [] : [url]),
      ];
      spawn(executable, args, { shell: false, windowsHide: true, detached: false, stdio: 'ignore' });
    } catch {
      return err(appError('INTERNAL_ERROR', 'Chrome could not be started', true));
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() <= deadline) {
      const state = await this.status();
      if (state.ready) return ok({ ready: true, port: this.port, launched: true });
      await delay(100);
    }
    return err(appError('PROCESS_TIMEOUT', 'Chrome CDP did not become ready', true));
  }

  private endpoint(resource: string): string {
    return `http://127.0.0.1:${this.port}${resource}`;
  }

  private async requestJson(resource: string): Promise<unknown> {
    const response = await fetch(this.endpoint(resource));
    if (!response.ok) throw new Error(`Chrome CDP HTTP request failed: ${response.status}`);
    const value: unknown = await response.json();
    return value;
  }

  private findChromeExecutable(): string | undefined {
    if (this.chromeExecutable !== undefined && this.chromeExecutable.trim().length > 0) return this.chromeExecutable;
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

function toTab(value: unknown): BrowserCdpTab | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.url !== 'string' || typeof value.webSocketDebuggerUrl !== 'string') return undefined;
  return { id: value.id, title: value.title, url: value.url, webSocketDebuggerUrl: value.webSocketDebuggerUrl };
}

function validateWebSocketUrl(value: string, port: number): string {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') || (url.port !== '' && Number(url.port) !== port)) throw new Error('Chrome CDP socket is not local');
  return url.toString();
}

function sendWebSocketRequest(url: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') {
      reject(new Error('WebSocket is not available'));
      return;
    }
    const socket = new WebSocket(url);
    const id = 1;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Chrome CDP request timed out'));
    }, 30_000);
    const finish = (callback: () => void): void => {
      clearTimeout(timer);
      socket.close();
      callback();
    };
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id, method, params })));
    socket.addEventListener('message', (event: MessageEvent) => {
      const value: unknown = typeof event.data === 'string' ? parseJson(event.data) : undefined;
      if (!isRecord(value) || value.id !== id) return;
      finish(() => resolve(value));
    });
    socket.addEventListener('error', () => finish(() => reject(new Error('Chrome CDP socket failed'))));
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
