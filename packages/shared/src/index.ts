export const APP_NAME = 'lnwjud';
export const APP_VERSION = '4.31.0';
export { isUnrestricted, unrestrictedFromEnv, unrestrictedFromSetting, UNRESTRICTED_SETTING_KEY, type ProcessEnvLike } from './unrestricted.js';

export { resolveLnwjudDataPath, type DataPathEnvironment } from './data-path.js';

export {
  ALLOW_AI_DELETE_SETTING_KEY,
  DESTRUCTIVE_AUTO_APPROVAL_SETTING_KEY,
  DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY,
  STDIO_PERMISSION_PROFILE_SETTING_KEY,
  STDIO_STRICT_ROOTS_SETTING_KEY,
  STDIO_ALLOWED_ROOTS_SETTING_KEY,
  isProtectedCriticalPath,
  parseAllowedRoots,
  parseBooleanSetting,
  parseDestructiveAutoApprovalPolicy,
  parseStdioPermissionProfile,
  serializeAllowedRoots,
  serializeDestructiveAutoApprovalPolicy,
  type DestructiveApprovalKey,
  type DestructiveAutoApprovalPolicy,
  type StdioPermissionProfileName,
} from './agent-policy.js';

export { prohibitedAgentCommandReason, riskyAgentCommandReason } from './agent-command-policy.js';
export { isProvablyReadOnlyGitInvocation, prohibitedAgentGitInvocationReason } from './git-mutation-policy.js';

export { protectWithWindowsDpapi, unprotectWithWindowsDpapi, loadOrCreateWindowsProtectedKey, loadCheckpointEncryptionKey } from './windows-dpapi.js';

export { USER_SETTING_KEYS, DEFAULT_MCP_CALL_TIMEOUT_MS, DEFAULT_MCP_IDLE_TIMEOUT_MS, DEFAULT_PROCESS_TIMEOUT_MS, DEFAULT_MCP_POLL_WAIT_SECONDS, DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS, DEFAULT_CODEX_TOOLS_ENABLED, DEFAULT_UPDATE_INTERVAL_MINUTES, DEFAULT_TUNNEL_MAX_AUTO_RESTARTS, DEFAULT_RECOVERY_RETENTION_DAYS, DEFAULT_CUSTOM_PERMISSION_SETTINGS, parseIntegerSetting, parseCloseBehavior, parsePathList, serializePathList, parseStringRecordSetting, serializeStringRecordSetting, parseCustomPermissionSettings, serializeCustomPermissionSettings, type CloseBehavior, type PermissionDecisionSetting, type CustomPermissionSettings } from './user-settings.js';
