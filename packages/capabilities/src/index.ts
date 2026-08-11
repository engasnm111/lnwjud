import type { Result } from '@lnwjud/domain';

export const capabilityToolNames = Object.freeze([
  'shell',
  'dom_cdp',
  'accessibility',
  'input_event',
  'vision',
  'window',
  'health',
] as const);

export type CapabilityToolName = (typeof capabilityToolNames)[number];

export interface CapabilityService {
  execute(tool: CapabilityToolName, input: unknown): Promise<Result<unknown>>;
}
