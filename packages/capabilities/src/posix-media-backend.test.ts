import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PosixMediaCapabilityBackend,
  type PosixMediaProcessHandle,
  type PosixMediaRunResult,
  type PosixMediaRuntime,
} from './posix-media-backend.js';
import type { LinuxSessionProfile } from './linux-session-profile.js';

class FakeHandle implements PosixMediaProcessHandle {
  public readonly pid: number;
  private running = true;
  private readonly result: PosixMediaRunResult = { exitCode: 0, stdout: '', stderr: '' };
  private resolvePersistent: ((result: PosixMediaRunResult) => void) | undefined;
  private readonly completion: Promise<PosixMediaRunResult>;

  public constructor(pid: number, persistent: boolean) {
    this.pid = pid;
    this.completion = persistent
      ? new Promise((resolve) => { this.resolvePersistent = resolve; })
      : Promise.resolve(this.result).then((result) => { this.running = false; return result; });
  }

  public isRunning(): boolean { return this.running; }
  public wait(): Promise<PosixMediaRunResult> { return this.completion; }
  public async stop(): Promise<void> {
    this.running = false;
    this.resolvePersistent?.(this.result);
  }
}

function fakeRuntime(available: readonly string[]): PosixMediaRuntime & {
  readonly calls: Array<{ readonly executable: string; readonly args: readonly string[] }>;
} {
  let nextPid = 2000;
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  return {
    calls,
    async executableAvailable(executable): Promise<boolean> { return available.includes(executable); },
    async start(executable, args): Promise<PosixMediaProcessHandle> {
      calls.push({ executable, args: [...args] });
      return new FakeHandle(nextPid++, args.includes('x11grab'));
    },
  };
}

function x11Profile(display = ':0'): LinuxSessionProfile {
  return {
    platformSupported: true,
    session: 'x11',
    interactive: true,
    display,
    waylandDisplay: undefined,
    dbusSessionAvailable: true,
  };
}

function waylandProfile(): LinuxSessionProfile {
  return {
    platformSupported: true,
    session: 'wayland',
    interactive: true,
    display: undefined,
    waylandDisplay: 'wayland-0',
    dbusSessionAvailable: true,
  };
}

describe('PosixMediaCapabilityBackend', () => {
  it('rejects use outside macOS/Linux', async () => {
    const backend = new PosixMediaCapabilityBackend('audio', { platform: 'win32', runtime: fakeRuntime([]) });
    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' },
    });
  });

  it('reports and executes macOS audio with avfoundation + afplay providers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-posix-audio-'));
    const audioFile = path.join(root, 'input.wav');
    const outputFile = path.join(root, 'recorded.wav');
    await writeFile(audioFile, 'fixture');
    const runtime = fakeRuntime(['ffmpeg', '/usr/bin/afplay']);
    const backend = new PosixMediaCapabilityBackend('audio', {
      platform: 'darwin',
      runtime,
      allowedRootsProvider: async () => [root],
    });

    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { available: true, ready: true, record_provider: 'avfoundation', playback_provider: '/usr/bin/afplay' },
    });
    await expect(backend.execute({ action: 'record', output_path: outputFile, duration_seconds: 2, userConfirmed: true })).resolves.toMatchObject({
      ok: true,
      value: { recorded: true, output_path: outputFile, duration_seconds: 2, provider: 'avfoundation' },
    });
    await expect(backend.execute({ action: 'play', file_path: audioFile, userConfirmed: true })).resolves.toMatchObject({
      ok: true,
      value: { played: true, file_path: audioFile, provider: '/usr/bin/afplay' },
    });
    expect(runtime.calls[0]).toMatchObject({ executable: 'ffmpeg' });
    expect(runtime.calls[0]?.args).toContain('avfoundation');
    expect(runtime.calls[1]).toEqual({ executable: '/usr/bin/afplay', args: [audioFile] });
  });

  it('does not infer a Linux audio capture provider from XDG_RUNTIME_DIR alone', async () => {
    const backend = new PosixMediaCapabilityBackend('audio', {
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      runtime: fakeRuntime(['ffmpeg', 'ffplay']),
    });

    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: {
        available: true,
        ready: false,
        record_ready: false,
        playback_ready: true,
        record_provider: null,
        playback_provider: 'ffplay',
        reason: 'audio_record_provider_not_found',
      },
    });
  });

  it('reports Linux Pulse capture ready only when a concrete Pulse provider signal exists', async () => {
    const backend = new PosixMediaCapabilityBackend('audio', {
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      runtime: fakeRuntime(['ffmpeg', 'ffplay', 'pactl']),
    });

    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: {
        available: true,
        ready: true,
        record_ready: true,
        playback_ready: true,
        record_provider: 'pulse',
      },
    });
  });

  it('supports Linux X11 screen recording through ffmpeg x11grab and exposes live status', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-posix-screen-'));
    const outputFile = path.join(root, 'capture.mp4');
    const runtime = fakeRuntime(['ffmpeg']);
    const backend = new PosixMediaCapabilityBackend('screen_record', {
      platform: 'linux',
      linuxSessionProfile: x11Profile(':7'),
      runtime,
      allowedRootsProvider: async () => [root],
    });

    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { available: true, ready: true, session: 'x11', provider: 'ffmpeg-x11grab', recording: false },
    });
    await expect(backend.execute({ action: 'start', output_path: outputFile, width: 1280, height: 720, fps: 15, userConfirmed: true })).resolves.toMatchObject({
      ok: true,
      value: { recording: true, output_path: outputFile, provider: 'ffmpeg-x11grab' },
    });
    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { ready: true, recording: true, output_path: outputFile },
    });
    expect(runtime.calls[0]?.args).toEqual(expect.arrayContaining(['x11grab', '1280x720', ':7+0,0', '15']));
    await expect(backend.execute({ action: 'stop', userConfirmed: true })).resolves.toMatchObject({
      ok: true,
      value: { recording: false, output_path: outputFile },
    });
  });

  it('fails closed on Wayland until a user-approved screen-cast portal provider exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-wayland-screen-'));
    const outputFile = path.join(root, 'capture.mp4');
    const backend = new PosixMediaCapabilityBackend('screen_record', {
      platform: 'linux',
      linuxSessionProfile: waylandProfile(),
      runtime: fakeRuntime(['ffmpeg']),
      allowedRootsProvider: async () => [root],
    });

    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { available: false, ready: false, session: 'wayland', reason: 'wayland_screen_capture_portal_required' },
    });
    await expect(backend.execute({ action: 'start', output_path: outputFile, userConfirmed: true })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_REQUIRED' },
    });
  });

  it('keeps macOS screen recording truthful until the signed ScreenCaptureKit provider is delivered', async () => {
    const backend = new PosixMediaCapabilityBackend('screen_record', { platform: 'darwin', runtime: fakeRuntime(['ffmpeg']) });
    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: {
        available: false,
        ready: false,
        provider: 'screencapturekit',
        reason: 'macos_signed_screen_capture_provider_required',
      },
    });
  });
});
