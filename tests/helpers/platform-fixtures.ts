import type { PlatformProfileInput } from '../../packages/shared/src/platform-profile.js';

export interface PlatformFixture {
  readonly name: string;
  readonly input: PlatformProfileInput;
  readonly expectedFamily: 'windows' | 'macos' | 'linux' | 'unsupported';
  readonly expectedTier: 'supported' | 'preview' | 'unsupported';
}

export const PLATFORM_FIXTURES: readonly PlatformFixture[] = Object.freeze([
  {
    name: 'windows-10-x64',
    input: { platform: 'win32', arch: 'x64', release: '10.0.19045' },
    expectedFamily: 'windows',
    expectedTier: 'supported',
  },
  {
    name: 'windows-11-x64',
    input: { platform: 'win32', arch: 'x64', release: '10.0.22631' },
    expectedFamily: 'windows',
    expectedTier: 'supported',
  },
  {
    name: 'macos-13-arm64',
    input: { platform: 'darwin', arch: 'arm64', release: '22.6.0' },
    expectedFamily: 'macos',
    expectedTier: 'supported',
  },
  {
    name: 'macos-13-x64',
    input: { platform: 'darwin', arch: 'x64', release: '22.6.0' },
    expectedFamily: 'macos',
    expectedTier: 'supported',
  },
  {
    name: 'linux-ubuntu-24-x64',
    input: { platform: 'linux', arch: 'x64', release: '6.8.0' },
    expectedFamily: 'linux',
    expectedTier: 'supported',
  },
  {
    name: 'linux-arm64-preview',
    input: { platform: 'linux', arch: 'arm64', release: '6.8.0' },
    expectedFamily: 'linux',
    expectedTier: 'preview',
  },
  {
    name: 'unsupported-host',
    input: { platform: 'freebsd', arch: 'x64', release: '14.0.0' },
    expectedFamily: 'unsupported',
    expectedTier: 'unsupported',
  },
]);
