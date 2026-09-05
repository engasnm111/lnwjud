import { afterEach, describe, expect, it } from 'vitest';
import { resolveRuntimeAssets, runtimeTargetKey } from '../scripts/runtime-asset-manifest.mjs';
import { resolveTunnelClientAsset, tunnelClientTargetKey } from '../scripts/tunnel-client-asset-manifest.mjs';

afterEach(() => {
  delete process.env.LNWJUD_PACKAGE_TARGET_PLATFORM;
  delete process.env.LNWJUD_PACKAGE_TARGET_ARCH;
});

describe('native packaging target selection', () => {
  it('allows a packaging orchestrator to prepare macOS arm64 assets on any macOS runner architecture', () => {
    process.env.LNWJUD_PACKAGE_TARGET_PLATFORM = 'darwin';
    process.env.LNWJUD_PACKAGE_TARGET_ARCH = 'arm64';

    expect(runtimeTargetKey()).toBe('darwin-arm64');
    expect(resolveRuntimeAssets().target).toBe('darwin-arm64');
    expect(tunnelClientTargetKey()).toBe('darwin-arm64');
    expect(resolveTunnelClientAsset().target).toBe('darwin-arm64');
  });

  it('switches the same preparation boundary to macOS x64 without relying on process.arch', () => {
    process.env.LNWJUD_PACKAGE_TARGET_PLATFORM = 'darwin';
    process.env.LNWJUD_PACKAGE_TARGET_ARCH = 'x64';

    expect(runtimeTargetKey()).toBe('darwin-x64');
    expect(resolveRuntimeAssets().target).toBe('darwin-x64');
    expect(tunnelClientTargetKey()).toBe('darwin-x64');
    expect(resolveTunnelClientAsset().target).toBe('darwin-x64');
  });

  it('selects the Tier-1 Linux x64 bundle explicitly for Linux packaging', () => {
    process.env.LNWJUD_PACKAGE_TARGET_PLATFORM = 'linux';
    process.env.LNWJUD_PACKAGE_TARGET_ARCH = 'x64';

    expect(resolveRuntimeAssets().target).toBe('linux-x64');
    expect(resolveTunnelClientAsset().target).toBe('linux-x64');
  });
});
