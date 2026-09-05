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
      availability: 'windows',
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
      supportsDryRun: true,
      auditTarget: 'display',
    });
    expect(descriptor?.requirements).toContain('Windows package identity for WinRT OCR');
  });
});
