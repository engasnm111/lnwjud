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

  it('marks portable system information and host schedulers as platform-aware', () => {
    const byName = new Map(capabilityDescriptors.map((descriptor) => [descriptor.name, descriptor]));

    expect(byName.get('system_info')).toMatchObject({ availability: 'always', auditTarget: 'system' });
    expect(byName.get('system_info')?.requirements).toContain('Electron/OS metadata');
    expect(byName.get('scheduler')).toMatchObject({ availability: 'optional', auditTarget: 'scheduler' });
    expect(byName.get('scheduler')?.requirements).toContain('host task scheduler');
    expect(byName.get('shell')?.availability).toBe('always');
    expect(byName.get('dom_cdp')?.availability).toBe('optional');
  });

  it('keeps native capture/OCR truthful when a host provider is a prerequisite', () => {
    const descriptor = capabilityDescriptors.find((item) => item.name === 'vision');

    expect(descriptor).toMatchObject({
      supportsDryRun: true,
      auditTarget: 'display',
    });
    expect(descriptor?.requirements).toContain('host capture/OCR provider');
  });
});
