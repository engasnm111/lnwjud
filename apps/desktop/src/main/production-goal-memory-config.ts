/**
 * Explicit opt-in for Production Hindsight checkpoint writes.
 * Configuration is kept outside the selected project, in lnwjud user data.
 * This loader does not create banks, guess associations or write any files.
 * Each actual memory write remains gated by a native one-use Host prompt.
 */
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

export const UPM_PRODUCTION_CONFIG_FILE = 'upm-production-banks.v1.json';
const WORKSPACE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BANK_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MAX_CONFIG_BYTES = 16_384;

interface ProductionBankOptIn {
  readonly enabled: true;
  readonly authorizedBank: (workspaceId: string) => string | null;
}

/** Fail closed: missing/invalid opt-in means the checkpoint listener is OFF. */
export async function loadProductionGoalMemoryOptIn(dataPath: string): Promise<ProductionBankOptIn | undefined> {
  const file = path.join(dataPath, UPM_PRODUCTION_CONFIG_FILE);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_CONFIG_BYTES) return undefined;
    const candidate: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
    const config = candidate as Record<string, unknown>;
    if (config.schemaVersion !== 1 || config.enabled !== true) return undefined;
    if (!config.workspaceBanks || typeof config.workspaceBanks !== 'object' || Array.isArray(config.workspaceBanks)) return undefined;
    if (Object.keys(config).some((key) => !['schemaVersion', 'enabled', 'workspaceBanks'].includes(key))) return undefined;
    const entries = Object.entries(config.workspaceBanks);
    if (entries.length < 1 || entries.length > 100) return undefined;
    const banks = new Map<string, string>();
    for (const [workspaceId, value] of entries) {
      if (!WORKSPACE_UUID.test(workspaceId) || typeof value !== 'string' || !BANK_ID.test(value)) return undefined;
      if (banks.has(workspaceId.toLowerCase())) return undefined;
      banks.set(workspaceId.toLowerCase(), value);
    }
    return { enabled: true, authorizedBank: (workspaceId: string): string | null =>
      typeof workspaceId === 'string' ? (banks.get(workspaceId.toLowerCase()) ?? null) : null };
  } catch {
    // Never infer approval or map a project when the Host has no valid opt-in.
    return undefined;
  }
}
