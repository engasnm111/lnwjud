import { describe, expect, it } from 'vitest';
import { createPlatformContext, platformSupportTier } from './platform-context.js';

const matrix = [
  ['win32', 'x64', 'windows', 'ga'],
  ['win32', 'arm64', 'windows', 'unsupported'],
  ['darwin', 'x64', 'macos', 'ga'],
  ['darwin', 'arm64', 'macos', 'ga'],
  ['linux', 'x64', 'linux', 'ga'],
  ['linux', 'arm64', 'linux', 'preview'],
  ['freebsd', 'x64', 'unsupported', 'unsupported'],
] as const;

describe('createPlatformContext', () => {
  for (const [platform, arch, family, supportTier] of matrix) {
    it(`${platform}-${arch} => ${supportTier}`, () => {
      const context = createPlatformContext({ platform, arch, release: 'test' });
      expect(context.family).toBe(family);
      expect(context.supportTier).toBe(supportTier);
      expect(context.targetTriple).toBe(`${platform}-${arch}`);
    });
  }

  it('keeps unknown architectures fail-closed', () => {
    expect(platformSupportTier('linux', 'ia32')).toBe('unsupported');
  });
});
