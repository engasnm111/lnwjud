import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { createPlatformProfile, currentPlatformProfile } from './platform-profile.js';

describe('platform profile', () => {
  it('classifies the supported Windows release targets and preserves Windows-only providers', () => {
    expect(createPlatformProfile({ platform: 'win32', arch: 'x64', release: '10.0.19045' })).toMatchObject({
      family: 'windows',
      supportTier: 'supported',
      capabilities: {
        shell: 'native',
        scheduler: 'native',
        'tunnel-client': 'native',
        windows_sandbox: 'native',
      },
    });
    expect(createPlatformProfile({ platform: 'win32', arch: 'x64', release: '10.0.22631' })).toMatchObject({
      family: 'windows',
      supportTier: 'supported',
    });
  });

  it('classifies macOS arm64/x64 as supported targets without Windows-only providers', () => {
    for (const arch of ['arm64', 'x64']) {
      expect(createPlatformProfile({ platform: 'darwin', arch, release: '23.6.0' })).toMatchObject({
        family: 'macos',
        supportTier: 'supported',
        capabilities: {
          shell: 'native',
          screen_record: 'dependency_gated',
          'tunnel-client': 'dependency_gated',
          wsl_exec: 'unsupported',
          windows_sandbox: 'unsupported',
          sandbox_exec: 'unsupported',
        },
      });
    }
  });

  it('classifies Linux x64 as supported and Linux arm64 as preview', () => {
    expect(createPlatformProfile({ platform: 'linux', arch: 'x64', release: '6.8.0' })).toMatchObject({
      family: 'linux',
      supportTier: 'supported',
      capabilities: {
        shell: 'native',
        screen_record: 'dependency_gated',
        'tunnel-client': 'dependency_gated',
        wsl_fs: 'unsupported',
        sandbox_exec: 'unsupported',
      },
    });
    expect(createPlatformProfile({ platform: 'linux', arch: 'arm64', release: '6.8.0' })).toMatchObject({
      family: 'linux',
      supportTier: 'preview',
    });
  });

  it('fails closed for unsupported hosts and architectures', () => {
    expect(createPlatformProfile({ platform: 'freebsd', arch: 'x64', release: '14.0' })).toMatchObject({
      family: 'unsupported',
      supportTier: 'unsupported',
      capabilities: {
        shell: 'unsupported',
        'tunnel-client': 'unsupported',
      },
    });
    expect(createPlatformProfile({ platform: 'darwin', arch: 'ia32', release: '23.6.0' })).toMatchObject({
      family: 'unsupported',
      supportTier: 'unsupported',
    });
  });

  it('uses the host kernel release when resolving the current profile', () => {
    expect(currentPlatformProfile()).toMatchObject({
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
    });
  });
});
