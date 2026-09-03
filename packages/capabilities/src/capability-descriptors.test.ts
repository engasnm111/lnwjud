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

  it('keeps native OCR truthful when package identity is a prerequisite', () => {
    const descriptor = capabilityDescriptors.find((item) => item.name === 'vision');

    expect(descriptor).toMatchObject({
      availability: 'platform',
      platformPolicy: { platforms: ['win32'], sessions: ['interactive-desktop'] },
      supportsDryRun: true,
      auditTarget: 'display',
    });
    expect(descriptor?.requirements).toContain('Windows package identity for WinRT OCR');
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
