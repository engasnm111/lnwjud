export const ALLOW_AI_DELETE_SETTING_KEY = 'allow_ai_delete';
export const DESTRUCTIVE_AUTO_APPROVAL_SETTING_KEY = 'destructive_auto_approval_policy';
export const STDIO_PERMISSION_PROFILE_SETTING_KEY = 'stdio_permission_profile';
export const STDIO_STRICT_ROOTS_SETTING_KEY = 'stdio_strict_roots';
export const STDIO_ALLOWED_ROOTS_SETTING_KEY = 'stdio_allowed_roots';

export type StdioPermissionProfileName = 'safe' | 'balanced' | 'full' | 'custom';

export type DestructiveApprovalKey =
  | 'delete_file'
  | 'git_rm'
  | 'git_clean'
  | 'git_reset_restore'
  | 'shell_rm_unlink'
  | 'shell_rmdir'
  | 'shell_del_erase'
  | 'wsl_rm_unlink'
  | 'wsl_rmdir';

export interface DestructiveAutoApprovalPolicy {
  readonly protectCriticalFiles: boolean;
  readonly recoverableDelete: boolean;
  readonly approvals: Readonly<Record<DestructiveApprovalKey, boolean>>;
}

export const DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY: DestructiveAutoApprovalPolicy = Object.freeze({
  protectCriticalFiles: true,
  recoverableDelete: true,
  approvals: Object.freeze({
    delete_file: false,
    git_rm: false,
    git_clean: false,
    git_reset_restore: false,
    shell_rm_unlink: false,
    shell_rmdir: false,
    shell_del_erase: false,
    wsl_rm_unlink: false,
    wsl_rmdir: false,
  }),
});

const DESTRUCTIVE_APPROVAL_KEYS: readonly DestructiveApprovalKey[] = [
  'delete_file', 'git_rm', 'git_clean', 'git_reset_restore', 'shell_rm_unlink',
  'shell_rmdir', 'shell_del_erase', 'wsl_rm_unlink', 'wsl_rmdir',
];

export function parseDestructiveAutoApprovalPolicy(
  value: string | null | undefined,
  legacyAllowAiDelete = false,
): DestructiveAutoApprovalPolicy {
  let parsed: Record<string, unknown> | null = null;
  if (value !== null && value !== undefined && value.trim().length > 0) {
    try {
      const candidate: unknown = JSON.parse(value);
      if (isRecord(candidate)) parsed = candidate;
    } catch {
      parsed = null;
    }
  }
  const approvalsRaw = parsed !== null && isRecord(parsed.approvals) ? parsed.approvals : {};
  const approvals = Object.fromEntries(DESTRUCTIVE_APPROVAL_KEYS.map((key) => [
    key,
    booleanValue(approvalsRaw[key], key === 'delete_file' ? legacyAllowAiDelete : false),
  ])) as Record<DestructiveApprovalKey, boolean>;
  return {
    // These are invariants in v4.10+, not optional auto-approval preferences.
    protectCriticalFiles: true,
    recoverableDelete: true,
    approvals,
  };
}

export function serializeDestructiveAutoApprovalPolicy(value: DestructiveAutoApprovalPolicy): string {
  const normalized = parseDestructiveAutoApprovalPolicy(JSON.stringify(value));
  return JSON.stringify({
    protectCriticalFiles: normalized.protectCriticalFiles,
    recoverableDelete: normalized.recoverableDelete,
    approvals: Object.fromEntries(DESTRUCTIVE_APPROVAL_KEYS.map((key) => [key, normalized.approvals[key]])),
  });
}

export function isProtectedCriticalPath(inputPath: string): boolean {
  const normalized = inputPath.trim().replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  if (normalized.length === 0) return true;
  const parts = normalized.split('/').filter(Boolean);
  const basename = parts.at(-1) ?? normalized;
  if (parts.includes('.git') || parts.includes('.lnwjud-recovery') || parts.includes('.lnwjud-trash')) return true;
  if (basename === '.env' || (basename.startsWith('.env.') && !['.env.example', '.env.sample', '.env.template'].includes(basename))) return true;
  if (['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'pyproject.toml', 'poetry.lock', 'requirements.txt', 'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'composer.json', 'composer.lock'].includes(basename)) return true;
  if (['id_rsa', 'id_ed25519', 'credentials', 'credentials.json', 'secrets.json', 'service-account.json'].includes(basename)) return true;
  if (/\.(pem|key|p12|pfx|db|sqlite|sqlite3)$/i.test(basename)) return true;
  if (/^(credentials|secrets?|service-account)(\.|-|_)/i.test(basename)) return true;
  return false;
}

export function parseBooleanSetting(value: string | null | undefined, fallback = false): boolean {
  if (value === null || value === undefined || value.trim().length === 0) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function parseStdioPermissionProfile(value: string | null | undefined, fallback: StdioPermissionProfileName = 'full'): StdioPermissionProfileName {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'safe' || normalized === 'balanced' || normalized === 'full' || normalized === 'custom'
    ? normalized
    : fallback;
}

export function parseAllowedRoots(value: string | null | undefined): readonly string[] {
  if (value === null || value === undefined || value.trim().length === 0) return [];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const entry of value.split(/[;\r\n]+/)) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(trimmed);
  }
  return roots;
}

export function serializeAllowedRoots(roots: readonly string[]): string {
  return parseAllowedRoots(roots.join(';')).join(';');
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
