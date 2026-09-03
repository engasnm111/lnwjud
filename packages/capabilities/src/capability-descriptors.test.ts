import { describe, expect, it } from 'vitest';

import { capabilityDescriptors } from './capability-descriptors.js';
import { capabilityToolNames } from './index.js';

describe('capability descriptors', () => {
  it('describes every registered capability exactly once', () => {
    const descriptorNames = capabilityDescriptors.map((descriptor) => descriptor.name);

    expect(new Set(descriptorNames).size).toBe(descriptorNames.length);
    expect(new Set(descriptorNames)).toEqual(new Set(capabilityToolNames));
  });

  it('declares the safety contract for scoped WSL execution', () => {
    const descriptor = capabilityDescriptors.find((item) => item.name === 'wsl_exec');

    expect(descriptor).toMatchObject({
      availability: 'platform',
      platformPolicy: { platforms: ['win32'], sessions: ['any'] },
      permission: 'EXECUTE',
      supportsCancel: true,
      supportsDryRun: true,
      auditTarget: 'workspace',
    });
    expect(descriptor?.requirements).toContain('wsl.exe');
  });

  it('advertises desktop automation only where a truthful platform provider boundary exists', () => {
    for (const name of ['accessibility', 'input_event', 'vision', 'window'] as const) {
      const descriptor = capabilityDescriptors.find((item) => item.name === name);
      expect(descriptor).toMatchObject({
        availability: 'platform',
        platformPolicy: { platforms: ['win32', 'linux'], sessions: ['interactive-desktop'] },
      });
    }
    expect(capabilityDescriptors.find((item) => item.name === 'vision')).toMatchObject({
      supportsDryRun: true,
      auditTarget: 'display',
      requirements: ['platform capture/OCR provider'],
    });
  });

  it('advertises portable and macOS-backed common capabilities on their real platform sets', () => {
    expect(capabilityDescriptors.find((item) => item.name === 'system_info')).toMatchObject({
      availability: 'always',
      platformPolicy: { platforms: ['win32', 'darwin', 'linux'] },
    });
    for (const name of ['notification', 'file_dialog', 'clipboard', 'scheduler'] as const) {
      expect(capabilityDescriptors.find((item) => item.name === name)).toMatchObject({
        availability: 'platform',
        platformPolicy: { platforms: ['win32', 'darwin'] },
      });
    }
  });
});
