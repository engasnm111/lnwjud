import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TunnelRunState, TunnelStatus } from '@lnwjud/ipc-contracts';

const execFileAsync = promisify(execFile);

const PROFILE_NAME = 'lnwjud';
const SECRET_FILE = 'lnwjud.runtime.secret';
const CLIENT_PATH_SETTING = 'tunnel_client_path';
const MCP_CONNECTION_MAX_TTL = '168h';
const EXTERNAL_PROBE_TTL_MS = 4_000;

export interface TunnelControllerOptions {
  readonly getClientPath: () => string | null;
  readonly setClientPath: (value: string) => void;
}

export class TunnelController {
  private child: ChildProcess | null = null;
  private state: TunnelRunState = 'stopped';
  private message: string | null = null;
  private externalProbeAt = 0;
  private lastExternalProbe = false;

  public constructor(private readonly options: TunnelControllerOptions) {}

  public profileDirectory(): string {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'tunnel-client');
  }

  public secretPath(): string {
    return path.join(this.profileDirectory(), SECRET_FILE);
  }

  public profilePath(): string {
    return path.join(this.profileDirectory(), `${PROFILE_NAME}.yaml`);
  }

  public logPath(): string {
    return path.join(this.profileDirectory(), 'lnwjud-tunnel.log');
  }

  public defaultClientPath(): string {
    return path.join(os.homedir(), 'Downloads', 'tunnel', 'tunnel-client.exe');
  }

  public resolveClientPath(): string | null {
    const configured = this.options.getClientPath();
    if (configured !== null && configured.trim().length > 0 && existsSync(configured)) return configured;
    const fallback = this.defaultClientPath();
    return existsSync(fallback) ? fallback : configured;
  }

  public async hasApiKey(): Promise<boolean> {
    try {
      const raw = await readFile(this.secretPath(), 'utf8');
      return raw.trim().length > 0;
    } catch {
      return false;
    }
  }

  public async saveApiKey(apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) throw new Error('Runtime API key is required');
    await mkdir(this.profileDirectory(), { recursive: true });
    const encrypted = await encryptWithDpapi(trimmed);
    await writeFile(this.secretPath(), encrypted, 'utf8');
  }

  public setClientPath(clientPath: string): string {
    const resolved = path.resolve(clientPath.trim());
    if (!existsSync(resolved)) throw new Error('tunnel-client.exe was not found');
    this.options.setClientPath(resolved);
    return resolved;
  }

  public async status(): Promise<TunnelStatus> {
    const clientPath = this.resolveClientPath();
    let source: TunnelStatus['source'] = 'desktop';
    if (this.child !== null && this.child.exitCode === null) {
      this.state = 'running';
      this.message = null;
    } else if (this.child !== null && this.child.exitCode !== null) {
      this.child = null;
      if (this.state === 'running') this.state = 'stopped';
    } else if (this.state !== 'starting') {
      // No desktop-owned child: reflect a tunnel started externally (e.g. start-lnwjud-tunnel.ps1).
      if (await this.probeExternalRunning()) {
        this.state = 'running';
        this.message = null;
        source = 'external';
      } else if (this.state === 'running') {
        this.state = 'stopped';
      }
    }
    return {
      state: this.state,
      source,
      hasApiKey: await this.hasApiKey(),
      clientPath,
      profileExists: existsSync(this.profilePath()),
      message: this.message,
      logPath: this.logPath(),
    };
  }

  private async probeExternalRunning(): Promise<boolean> {
    const now = Date.now();
    if (now - this.externalProbeAt < EXTERNAL_PROBE_TTL_MS) return this.lastExternalProbe;
    this.externalProbeAt = now;
    this.lastExternalProbe = await isLnwjudTunnelProcessRunning();
    return this.lastExternalProbe;
  }

  public async start(): Promise<TunnelStatus> {
    if (this.state === 'running' || this.state === 'starting') return this.status();
    if (await isLnwjudTunnelProcessRunning()) {
      this.state = 'running';
      this.message = null;
      return this.status();
    }

    const clientPath = this.resolveClientPath();
    if (clientPath === null || !existsSync(clientPath)) {
      this.state = 'error';
      this.message = 'tunnel-client.exe was not found';
      return this.status();
    }
    if (!(await this.hasApiKey())) {
      this.state = 'error';
      this.message = 'Save a Runtime API key first';
      return this.status();
    }
    if (!existsSync(this.profilePath())) {
      this.state = 'error';
      this.message = 'Missing tunnel profile lnwjud.yaml';
      return this.status();
    }

    const apiKey = (await decryptWithDpapi(await readFile(this.secretPath(), 'utf8'))).trim();
    if (apiKey.length === 0) {
      this.state = 'error';
      this.message = 'Saved Runtime API key is empty; save it again in Settings';
      return this.status();
    }
    this.state = 'starting';
    this.message = null;
    await mkdir(this.profileDirectory(), { recursive: true });

    try {
      await runTunnelDoctor(clientPath, apiKey, this.profileDirectory());
    } catch (error: unknown) {
      this.state = 'error';
      this.message = error instanceof Error ? error.message : 'tunnel-client doctor failed';
      return this.status();
    }

    const child = spawn(
      clientPath,
      [
        'run',
        '--profile', PROFILE_NAME,
        '--profile-dir', this.profileDirectory(),
        '--log.file', this.logPath(),
        '--mcp.connection-max-ttl', MCP_CONNECTION_MAX_TTL,
      ],
      {
        env: tunnelClientEnv(apiKey, this.profileDirectory()),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', () => undefined);
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      this.state = code === 0 ? 'stopped' : 'error';
      this.message = code === 0 ? null : `tunnel-client exited with code ${code ?? 'unknown'}`;
    });
    this.state = 'running';
    return this.status();
  }

  public async stop(): Promise<TunnelStatus> {
    if (this.child !== null) {
      const child = this.child;
      this.child = null;
      child.kill();
    }
    await stopExternalLnwjudTunnelProcesses();
    this.state = 'stopped';
    this.message = null;
    return this.status();
  }
}

export { CLIENT_PATH_SETTING };

async function encryptWithDpapi(plain: string): Promise<string> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$plain = [Console]::In.ReadToEnd()',
    '$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force',
    'ConvertFrom-SecureString -SecureString $secure',
  ].join('; ');
  return runPowerShellWithStdin(script, plain);
}

async function decryptWithDpapi(encrypted: string): Promise<string> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$encrypted = [Console]::In.ReadToEnd().Trim()',
    '$secure = ConvertTo-SecureString -String $encrypted',
    '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
  ].join('; ');
  return runPowerShellWithStdin(script, encrypted);
}

function runPowerShellWithStdin(command: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code ?? 'unknown'}`));
        return;
      }
      const value = stdout.replace(/\r?\n$/, '');
      if (value.length === 0) {
        reject(new Error('PowerShell returned an empty result'));
        return;
      }
      resolve(value);
    });
    child.stdin.end(input, 'utf8');
  });
}

function tunnelClientEnv(apiKey: string, profileDirectory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const userProfile = process.env.USERPROFILE ?? os.homedir();
  const appData = process.env.APPDATA ?? path.join(userProfile, 'AppData', 'Roaming');
  env.CONTROL_PLANE_API_KEY = apiKey.trim();
  env.MCP_CONNECTION_MAX_TTL = MCP_CONNECTION_MAX_TTL;
  env.TUNNEL_CLIENT_PROFILE = PROFILE_NAME;
  env.TUNNEL_CLIENT_PROFILE_DIR = profileDirectory;
  env.USERPROFILE = userProfile;
  env.APPDATA = appData;
  env.HOME = userProfile;
  delete env.XDG_CONFIG_HOME;
  return env;
}

async function runTunnelDoctor(clientPath: string, apiKey: string, profileDirectory: string): Promise<void> {
  try {
    await execFileAsync(clientPath, ['doctor', '--profile', PROFILE_NAME, '--profile-dir', profileDirectory, '--explain'], {
      env: tunnelClientEnv(apiKey, profileDirectory),
      windowsHide: true,
      encoding: 'utf8',
      timeout: 60_000,
    });
  } catch (error: unknown) {
    const detail = extractExecDetail(error);
    throw new Error(detail.length > 0 ? detail : 'tunnel-client doctor failed');
  }
}

function extractExecDetail(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const record = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
  if (stderr.length > 0) return stderr.slice(0, 500);
  const stdout = typeof record.stdout === 'string' ? record.stdout.trim() : '';
  if (stdout.length > 0) return stdout.slice(0, 500);
  return typeof record.message === 'string' ? record.message : '';
}

async function isLnwjudTunnelProcessRunning(): Promise<boolean> {
  try {
    const result = await Promise.race([
      execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "@(Get-CimInstance Win32_Process -Filter \"Name = 'tunnel-client.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match '(?i)(--profile\\s+lnwjud|lnwjud\\.yaml)' }).Count",
      ], { windowsHide: true, encoding: 'utf8', timeout: 3_000 }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('tunnel process probe timed out')), 3_500);
      }),
    ]);
    return Number(result.stdout.trim()) > 0;
  } catch {
    return false;
  }
}

async function stopExternalLnwjudTunnelProcesses(): Promise<void> {
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name = 'tunnel-client.exe'\" | Where-Object { $_.CommandLine -match '(?i)(--profile\\s+lnwjud|lnwjud\\.yaml)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ], { windowsHide: true });
  } catch {
    // Best-effort stop.
  }
}
