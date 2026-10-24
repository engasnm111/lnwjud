import { parseDelimitedList } from './text-list.js';

export const USER_SETTING_KEYS = Object.freeze({
  customPermissionProfile: 'custom_permission_profile',
  desktopFullBypassAll: 'desktop_full_bypass_all',
  stdioFullBypassAll: 'stdio_full_bypass_all',
  mcpCallTimeoutMs: 'mcp_call_timeout_ms',
  mcpIdleTimeoutMs: 'mcp_idle_timeout_ms',
  processTimeoutMs: 'process_timeout_ms',
  mcpPollWaitSeconds: 'mcp_poll_wait_seconds',
  shellSynchronousWaitSeconds: 'shell_synchronous_wait_seconds',
  capabilityRoots: 'capability_roots',
  pdfProviderPath: 'pdf_provider_path',
  lspCommands: 'lsp_commands',
  mcpHttpPort: 'mcp_http_port',
  mcpHttpPortAutoMigrationV1: 'mcp_http_port_auto_migration_v1',
  mcpAllowedHostnames: 'mcp_allowed_hostnames',
  codexToolsEnabled: 'codex_tools_enabled',
  eccEnabled: 'ecc_enabled',
  ponytailMode: 'ponytail_mode',
  toolAvailability: 'tool_availability_v1',
  updateAutoCheck: 'update_auto_check',
  updateCheckOnStartup: 'update_check_on_startup',
  updateIntervalMinutes: 'update_interval_minutes',
  updateAutoDownload: 'update_auto_download',
  updateSilentInstall: 'update_silent_install',
  closeBehavior: 'close_behavior',
  launchAtStartup: 'launch_at_startup',
  startMinimized: 'start_minimized',
  tunnelAutoReconnect: 'tunnel_auto_reconnect',
  tunnelMaxAutoRestarts: 'tunnel_max_auto_restarts',
  recoveryRetentionDays: 'recovery_retention_days',
  engineeringHarnessSettings: 'engineering_harness_settings_v1',
  engineeringHarnessWorkspaceOverrides: 'engineering_harness_workspace_overrides_v1',
});

export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_MCP_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_PROCESS_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_MCP_POLL_WAIT_SECONDS = 5;
export const DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS = 60;
export const MIN_CONFIGURABLE_WAIT_SECONDS = 5;
export const MAX_CONFIGURABLE_WAIT_SECONDS = 60;
export const DEFAULT_CODEX_TOOLS_ENABLED = false;
export const DEFAULT_ECC_ENABLED = false;
export const DEFAULT_UPDATE_INTERVAL_MINUTES = 30;
export const DEFAULT_TUNNEL_MAX_AUTO_RESTARTS = 5;
export const DEFAULT_RECOVERY_RETENTION_DAYS = 30;

export type CloseBehavior = 'tray' | 'quit';
export type PermissionDecisionSetting = 'ALLOW' | 'ASK' | 'DENY';
export type EngineeringProfile = 'standard' | 'senior' | 'strict' | 'custom';
export type EngineeringApplyTo = 'coding_projects' | 'all_workspaces';
export type EngineeringHarnessDiagnostic = 'invalid_json' | 'invalid_shape' | 'unsupported_schema_version';

export interface EngineeringHarnessSettings {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly profile: EngineeringProfile;
  readonly applyTo: EngineeringApplyTo;
  readonly autoProjectAssessment: boolean;
  readonly hostedCi?: 'required' | 'local_only';
  readonly allowNoGit?: boolean;
  readonly workerTarget?: { readonly accountId: string; readonly worker: string; readonly environment: string; readonly trafficPercent: number };
  readonly custom?: {
    readonly analysis: 'focused' | 'cross_file';
    readonly review: 'risk_based' | 'always';
    readonly validation: 'risk_based' | 'strict';
    readonly docsImpactCheck: boolean;
  };
}

export interface ParsedEngineeringHarnessSettings {
  readonly settings: EngineeringHarnessSettings;
  readonly diagnostic: EngineeringHarnessDiagnostic | null;
}

export interface EngineeringHarnessWorkspaceOverride {
  readonly mode: 'on' | 'off';
  readonly profile?: EngineeringProfile;
}

export type EngineeringHarnessWorkspaceOverrides = Readonly<Record<string, EngineeringHarnessWorkspaceOverride>>;

export const DEFAULT_ENGINEERING_HARNESS_SETTINGS: EngineeringHarnessSettings = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  profile: 'senior',
  applyTo: 'coding_projects',
  autoProjectAssessment: true,
});

export interface CustomPermissionSettings {
  readonly read: PermissionDecisionSetting;
  readonly write: PermissionDecisionSetting;
  readonly execute: PermissionDecisionSetting;
  readonly dangerous: PermissionDecisionSetting;
  readonly allowedExecutables: readonly string[];
}

export const DEFAULT_CUSTOM_PERMISSION_SETTINGS: CustomPermissionSettings = Object.freeze({
  read: 'ALLOW',
  write: 'ASK',
  execute: 'ASK',
  dangerous: 'DENY',
  allowedExecutables: Object.freeze([]),
});

export function parseIntegerSetting(value: string | null | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

export function parseCloseBehavior(value: string | null | undefined): CloseBehavior {
  return value === 'quit' ? 'quit' : 'tray';
}

export function parsePathList(value: string | null | undefined): readonly string[] {
  return parseDelimitedList(value, { caseInsensitive: true });
}

export function serializePathList(values: readonly string[]): string {
  return parsePathList(values.join(';')).join(';');
}

export function normalizeMcpAllowedHostname(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.includes('*') || trimmed.includes('/') || trimmed.includes('?') || trimmed.includes('#') || trimmed.includes('@')) return null;
  try {
    const url = new URL(`http://${trimmed}`);
    if (url.username.length > 0 || url.password.length > 0 || url.port.length > 0 || url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function parseMcpAllowedHostnames(value: string | null | undefined): readonly string[] {
  return [...new Set(parseDelimitedList(value, { caseInsensitive: true })
    .map(normalizeMcpAllowedHostname)
    .filter((hostname): hostname is string => hostname !== null))];
}

export function serializeMcpAllowedHostnames(values: readonly string[]): string {
  return parseMcpAllowedHostnames(values.join(';')).join(';');
}

export function parseStringRecordSetting(value: string | null | undefined): Readonly<Record<string, string>> {
  if (value === null || value === undefined || value.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].trim().length > 0 && entry[1].trim().length > 0)
      .map(([key, entry]) => [key.trim().toLowerCase(), entry.trim()]));
  } catch {
    return {};
  }
}

export function serializeStringRecordSetting(value: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => key.trim().length > 0 && entry.trim().length > 0)
    .map(([key, entry]) => [key.trim().toLowerCase(), entry.trim()])));
}

export function parseCustomPermissionSettings(value: string | null | undefined): CustomPermissionSettings {
  if (value === null || value === undefined || value.trim().length === 0) return DEFAULT_CUSTOM_PERMISSION_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return DEFAULT_CUSTOM_PERMISSION_SETTINGS;
    return {
      read: parseDecision(parsed.read, DEFAULT_CUSTOM_PERMISSION_SETTINGS.read),
      write: parseDecision(parsed.write, DEFAULT_CUSTOM_PERMISSION_SETTINGS.write),
      execute: parseDecision(parsed.execute, DEFAULT_CUSTOM_PERMISSION_SETTINGS.execute),
      dangerous: parseDecision(parsed.dangerous, DEFAULT_CUSTOM_PERMISSION_SETTINGS.dangerous),
      allowedExecutables: Array.isArray(parsed.allowedExecutables)
        ? [...new Set(parsed.allowedExecutables.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()))]
        : DEFAULT_CUSTOM_PERMISSION_SETTINGS.allowedExecutables,
    };
  } catch {
    return DEFAULT_CUSTOM_PERMISSION_SETTINGS;
  }
}

export function serializeCustomPermissionSettings(value: CustomPermissionSettings): string {
  return JSON.stringify({
    read: parseDecision(value.read, 'ALLOW'),
    write: parseDecision(value.write, 'ASK'),
    execute: parseDecision(value.execute, 'ASK'),
    dangerous: parseDecision(value.dangerous, 'DENY'),
    allowedExecutables: [...new Set(value.allowedExecutables.map((entry) => entry.trim()).filter((entry) => entry.length > 0))],
  });
}

const MAX_ENGINEERING_HARNESS_SETTING_BYTES = 16 * 1024;

export function parseEngineeringHarnessSettings(value: string | null | undefined): ParsedEngineeringHarnessSettings {
  if (value === null || value === undefined || value.trim().length === 0) {
    return { settings: DEFAULT_ENGINEERING_HARNESS_SETTINGS, diagnostic: null };
  }
  if (new TextEncoder().encode(value).byteLength > MAX_ENGINEERING_HARNESS_SETTING_BYTES) {
    return { settings: DEFAULT_ENGINEERING_HARNESS_SETTINGS, diagnostic: 'invalid_shape' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return { settings: DEFAULT_ENGINEERING_HARNESS_SETTINGS, diagnostic: 'invalid_json' };
  }
  if (!isRecord(parsed)) return { settings: DEFAULT_ENGINEERING_HARNESS_SETTINGS, diagnostic: 'invalid_shape' };
  if (parsed.schemaVersion !== 1) return { settings: DEFAULT_ENGINEERING_HARNESS_SETTINGS, diagnostic: 'unsupported_schema_version' };
  if (typeof parsed.enabled !== 'boolean'
    || !isEngineeringProfile(parsed.profile)
    || !isEngineeringApplyTo(parsed.applyTo)
    || typeof parsed.autoProjectAssessment !== 'boolean'
    || !hasOnlyKeys(parsed, ['schemaVersion', 'enabled', 'profile', 'applyTo', 'autoProjectAssessment', 'custom', 'hostedCi', 'allowNoGit', 'workerTarget'])) {
    return { settings: DEFAULT_ENGINEERING_HARNESS_SETTINGS, diagnostic: 'invalid_shape' };
  }
  if ((parsed.hostedCi !== undefined && parsed.hostedCi !== 'required' && parsed.hostedCi !== 'local_only') || (parsed.allowNoGit !== undefined && typeof parsed.allowNoGit !== 'boolean')) return { settings: DEFAULT_ENGINEERING_HARNESS_SETTINGS, diagnostic: 'invalid_shape' };
  if (parsed.workerTarget !== undefined && !isEngineeringWorkerTarget(parsed.workerTarget)) return { settings: DEFAULT_ENGINEERING_HARNESS_SETTINGS, diagnostic: 'invalid_shape' };
  const custom = parsed.custom === undefined ? undefined : parseEngineeringCustomSettings(parsed.custom);
  if (custom === null) {
    return { settings: DEFAULT_ENGINEERING_HARNESS_SETTINGS, diagnostic: 'invalid_shape' };
  }
  return {
    settings: {
      schemaVersion: 1,
      enabled: parsed.enabled,
      profile: parsed.profile,
      applyTo: parsed.applyTo,
      autoProjectAssessment: parsed.autoProjectAssessment,
      ...(parsed.hostedCi === undefined ? {} : { hostedCi: parsed.hostedCi }),
      ...(parsed.allowNoGit === undefined ? {} : { allowNoGit: parsed.allowNoGit }),
      ...(parsed.workerTarget === undefined || !isEngineeringWorkerTarget(parsed.workerTarget) ? {} : { workerTarget: parsed.workerTarget }),
      ...(custom === undefined ? {} : { custom }),
    },
    diagnostic: null,
  };
}

export function serializeEngineeringHarnessSettings(value: EngineeringHarnessSettings): string {
  return JSON.stringify({
    schemaVersion: 1,
    enabled: value.enabled === true,
    profile: isEngineeringProfile(value.profile) ? value.profile : DEFAULT_ENGINEERING_HARNESS_SETTINGS.profile,
    applyTo: isEngineeringApplyTo(value.applyTo) ? value.applyTo : DEFAULT_ENGINEERING_HARNESS_SETTINGS.applyTo,
    autoProjectAssessment: value.autoProjectAssessment === true,
    ...(value.hostedCi === undefined ? {} : { hostedCi: value.hostedCi }),
    ...(value.allowNoGit === undefined ? {} : { allowNoGit: value.allowNoGit }),
    ...(value.workerTarget === undefined ? {} : { workerTarget: value.workerTarget }),
    ...(value.custom === undefined ? {} : { custom: value.custom }),
  });
}

export function parseEngineeringHarnessWorkspaceOverrides(value: string | null | undefined): EngineeringHarnessWorkspaceOverrides {
  if (value === null || value === undefined || value.trim().length === 0) return {};
  if (new TextEncoder().encode(value).byteLength > 64 * 1024) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { return {}; }
  if (!isRecord(parsed) || Object.keys(parsed).length > 256) return {};
  const result: Record<string, EngineeringHarnessWorkspaceOverride> = {};
  for (const [workspaceId, entry] of Object.entries(parsed)) {
    if (workspaceId.trim().length === 0 || workspaceId.length > 128 || !isRecord(entry)) return {};
    if (!hasOnlyKeys(entry, ['mode', 'profile']) || (entry.mode !== 'on' && entry.mode !== 'off')) return {};
    if (entry.profile !== undefined && !isEngineeringProfile(entry.profile)) return {};
    result[workspaceId] = {
      mode: entry.mode,
      ...(entry.profile === undefined ? {} : { profile: entry.profile }),
    };
  }
  return result;
}

export function serializeEngineeringHarnessWorkspaceOverrides(value: EngineeringHarnessWorkspaceOverrides): string {
  const entries = Object.entries(value)
    .filter(([workspaceId, entry]) => workspaceId.trim().length > 0 && workspaceId.length <= 128 && (entry.mode === 'on' || entry.mode === 'off'))
    .slice(0, 256)
    .map(([workspaceId, entry]) => [workspaceId, {
      mode: entry.mode,
      ...(entry.profile === undefined || !isEngineeringProfile(entry.profile) ? {} : { profile: entry.profile }),
    }]);
  return JSON.stringify(Object.fromEntries(entries));
}

function parseEngineeringCustomSettings(value: unknown): EngineeringHarnessSettings['custom'] | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['analysis', 'review', 'validation', 'docsImpactCheck'])) return null;
  if ((value.analysis !== 'focused' && value.analysis !== 'cross_file')
    || (value.review !== 'risk_based' && value.review !== 'always')
    || (value.validation !== 'risk_based' && value.validation !== 'strict')
    || typeof value.docsImpactCheck !== 'boolean') return null;
  return {
    analysis: value.analysis,
    review: value.review,
    validation: value.validation,
    docsImpactCheck: value.docsImpactCheck,
  };
}

function isEngineeringProfile(value: unknown): value is EngineeringProfile {
  return value === 'standard' || value === 'senior' || value === 'strict' || value === 'custom';
}

function isEngineeringApplyTo(value: unknown): value is EngineeringApplyTo {
  return value === 'coding_projects' || value === 'all_workspaces';
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseDecision(value: unknown, fallback: PermissionDecisionSetting): PermissionDecisionSetting {
  return value === 'ALLOW' || value === 'ASK' || value === 'DENY' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isEngineeringWorkerTarget(value: unknown): value is NonNullable<EngineeringHarnessSettings['workerTarget']> {
  return isRecord(value) && hasOnlyKeys(value, ['accountId', 'worker', 'environment', 'trafficPercent'])
    && typeof value.accountId === 'string' && /^[a-f0-9]{32}$/i.test(value.accountId)
    && typeof value.worker === 'string' && /^[a-zA-Z0-9_-]{1,63}$/.test(value.worker)
    && typeof value.environment === 'string' && /^[a-zA-Z0-9_-]{1,63}$/.test(value.environment)
    && typeof value.trafficPercent === 'number' && Number.isFinite(value.trafficPercent) && value.trafficPercent > 0 && value.trafficPercent <= 100;
}
