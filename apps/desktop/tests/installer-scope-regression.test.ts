import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const builderConfig = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');

describe('Windows installer scope regression', () => {
  it('keeps the historical per-user install mode selected by default', () => {
    expect(builderConfig).toContain('oneClick: false');
    expect(builderConfig).toContain('perMachine: false');
    expect(builderConfig).toContain('selectPerMachineByDefault: false');
    expect(builderConfig).not.toContain('selectPerMachineByDefault: true');
  });
});
