import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import {
  appError,
  err,
  isApplicationAuthorized,
  ok,
  type InvocationAuthorization,
  type Result,
} from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { NativeCapabilityPathPolicy } from './native-path-policy.js';
import { detectLinuxSessionProfile, type LinuxSessionProfile } from './linux-session-profile.js';

export type PosixMediaCapabilityName = 'audio' | 'screen_record';

export interface PosixMediaRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PosixMediaProcessHandle {
  readonly pid: number;
  isRunning(): boolean;
  wait(): Promise<PosixMediaRunResult>;
  stop(): Promise<void>;
}

export interface PosixMediaRuntime {
  executableAvailable(executable: string): Promise<boolean>;
  start(executable: string, args: readonly string[], signal?: AbortSignal): Promise<PosixMediaProcessHandle>;
}

export interface PosixMediaBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly linuxSessionProfile?: LinuxSessionProfile;
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
  readonly runtime?: PosixMediaRuntime;
}

/**
 * macOS/Linux media boundary. It uses ordinary first-party OS/ffmpeg providers
 * where the contract is stable and fails closed where a secure desktop portal
 * or signed native helper is still required.
 */
export class PosixMediaCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly linuxSessionProfile: LinuxSessionProfile | undefined;
  private readonly runtime: PosixMediaRuntime;
  private readonly pathPolicy: NativeCapabilityPathPolicy;
  private activeAudio: PosixMediaProcessHandle | undefined;
  private activeScreen: { readonly handle: PosixMediaProcessHandle; readonly outputPath: string } | undefined;

  public constructor(
    private readonly capability: PosixMediaCapabilityName,
    options: PosixMediaBackendOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.linuxSessionProfile = this.platform === 'linux'
      ? options.linuxSessionProfile ?? detectLinuxSessionProfile({ platform: this.platform, env: this.env })
      : undefined;
    this.runtime = options.runtime ?? new NodePosixMediaRuntime(this.env);
    this.pathPolicy = new NativeCapabilityPathPolicy(
      capability,
      capability === 'audio' ? ['file_path', 'output_path'] : ['output_path'],
      options.allowedRootsProvider === undefined ? {} : { allowedRootsProvider: options.allowedRootsProvider },
    );
  }

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (this.platform !== 'darwin' && this.platform !== 'linux') {
      return err(appError('INTERNAL_ERROR', 'POSIX media capability is unavailable on this platform', true));
    }
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Media capability input must be an object'));
    if (isSignalAborted(signal)) return err(appError('PROCESS_TIMEOUT', 'Media capability operation was cancelled', true));

    const action = typeof input.action === 'string' ? input.action : '';
    if (action === 'status' || input.dry_run === true) {
      const readiness = await this.readiness();
      return ok({ ...readiness, ...(input.dry_run === true ? { dry_run: true } : {}) });
    }

    const pathCheck = await this.pathPolicy.assertAllowed(input, authorization);
    if (!pathCheck.ok) return pathCheck;
    if (isSignalAborted(signal)) return err(appError('PROCESS_TIMEOUT', 'Media capability operation was cancelled', true));
    if (requiresExplicitConfirmation(this.capability, action)
      && !isApplicationAuthorized(authorization, input.userConfirmed === true)) {
      return err(appError('PERMISSION_REQUIRED', `${this.capability} ${action || 'operation'} requires explicit user confirmation`));
    }

    try {
      return this.capability === 'audio'
        ? await this.executeAudio(action, input, signal)
        : await this.executeScreenRecord(action, input);
    } catch (error) {
      return err(appError('INTERNAL_ERROR', `${this.capability} ${action || 'operation'} failed: ${errorMessage(error)}`, true));
    }
  }

  private async readiness(): Promise<Record<string, unknown>> {
    if (this.capability === 'audio') return this.audioReadiness();
    return this.screenReadiness();
  }

  private async audioReadiness(): Promise<Record<string, unknown>> {
    const ffmpeg = await this.runtime.executableAvailable('ffmpeg');
    const playback = await this.playbackProvider();
    const recordProvider = this.platform === 'darwin'
      ? 'avfoundation'
      : await this.linuxAudioInputProvider();
    const recordReady = ffmpeg && recordProvider !== undefined;
    const playbackReady = playback !== undefined;
    const ready = recordReady && playbackReady;
    return {
      available: recordReady || playbackReady,
      ready,
      local: true,
      backend: 'posix-media',
      platform: this.platform,
      record_ready: recordReady,
      playback_ready: playbackReady,
      record_provider: recordReady ? recordProvider : null,
      playback_provider: playback ?? null,
      active: this.activeAudio?.isRunning() === true,
      ...(ready ? {} : {
        reason: !ffmpeg
          ? 'ffmpeg_not_installed'
          : recordProvider === undefined
            ? 'audio_record_provider_not_found'
            : 'audio_playback_provider_not_found',
      }),
    };
  }

  private async screenReadiness(): Promise<Record<string, unknown>> {
    if (this.platform === 'darwin') {
      return {
        available: false,
        ready: false,
        local: true,
        backend: 'posix-media',
        platform: this.platform,
        provider: 'screencapturekit',
        reason: 'macos_signed_screen_capture_provider_required',
      };
    }
    const session = this.linuxSessionProfile!;
    if (!session.interactive) {
      return {
        available: false,
        ready: false,
        local: true,
        backend: 'posix-media',
        platform: this.platform,
        session: session.session,
        reason: 'desktop_session_unavailable',
      };
    }
    if (session.session === 'wayland') {
      return {
        available: false,
        ready: false,
        local: true,
        backend: 'posix-media',
        platform: this.platform,
        session: session.session,
        reason: 'wayland_screen_capture_portal_required',
      };
    }
    const ffmpeg = await this.runtime.executableAvailable('ffmpeg');
    const display = session.display;
    const ready = ffmpeg && display !== undefined;
    return {
      available: ready,
      ready,
      local: true,
      backend: 'posix-media',
      platform: this.platform,
      session: session.session,
      provider: ffmpeg ? 'ffmpeg-x11grab' : null,
      display: display ?? null,
      recording: this.activeScreen?.handle.isRunning() === true,
      ...(this.activeScreen?.handle.isRunning() === true ? { pid: this.activeScreen.handle.pid, output_path: this.activeScreen.outputPath } : {}),
      ...(ready ? {} : { reason: !ffmpeg ? 'ffmpeg_not_installed' : 'x11_display_unavailable' }),
    };
  }

  private async executeAudio(action: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    switch (action) {
      case 'record': return this.recordAudio(input, signal);
      case 'play': return this.playAudio(input, signal);
      case 'stop': {
        const active = this.activeAudio;
        if (active === undefined || !active.isRunning()) {
          this.activeAudio = undefined;
          return ok({ stopped: false, reason: 'No active audio operation' });
        }
        await active.stop();
        this.activeAudio = undefined;
        return ok({ stopped: true });
      }
      default: return err(appError('INVALID_INPUT', `Unsupported audio action: ${action}`));
    }
  }

  private async recordAudio(input: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.activeAudio?.isRunning() === true) return err(appError('INVALID_INPUT', 'An audio operation is already active', true));
    if (!await this.runtime.executableAvailable('ffmpeg')) {
      return err(appError('INTERNAL_ERROR', 'ffmpeg is not installed; install ffmpeg to record audio', true));
    }
    const outputPath = requiredString(input.output_path, 'output_path');
    const duration = boundedInteger(input.duration_seconds, 10, 1, 600, 'duration_seconds');
    const provider = this.platform === 'darwin' ? 'avfoundation' : await this.linuxAudioInputProvider();
    if (provider === undefined) {
      return err(appError('INTERNAL_ERROR', 'No supported Linux audio capture provider is available; configure PulseAudio/PipeWire compatibility or ALSA utilities', true));
    }
    const args = this.platform === 'darwin'
      ? ['-y', '-loglevel', 'error', '-f', 'avfoundation', '-i', ':0', '-t', String(duration), outputPath]
      : ['-y', '-loglevel', 'error', '-f', provider, '-i', 'default', '-t', String(duration), outputPath];
    const handle = await this.runtime.start('ffmpeg', args, signal);
    this.activeAudio = handle;
    const result = await handle.wait();
    if (this.activeAudio === handle) this.activeAudio = undefined;
    if (result.exitCode !== 0) return err(appError('INTERNAL_ERROR', result.stderr.trim() || `ffmpeg exited with ${result.exitCode}`, true));
    return ok({ recorded: true, output_path: outputPath, duration_seconds: duration, provider });
  }

  private async playAudio(input: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.activeAudio?.isRunning() === true) return err(appError('INVALID_INPUT', 'An audio operation is already active', true));
    const filePath = requiredString(input.file_path, 'file_path');
    const provider = await this.playbackProvider();
    if (provider === undefined) return err(appError('INTERNAL_ERROR', 'No supported audio playback command is installed', true));
    const args = provider === 'ffplay'
      ? ['-nodisp', '-autoexit', '-loglevel', 'error', filePath]
      : [filePath];
    const handle = await this.runtime.start(provider, args, signal);
    this.activeAudio = handle;
    const result = await handle.wait();
    if (this.activeAudio === handle) this.activeAudio = undefined;
    if (result.exitCode !== 0) return err(appError('INTERNAL_ERROR', result.stderr.trim() || `${provider} exited with ${result.exitCode}`, true));
    return ok({ played: true, file_path: filePath, provider });
  }

  private async executeScreenRecord(action: string, input: Record<string, unknown>): Promise<Result<unknown>> {
    switch (action) {
      case 'start': {
        const readiness = await this.screenReadiness();
        if (readiness.ready !== true) {
          const reason = typeof readiness.reason === 'string' ? readiness.reason : 'screen_record_provider_unavailable';
          const code = reason.includes('portal') || reason.includes('signed_screen_capture') ? 'PERMISSION_REQUIRED' : 'INTERNAL_ERROR';
          return err(appError(code, screenReadinessMessage(reason), true));
        }
        if (this.activeScreen?.handle.isRunning() === true) {
          return err(appError('INVALID_INPUT', 'A screen recording is already active', true));
        }
        const outputPath = requiredString(input.output_path, 'output_path');
        const x = boundedInteger(input.offset_x, 0, -16_384, 16_384, 'offset_x');
        const y = boundedInteger(input.offset_y, 0, -16_384, 16_384, 'offset_y');
        const width = boundedInteger(input.width, 1920, 1, 7680, 'width');
        const height = boundedInteger(input.height, 1080, 1, 4320, 'height');
        const fps = boundedInteger(input.fps, 10, 1, 60, 'fps');
        const display = this.linuxSessionProfile!.display!;
        const args = [
          '-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', String(fps),
          '-video_size', `${width}x${height}`, '-i', `${display}+${x},${y}`,
          '-t', '3600', '-pix_fmt', 'yuv420p', outputPath,
        ];
        const handle = await this.runtime.start('ffmpeg', args);
        const state = { handle, outputPath };
        this.activeScreen = state;
        void handle.wait().finally(() => {
          if (this.activeScreen === state) this.activeScreen = undefined;
        });
        return ok({ recording: true, pid: handle.pid, output_path: outputPath, max_duration_seconds: 3600, provider: 'ffmpeg-x11grab' });
      }
      case 'stop': {
        const state = this.activeScreen;
        if (state === undefined || !state.handle.isRunning()) {
          this.activeScreen = undefined;
          return ok({ recording: false, reason: 'No active recording' });
        }
        await state.handle.stop();
        if (this.activeScreen === state) this.activeScreen = undefined;
        return ok({ recording: false, output_path: state.outputPath });
      }
      default: return err(appError('INVALID_INPUT', `Unsupported screen_record action: ${action}`));
    }
  }

  private async linuxAudioInputProvider(): Promise<'pulse' | 'alsa' | undefined> {
    const pulseServer = this.env.PULSE_SERVER?.trim();
    if (pulseServer !== undefined && pulseServer.length > 0) return 'pulse';
    if (await this.runtime.executableAvailable('pactl')) return 'pulse';
    if (await this.runtime.executableAvailable('arecord')) return 'alsa';
    return undefined;
  }

  private async playbackProvider(): Promise<string | undefined> {
    const candidates = this.platform === 'darwin'
      ? ['/usr/bin/afplay', 'ffplay']
      : ['paplay', 'aplay', 'ffplay'];
    for (const candidate of candidates) {
      if (await this.runtime.executableAvailable(candidate)) return candidate;
    }
    return undefined;
  }
}

class NodePosixMediaRuntime implements PosixMediaRuntime {
  public constructor(private readonly env: Readonly<Record<string, string | undefined>>) {}

  public async executableAvailable(executable: string): Promise<boolean> {
    if (path.isAbsolute(executable)) return isExecutable(executable);
    const searchPath = this.env.PATH ?? '';
    for (const root of searchPath.split(path.delimiter).filter(Boolean)) {
      if (await isExecutable(path.join(root, executable))) return true;
    }
    return false;
  }

  public async start(executable: string, args: readonly string[], signal?: AbortSignal): Promise<PosixMediaProcessHandle> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(signal === undefined ? {} : { signal }),
      });
      const onError = (error: Error): void => { reject(error); };
      child.once('error', onError);
      child.once('spawn', () => {
        child.off('error', onError);
        child.stdin.end();
        resolve(new NodePosixMediaProcessHandle(child));
      });
    });
  }
}

class NodePosixMediaProcessHandle implements PosixMediaProcessHandle {
  private stdout = '';
  private stderr = '';
  private readonly completion: Promise<PosixMediaRunResult>;

  public constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { this.stdout = boundedAppend(this.stdout, chunk); });
    child.stderr.on('data', (chunk: string) => { this.stderr = boundedAppend(this.stderr, chunk); });
    this.completion = new Promise((resolve) => {
      child.once('close', (code) => resolve({ exitCode: code ?? -1, stdout: this.stdout, stderr: this.stderr }));
    });
  }

  public get pid(): number { return this.child.pid ?? -1; }
  public isRunning(): boolean { return this.child.exitCode === null && !this.child.killed; }
  public wait(): Promise<PosixMediaRunResult> { return this.completion; }

  public async stop(): Promise<void> {
    if (!this.isRunning()) return;
    this.child.kill('SIGINT');
    await Promise.race([this.completion.then(() => undefined), delay(1_500)]);
    if (this.isRunning()) this.child.kill('SIGTERM');
    await Promise.race([this.completion.then(() => undefined), delay(1_000)]);
    if (this.isRunning()) this.child.kill('SIGKILL');
  }
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function requiresExplicitConfirmation(capability: PosixMediaCapabilityName, action: string): boolean {
  return capability === 'audio' ? action !== 'status' : action !== 'status';
}

function screenReadinessMessage(reason: string): string {
  switch (reason) {
    case 'macos_signed_screen_capture_provider_required': return 'macOS screen recording requires the signed ScreenCaptureKit provider and Screen Recording permission';
    case 'wayland_screen_capture_portal_required': return 'Wayland screen recording requires a user-approved ScreenCast portal session';
    case 'desktop_session_unavailable': return 'Screen recording requires an interactive desktop session';
    case 'ffmpeg_not_installed': return 'ffmpeg is not installed; install ffmpeg to use screen_record';
    case 'x11_display_unavailable': return 'X11 display is unavailable for screen recording';
    default: return 'Screen recording provider is not ready';
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required`);
  return value;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return candidate;
}

function boundedAppend(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= 128 * 1024 ? combined : combined.slice(-128 * 1024);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
