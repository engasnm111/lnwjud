export const APP_NAME = 'lnwjud';
export const APP_VERSION = '5.8.0';
export { engineeringCommandFingerprint, formatEngineeringCommand } from './engineering-command.js';
export { isUnrestricted, unrestrictedFromEnv, unrestrictedFromSetting, UNRESTRICTED_SETTING_KEY, type ProcessEnvLike } from './unrestricted.js';

export { resolveLnwjudDataPath, type DataPathEnvironment } from './data-path.js';
export {
  createPlatformProfile,
  currentPlatformProfile,
  type PlatformCapabilityDisposition,
  type PlatformProfile,
  type PlatformProfileInput,
  type PlatformSupportTier,
  type SupportedHostPlatform,
} from './platform-profile.js';
export { detectLinuxSessionProfile, type LinuxSessionProfile, type LinuxSessionProfileInput, type LinuxSessionType } from './linux-session-profile.js';
export { DEFAULT_DISPLAY_TIME_ZONE, formatDisplayDateTime, formatDisplayTimestampItem, formatOffsetIsoTimestamp, displayTimeZone, type DisplayDateTimeLocale, type DisplayDateTimeOptions } from './date-time-display.js';

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

export {
  SECRET_ENVELOPE_PREFIX,
  MAX_SECRET_ENVELOPE_BYTES,
  MAX_SECRET_PLAINTEXT_BYTES,
  assertSecretPlaintext,
  createExplicitKeySecretProtector,
  decodeSecretEnvelope,
  encodeSecretEnvelope,
  type SecretPurpose,
  type SecretProtector,
  type SecretProtectionStatus,
} from './secret-protection.js';

export { parseDelimitedList, type ParseDelimitedListOptions } from './text-list.js';
export { USER_SETTING_KEYS, DEFAULT_MCP_CALL_TIMEOUT_MS, DEFAULT_MCP_IDLE_TIMEOUT_MS, DEFAULT_PROCESS_TIMEOUT_MS, DEFAULT_MCP_POLL_WAIT_SECONDS, DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS, DEFAULT_CODEX_TOOLS_ENABLED, DEFAULT_ECC_ENABLED, DEFAULT_UPDATE_INTERVAL_MINUTES, DEFAULT_TUNNEL_MAX_AUTO_RESTARTS, DEFAULT_RECOVERY_RETENTION_DAYS, DEFAULT_CUSTOM_PERMISSION_SETTINGS, DEFAULT_ENGINEERING_HARNESS_SETTINGS, parseIntegerSetting, parseCloseBehavior, normalizeMcpAllowedHostname, parseMcpAllowedHostnames, serializeMcpAllowedHostnames, parsePathList, serializePathList, parseStringRecordSetting, serializeStringRecordSetting, parseCustomPermissionSettings, serializeCustomPermissionSettings, parseEngineeringHarnessSettings, serializeEngineeringHarnessSettings, parseEngineeringHarnessWorkspaceOverrides, serializeEngineeringHarnessWorkspaceOverrides, type CloseBehavior, type PermissionDecisionSetting, type CustomPermissionSettings, type EngineeringProfile, type EngineeringApplyTo, type EngineeringHarnessDiagnostic, type EngineeringHarnessSettings, type ParsedEngineeringHarnessSettings, type EngineeringHarnessWorkspaceOverride, type EngineeringHarnessWorkspaceOverrides } from './user-settings.js';
export { DEFAULT_PONYTAIL_MODE, parsePonytailMode, parsePonytailModeOverride, workspacePonytailMode, normalizeProjectProfile, resolvePonytailPolicy, type PonytailMode, type PonytailModeOverride, type PonytailPolicySource, type ResolvedPonytailPolicy } from './ponytail-policy.js';
export { projectEngineeringSettings, parseProjectEngineeringSettings, type ProjectEngineeringMode, type ProjectEngineeringProfile, type EngineeringCommandKind, type EngineeringRequiredPlatform, type ProjectEngineeringSettings } from './engineering-policy.js';
export { DEFAULT_TOOL_AVAILABILITY_SNAPSHOT, parseToolAvailabilitySnapshot, serializeToolAvailabilitySnapshot, toolUserPreference, resolveEffectiveToolAvailability, type ToolAvailabilitySnapshot, type ToolAvailabilityOverride, type ToolAvailabilityReason, type ToolUserPreference, type EffectiveToolAvailability } from './tool-availability.js';
