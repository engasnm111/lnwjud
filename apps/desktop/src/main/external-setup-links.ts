import {
  EXTERNAL_SETUP_URLS,
  type ExternalSetupTarget,
  type OpenExternalSetupPageRequest,
} from '@lnwjud/ipc-contracts';

const externalSetupTargets = new Set<ExternalSetupTarget>([
  'openai_tunnels',
  'openai_api_keys',
  'chatgpt_plugins',
]);

export function parseOpenExternalSetupPageRequest(payload: unknown): OpenExternalSetupPageRequest {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Invalid IPC payload: target');
  }
  const target = (payload as Record<string, unknown>).target;
  if (!externalSetupTargets.has(target as ExternalSetupTarget)) {
    throw new Error('Invalid IPC payload: target');
  }
  return { target: target as ExternalSetupTarget };
}

export function resolveExternalSetupUrl(target: ExternalSetupTarget): string {
  if (!externalSetupTargets.has(target)) throw new Error('Invalid IPC payload: target');
  return EXTERNAL_SETUP_URLS[target];
}
