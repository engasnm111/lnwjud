import { contextBridge, ipcRenderer } from 'electron';
import {
  ipcChannels,
  pushChannels,
  type AddWorkspaceRequest,
  type AgentState,
  type BackupSummary,
  type ClearLogBufferRequest,
  type ClearWorkLogRequest,
  type ConfigureTunnelProfileRequest,
  type DeleteWorkspaceRequest,
  type DashboardSnapshot,
  type DestructiveDeletePolicy,
  type DoctorCheck,
  type DoctorReport,
  type ToolCatalogSnapshot,
  type ToolCatalogItem,
  type RequirementResult,
  type ResolvedRemediation,
  type GetToolCatalogRequest,
  type RecheckToolCatalogRequest,
  type OpenToolSetupTargetRequest,
  type CopyToolCommandRequest,
  type ExportLogsRequest,
  type ExportWorkLogRequest,
  type IncidentExportResult,
  type InFlightWorkItem,
  type LnwjudApi,
  type LogLine,
  type OpenExternalSetupPageRequest,
  type LogSnapshot,
  type ManagedBrowserStatus,
  type PdfProviderInstallResult,
  type McpConnectionStatus,
  type PermissionProfileName,
  type ProcessSummary,
  type RestoreCheckpointRequest,
  type RestoreRecoveryItemRequest,
  type SaveTunnelApiKeyRequest,
  type ScheduleRestoreBackupRequest,
  type SelectWorkspaceRequest,
  type SetWorkspaceActiveRequest,
  type SetWorkspaceArchivedRequest,
  type SetAiDeletePolicyRequest,
  type SetLocaleRequest,
  type SetPermissionProfileRequest,
  type SetStdioPolicyRequest,
  type SetTunnelClientPathRequest,
  type SetUnrestrictedModeRequest,
  type SetUserSettingsRequest,
  type StartMcpRequest,
  type StartProcessRequest,
  type StopProcessRequest,
  type TunnelStatus,
  type UiLocale,
  type UpdateStatus,
  type UserSettings,
  type WorkLogEntry,
  type WorkspaceSummary,
} from '@lnwjud/ipc-contracts';
import { parseLogCorrelation } from './log-parser.js';

function invoke(channel: string, payload?: unknown): Promise<unknown> {
  return payload === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, field: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== 'string') throw new Error('Invalid IPC response');
  return fieldValue;
}

function booleanField(value: Record<string, unknown>, field: string): boolean {
  const fieldValue = value[field];
  if (typeof fieldValue !== 'boolean') throw new Error('Invalid IPC response');
  return fieldValue;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const fieldValue = value[field];
  if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) throw new Error('Invalid IPC response');
  return fieldValue;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new Error('Invalid IPC response');
}

function workspaceSummary(value: unknown): WorkspaceSummary {
  if (!isRecord(value)) throw new Error('Invalid IPC response');
  const archivedAt = value.archivedAt === undefined ? undefined : nullableString(value.archivedAt);
  const kind = value.kind;
  if (kind !== undefined && kind !== 'project' && kind !== 'machine_root') throw new Error('Invalid IPC response');
  return {
    id: stringField(value, 'id'),
    displayName: stringField(value, 'displayName'),
    rootPath: stringField(value, 'rootPath'),
    realRootPath: stringField(value, 'realRootPath'),
    createdAt: stringField(value, 'createdAt'),
    ...(archivedAt === undefined ? {} : { archivedAt }),
    ...(kind === undefined ? {} : { kind }),
  };
}

function workspaceList(value: unknown): readonly WorkspaceSummary[] {
  if (!Array.isArray(value)) throw new Error('Invalid IPC response');
  return value.map(workspaceSummary);
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error('Invalid IPC response');
  return value as string[];
}

function permissionProfile(value: unknown): PermissionProfileName {
  if (value === 'safe' || value === 'balanced' || value === 'full' || value === 'custom') return value;
  throw new Error('Invalid IPC response');
}

function agentState(value: unknown): AgentState {
  if (value === 'stopped' || value === 'idle' || value === 'busy') return value;
  throw new Error('Invalid IPC response');
}

function uiLocale(value: unknown): UiLocale {
  if (value === 'th' || value === 'en') return value;
  throw new Error('Invalid IPC response');
}

function workLogEntries(value: unknown): readonly WorkLogEntry[] {
  if (!Array.isArray(value)) throw new Error('Invalid IPC response');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid IPC response');
    const kind = entry.kind;
    if (kind !== 'task' && kind !== 'result' && kind !== 'error') throw new Error('Invalid IPC response');
    return {
      id: stringField(entry, 'id'),
      timestamp: stringField(entry, 'timestamp'),
      kind,
      toolName: stringField(entry, 'toolName'),
      resultCode: stringField(entry, 'resultCode'),
      errorMessage: nullableString(entry.errorMessage),
      targetSummary: nullableString(entry.targetSummary),
      durationMs: numberField(entry, 'durationMs'),
      workspaceId: nullableString(entry.workspaceId),
      sessionId: nullableString(entry.sessionId),
    };
  });
}

function inFlightItems(value: unknown): readonly InFlightWorkItem[] {
  if (!Array.isArray(value)) throw new Error('Invalid IPC response');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid IPC response');
    return {
      callId: stringField(entry, 'callId'),
      toolName: stringField(entry, 'toolName'),
      startedAt: stringField(entry, 'startedAt'),
      targetSummary: nullableString(entry.targetSummary),
      workspaceId: nullableString(entry.workspaceId),
      sessionId: nullableString(entry.sessionId),
    };
  });
}

function tunnelPersistentStatus(value: unknown): TunnelStatus['persistent'] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error('Invalid IPC response');
  const state = value.state;
  const mode = value.mode;
  if (state !== 'stopped' && state !== 'starting' && state !== 'running' && state !== 'reconnecting' && state !== 'error' && state !== 'auth-required') throw new Error('Invalid IPC response');
  if (mode !== 'native-managed' && mode !== 'profile-child' && mode !== 'external') throw new Error('Invalid IPC response');
  const nullableBoolean = (entry: unknown): boolean | null => {
    if (entry === null) return null;
    if (typeof entry === 'boolean') return entry;
    throw new Error('Invalid IPC response');
  };
  return {
    enabled: booleanField(value, 'enabled'),
    tunnelIdMasked: nullableString(value.tunnelIdMasked),
    runtimeAlias: stringField(value, 'runtimeAlias'),
    mode,
    state,
    healthy: nullableBoolean(value.healthy),
    ready: nullableBoolean(value.ready),
    pollHealthy: nullableBoolean(value.pollHealthy),
    reconnectCount: integerField(value, 'reconnectCount'),
    lastConnectedAt: nullableString(value.lastConnectedAt),
    lastReconnectAt: nullableString(value.lastReconnectAt),
    nextReconnectAt: nullableString(value.nextReconnectAt),
    lastErrorCode: nullableString(value.lastErrorCode),
    clientVersion: nullableString(value.clientVersion),
    localMcpUrl: nullableString(value.localMcpUrl),
    uiUrl: nullableString(value.uiUrl),
    readyBeforeRetire: booleanField(value, 'readyBeforeRetire'),
    strictZeroDowntime: booleanField(value, 'strictZeroDowntime'),
    capabilityEvidence: nullableString(value.capabilityEvidence),
  };
}

function tunnelStatus(value: unknown): TunnelStatus {
  if (!isRecord(value)) throw new Error('Invalid IPC response');
  const state = value.state;
  const source = value.source;
  if (state !== 'stopped' && state !== 'starting' && state !== 'running' && state !== 'error') {
    throw new Error('Invalid IPC response');
  }
  if (source !== 'desktop' && source !== 'external') throw new Error('Invalid IPC response');
  return {
    state,
    source,
    hasApiKey: booleanField(value, 'hasApiKey'),
    clientPath: nullableString(value.clientPath),
    profileExists: booleanField(value, 'profileExists'),
    message: nullableString(value.message),
    logPath: nullableString(value.logPath),
    persistent: tunnelPersistentStatus(value.persistent),
  };
}

function userSettings(value: unknown): UserSettings {
  if (!isRecord(value) || !isRecord(value.customPermission) || !isRecord(value.extensions)) throw new Error('Invalid IPC response');
  const custom = value.customPermission;
  const extensions = value.extensions;
  const closeBehavior = value.closeBehavior;
  const mode = extensions.mode;
  if (closeBehavior !== 'tray' && closeBehavior !== 'quit') throw new Error('Invalid IPC response');
  if (mode !== 'enable_all' && mode !== 'allowlist') throw new Error('Invalid IPC response');
  const read = permissionDecisionResponse(custom.read);
  const write = permissionDecisionResponse(custom.write);
  const execute = permissionDecisionResponse(custom.execute);
  const dangerous = permissionDecisionResponse(custom.dangerous);
  if (!Array.isArray(extensions.extraMcpServers)) throw new Error('Invalid IPC response');
  return {
    customPermission: { read, write, execute, dangerous, allowedExecutables: stringList(custom.allowedExecutables) },
    desktopFullBypassAll: booleanField(value, 'desktopFullBypassAll'),
    stdioFullBypassAll: booleanField(value, 'stdioFullBypassAll'),
    mcpCallTimeoutMs: integerField(value, 'mcpCallTimeoutMs'),
    mcpIdleTimeoutMs: integerField(value, 'mcpIdleTimeoutMs'),
    processTimeoutMs: integerField(value, 'processTimeoutMs'),
    mcpPollWaitSeconds: integerField(value, 'mcpPollWaitSeconds'),
    shellSynchronousWaitSeconds: integerField(value, 'shellSynchronousWaitSeconds'),
    capabilityRoots: stringList(value.capabilityRoots),
    pdfProviderPath: stringField(value, 'pdfProviderPath'),
    lspCommands: stringRecordResponse(value.lspCommands),
    mcpHttpPort: integerField(value, 'mcpHttpPort'),
    codexToolsEnabled: booleanField(value, 'codexToolsEnabled'),
    updateAutoCheck: booleanField(value, 'updateAutoCheck'),
    updateCheckOnStartup: booleanField(value, 'updateCheckOnStartup'),
    updateIntervalMinutes: integerField(value, 'updateIntervalMinutes'),
    updateAutoDownload: booleanField(value, 'updateAutoDownload'),
    closeBehavior,
    launchAtStartup: booleanField(value, 'launchAtStartup'),
    startMinimized: booleanField(value, 'startMinimized'),
    tunnelAutoReconnect: booleanField(value, 'tunnelAutoReconnect'),
    tunnelMaxAutoRestarts: integerField(value, 'tunnelMaxAutoRestarts'),
    recoveryRetentionDays: integerField(value, 'recoveryRetentionDays'),
    extensions: {
      mode,
      disabledServers: stringList(extensions.disabledServers),
      enabledServers: stringList(extensions.enabledServers),
      disabledSkillRoots: stringList(extensions.disabledSkillRoots),
      extraSkillRoots: stringList(extensions.extraSkillRoots),
      extraMcpServers: extensions.extraMcpServers.map((entry) => {
        if (!isRecord(entry)) throw new Error('Invalid IPC response');
        return {
          name: stringField(entry, 'name'),
          command: stringField(entry, 'command'),
          args: stringList(entry.args),
          cwd: stringField(entry, 'cwd'),
          type: stringField(entry, 'type'),
          env: stringRecordResponse(entry.env),
        };
      }),
    },
  };
}

function permissionDecisionResponse(value: unknown): 'ALLOW' | 'ASK' | 'DENY' {
  if (value === 'ALLOW' || value === 'ASK' || value === 'DENY') return value;
  throw new Error('Invalid IPC response');
}

function integerField(value: Record<string, unknown>, field: string): number {
  const result = numberField(value, field);
  if (!Number.isInteger(result)) throw new Error('Invalid IPC response');
  return result;
}

function stringRecordResponse(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new Error('Invalid IPC response');
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) throw new Error('Invalid IPC response');
  return Object.fromEntries(entries);
}

function dashboard(value: unknown): DashboardSnapshot {
  if (!isRecord(value) || !isRecord(value.gitSummary) || !isRecord(value.mcp) || !isRecord(value.codex)
    || !isRecord(value.connectionModes) || value.mode !== 'WORK') {
    throw new Error('Invalid IPC response');
  }
  const selectedWorkspace = value.selectedWorkspace === null ? null : workspaceSummary(value.selectedWorkspace);
  const url = value.mcp.url;
  const version = value.codex.version;
  if ((url !== null && typeof url !== 'string') || (version !== null && typeof version !== 'string')) {
    throw new Error('Invalid IPC response');
  }
  return {
    selectedWorkspace,
    activeWorkspaces: workspaceList(value.activeWorkspaces),
    gitSummary: {
      branch: value.gitSummary.branch === null ? null : stringField(value.gitSummary, 'branch'),
      changedFiles: numberField(value.gitSummary, 'changedFiles'),
      stagedFiles: numberField(value.gitSummary, 'stagedFiles'),
      message: stringField(value.gitSummary, 'message'),
    },
    mcp: mcpStatus(value.mcp),
    codex: { installed: booleanField(value.codex, 'installed'), version },
    managedProcessCount: numberField(value, 'managedProcessCount'),
    auditEventCount: numberField(value, 'auditEventCount'),
    recentAuditEvents: auditEventSummaries(value.recentAuditEvents),
    permissionProfile: permissionProfile(value.permissionProfile),
    capabilities: capabilitySummaries(value.capabilities),
    agentState: agentState(value.agentState),
    mode: 'WORK',
    locale: uiLocale(value.locale),
    unrestricted: booleanField(value, 'unrestricted'),
    allowAiDelete: booleanField(value, 'allowAiDelete'),
    destructiveDeletePolicy: destructiveDeletePolicy(value.destructiveDeletePolicy),
    stdioPermissionProfile: permissionProfile(value.stdioPermissionProfile),
    stdioStrictRoots: booleanField(value, 'stdioStrictRoots'),
    stdioAllowedRoots: stringList(value.stdioAllowedRoots),
    backups: backupSummaries(value.backups),
    recovery: recoveryCenter(value.recovery),
    connectionModes: {
      httpUrl: nullableString(value.connectionModes.httpUrl),
      stdioCommand: stringField(value.connectionModes, 'stdioCommand'),
    },
    workLog: workLogEntries(value.workLog),
    inFlight: inFlightItems(value.inFlight),
    tunnel: tunnelStatus(value.tunnel),
    settings: userSettings(value.settings),
    appVersion: stringField(value, 'appVersion'),
  };
}

function backupSummaries(value: unknown): readonly BackupSummary[] {
  if (!Array.isArray(value)) throw new Error('Invalid IPC response');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid IPC response');
    const reason = entry.reason;
    if (reason !== 'daily' && reason !== 'manual' && reason !== 'pre-update' && reason !== 'pre-migration') throw new Error('Invalid IPC response');
    return { id: stringField(entry, 'id'), createdAt: stringField(entry, 'createdAt'), reason, sizeBytes: numberField(entry, 'sizeBytes') };
  });
}

function recoveryCenter(value: unknown): DashboardSnapshot['recovery'] {
  if (!isRecord(value) || !Array.isArray(value.trashItems) || !Array.isArray(value.checkpoints)) throw new Error('Invalid IPC response');
  const trashItems = value.trashItems.map((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid IPC response');
    const rawKind = entry.kind;
    if (rawKind !== 'deleted' && rawKind !== 'replacement_backup') throw new Error('Invalid IPC response');
    const kind: 'deleted' | 'replacement_backup' = rawKind;
    return {
      recoveryId: stringField(entry, 'recoveryId'),
      workspaceId: stringField(entry, 'workspaceId'),
      relativePath: stringField(entry, 'relativePath'),
      deletedAt: stringField(entry, 'deletedAt'),
      isDirectory: booleanField(entry, 'isDirectory'),
      payloadAvailable: booleanField(entry, 'payloadAvailable'),
      kind,
    };
  });
  const checkpoints = value.checkpoints.map((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.files)) throw new Error('Invalid IPC response');
    return {
      id: stringField(entry, 'id'),
      workspaceId: stringField(entry, 'workspaceId'),
      createdAt: stringField(entry, 'createdAt'),
      files: entry.files.map((file) => {
        if (!isRecord(file)) throw new Error('Invalid IPC response');
        return { path: stringField(file, 'path'), contentSha256: stringField(file, 'contentSha256'), size: numberField(file, 'size') };
      }),
    };
  });
  return { trashRoot: nullableString(value.trashRoot), trashItems, checkpoints };
}

function capabilitySummaries(value: unknown): DashboardSnapshot['capabilities'] {
  if (!Array.isArray(value)) throw new Error('Invalid IPC response');
  return value.map((entry) => {
    if (!isRecord(entry) || !isCapabilityToolName(entry.name)) throw new Error('Invalid IPC response');
    return {
      name: entry.name,
      title: stringField(entry, 'title'),
      description: stringField(entry, 'description'),
      available: booleanField(entry, 'available'),
      ready: booleanField(entry, 'ready'),
    };
  });
}

function isCapabilityToolName(value: unknown): value is DashboardSnapshot['capabilities'][number]['name'] {
  return value === 'shell' || value === 'dom_cdp' || value === 'accessibility' || value === 'input_event'
    || value === 'vision' || value === 'window' || value === 'health' || value === 'system_info'
    || value === 'notification' || value === 'file_dialog' || value === 'clipboard' || value === 'web_fetch'
    || value === 'audio' || value === 'screen_record' || value === 'office' || value === 'scheduler'
    || value === 'wsl_exec' || value === 'wsl_fs';
}

function mcpStatus(value: unknown): McpConnectionStatus {
  if (!isRecord(value)) throw new Error('Invalid IPC response');
  return {
    running: booleanField(value, 'running'),
    url: nullableString(value.url),
    lastStartError: value.lastStartError === undefined ? null : nullableString(value.lastStartError),
    workspaceId: nullableString(value.workspaceId),
  };
}

function updateStatus(value: unknown): UpdateStatus {
  if (!isRecord(value)) throw new Error('Invalid IPC response');
  const phase = value.phase;
  if (phase !== 'idle' && phase !== 'checking' && phase !== 'available' && phase !== 'downloading'
    && phase !== 'ready' && phase !== 'installing' && phase !== 'up-to-date' && phase !== 'error' && phase !== 'unavailable') {
    throw new Error('Invalid IPC response');
  }
  const progress = value.progressPercent;
  if (progress !== null && (typeof progress !== 'number' || !Number.isFinite(progress))) throw new Error('Invalid IPC response');
  return {
    phase,
    currentVersion: stringField(value, 'currentVersion'),
    availableVersion: nullableString(value.availableVersion),
    progressPercent: progress,
    lastCheckedAt: nullableString(value.lastCheckedAt),
    message: nullableString(value.message),
    canInstall: booleanField(value, 'canInstall'),
  };
}

function managedBrowserStatus(value: unknown): ManagedBrowserStatus {
  if (!isRecord(value) || typeof value.ready !== 'boolean' || typeof value.port !== 'number'
    || !Number.isInteger(value.port) || typeof value.launched !== 'boolean') {
    throw new Error('Invalid IPC response');
  }
  return { ready: value.ready, port: value.port, launched: value.launched };
}

function auditEventSummaries(value: unknown): DashboardSnapshot['recentAuditEvents'] {
  if (!Array.isArray(value)) throw new Error('Invalid IPC response');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid IPC response');
    return {
      id: stringField(entry, 'id'),
      timestamp: stringField(entry, 'timestamp'),
      action: stringField(entry, 'action'),
      resultCode: stringField(entry, 'resultCode'),
    };
  });
}

function processSummary(value: unknown): ProcessSummary {
  if (!isRecord(value) || !Array.isArray(value.args)) throw new Error('Invalid IPC response');
  const state = processState(value.state);
  if (value.args.some((arg) => typeof arg !== 'string')) throw new Error('Invalid IPC response');
  return {
    id: stringField(value, 'id'),
    workspaceId: stringField(value, 'workspaceId'),
    sessionId: nullableString(value.sessionId),
    executable: stringField(value, 'executable'),
    args: value.args,
    state,
    logSummary: stringField(value, 'logSummary'),
  };
}

function processState(value: unknown): ProcessSummary['state'] {
  if (value === 'starting' || value === 'running' || value === 'exited' || value === 'failed' || value === 'stopped' || value === 'timed_out' || value === 'termination_unverified') {
    return value;
  }
  throw new Error('Invalid IPC response');
}

function processList(value: unknown): readonly ProcessSummary[] {
  if (!Array.isArray(value)) throw new Error('Invalid IPC response');
  return value.map(processSummary);
}

function doctorReport(value: unknown): DoctorReport {
  if (!isRecord(value) || !Array.isArray(value.checks) || (value.exitCode !== 0 && value.exitCode !== 1)) {
    throw new Error('Invalid IPC response');
  }
  const checks: readonly DoctorCheck[] = value.checks.map((check) => {
    if (!isRecord(check) || typeof check.required !== 'boolean') throw new Error('Invalid IPC response');
    const status = check.status;
    if (status !== 'pass' && status !== 'warn' && status !== 'fail' && status !== 'unknown') throw new Error('Invalid IPC response');
    return {
      id: stringField(check, 'id'),
      required: check.required,
      status,
      title: stringField(check, 'title'),
      summary: stringField(check, 'summary'),
      affectedToolNames: stringList(check.affectedToolNames),
      checkedAt: stringField(check, 'checkedAt'),
      durationMs: numberField(check, 'durationMs'),
      ...(check.detail === undefined ? {} : { detail: stringField(check, 'detail') }),
      ...(check.remediationId === undefined ? {} : { remediationId: stringField(check, 'remediationId') }),
      ...(check.message === undefined ? {} : { message: stringField(check, 'message') }),
    };
  });
  return { checks, exitCode: value.exitCode };
}

function toolCatalogSnapshot(value: unknown): ToolCatalogSnapshot {
  if (!isRecord(value) || !Array.isArray(value.items) || !Array.isArray(value.remediations)) throw new Error('Invalid IPC response');
  const locale = uiLocale(value.locale);
  const items = value.items.map(toolCatalogItem);
  const remediations = value.remediations.map(resolvedRemediation);
  return { generatedAt: stringField(value, 'generatedAt'), locale, items, remediations };
}

function toolCatalogItem(value: unknown): ToolCatalogItem {
  if (!isRecord(value) || !Array.isArray(value.requirements) || !Array.isArray(value.remediationIds) || !Array.isArray(value.searchText)) throw new Error('Invalid IPC response');
  const origin = value.origin;
  const category = value.category;
  const declaredPermission = value.declaredPermission;
  const profileDecision = value.profileDecision;
  const riskMode = value.riskMode;
  const readiness = value.readiness;
  if (origin !== 'lnwjud' && origin !== 'external_mcp') throw new Error('Invalid IPC response');
  if (!['workspace','files','search_context','git','process','browser_desktop','system','office_media','automation','agent_goals','extensions'].includes(String(category))) throw new Error('Invalid IPC response');
  if (!['READ','WRITE','EXECUTE','DANGEROUS','UNKNOWN'].includes(String(declaredPermission))) throw new Error('Invalid IPC response');
  if (!['ALLOW','ASK','DENY','UNKNOWN'].includes(String(profileDecision))) throw new Error('Invalid IPC response');
  if (!['fixed','input_dependent','external_unknown'].includes(String(riskMode))) throw new Error('Invalid IPC response');
  if (!['ready','needs_setup','blocked','disabled','unsupported','unknown'].includes(String(readiness))) throw new Error('Invalid IPC response');
  const supportsCancel = value.supportsCancel;
  const supportsDryRun = value.supportsDryRun;
  if (supportsCancel !== null && typeof supportsCancel !== 'boolean') throw new Error('Invalid IPC response');
  if (supportsDryRun !== null && typeof supportsDryRun !== 'boolean') throw new Error('Invalid IPC response');
  const inputSchema = value.inputSchema;
  if (inputSchema !== null && !isRecord(inputSchema)) throw new Error('Invalid IPC response');
  return {
    name: stringField(value, 'name'),
    origin: origin as ToolCatalogItem['origin'],
    ...(value.serverName === undefined ? {} : { serverName: stringField(value, 'serverName') }),
    category: category as ToolCatalogItem['category'],
    title: stringField(value, 'title'),
    shortDescription: stringField(value, 'shortDescription'),
    longDescription: stringField(value, 'longDescription'),
    declaredPermission: declaredPermission as ToolCatalogItem['declaredPermission'],
    profileDecision: profileDecision as ToolCatalogItem['profileDecision'],
    riskMode: riskMode as ToolCatalogItem['riskMode'],
    readiness: readiness as ToolCatalogItem['readiness'],
    stale: booleanField(value, 'stale'),
    checkedAt: nullableString(value.checkedAt),
    supportsCancel,
    supportsDryRun,
    requirements: value.requirements.map(requirementResult),
    remediationIds: stringList(value.remediationIds),
    inputSchema,
    searchText: stringList(value.searchText),
  };
}

function requirementResult(value: unknown): RequirementResult {
  if (!isRecord(value) || typeof value.required !== 'boolean') throw new Error('Invalid IPC response');
  const status = value.status;
  if (status !== 'pass' && status !== 'warn' && status !== 'fail' && status !== 'unknown') throw new Error('Invalid IPC response');
  return {
    id: stringField(value, 'id'), status, required: value.required,
    checkedAt: stringField(value, 'checkedAt'), summaryKey: stringField(value, 'summaryKey'),
    ...(value.detail === undefined ? {} : { detail: stringField(value, 'detail') }),
    ...(value.remediationId === undefined ? {} : { remediationId: stringField(value, 'remediationId') }),
  };
}

function resolvedRemediation(value: unknown): ResolvedRemediation {
  if (!isRecord(value) || !Array.isArray(value.steps) || !Array.isArray(value.actions)) throw new Error('Invalid IPC response');
  const actions = value.actions.map((action) => {
    if (!isRecord(action)) throw new Error('Invalid IPC response');
    if (action.kind === 'open_settings' && typeof action.target === 'string') return { kind: 'open_settings' as const, target: action.target };
    if (action.kind === 'open_official_url' && typeof action.target === 'string') return { kind: 'open_official_url' as const, target: action.target };
    if (action.kind === 'open_system_settings' && action.target === 'windows_optional_features') return { kind: 'open_system_settings' as const, target: 'windows_optional_features' as const };
    if (action.kind === 'copy_command' && typeof action.commandId === 'string') return { kind: 'copy_command' as const, commandId: action.commandId };
    if (action.kind === 'launch_managed_browser') return { kind: 'launch_managed_browser' as const };
    if (action.kind === 'install_pdf_provider') return { kind: 'install_pdf_provider' as const };
    if (action.kind === 'set_user_setting' && action.setting === 'codexToolsEnabled' && typeof action.value === 'boolean') return { kind: 'set_user_setting' as const, setting: 'codexToolsEnabled' as const, value: action.value };
    if (action.kind === 'recheck' && Array.isArray(action.requirementIds) && action.requirementIds.every((entry) => typeof entry === 'string')) return { kind: 'recheck' as const, requirementIds: action.requirementIds as string[] };
    throw new Error('Invalid IPC response');
  });
  return { id: stringField(value, 'id'), title: stringField(value, 'title'), explanation: stringField(value, 'explanation'), steps: stringList(value.steps), actions };
}

function getToolCatalog(request: GetToolCatalogRequest): Promise<ToolCatalogSnapshot> {
  if (!isRecord(request) || (request.locale !== 'th' && request.locale !== 'en')) return Promise.reject(new Error('Invalid IPC request'));
  return invoke(ipcChannels.getToolCatalog, { locale: request.locale }).then(toolCatalogSnapshot);
}
function recheckToolCatalog(request: RecheckToolCatalogRequest): Promise<{ readonly catalog: ToolCatalogSnapshot; readonly doctor: DoctorReport }> {
  if (!isRecord(request) || (request.locale !== 'th' && request.locale !== 'en') || !Array.isArray(request.requirementIds) || request.requirementIds.some((id) => typeof id !== 'string')) return Promise.reject(new Error('Invalid IPC request'));
  return invoke(ipcChannels.recheckToolCatalog, { locale: request.locale, requirementIds: [...request.requirementIds] }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { catalog: toolCatalogSnapshot(value.catalog), doctor: doctorReport(value.doctor) };
  });
}
function openToolSetupTarget(request: OpenToolSetupTargetRequest): Promise<{ readonly opened: true }> {
  if (!isRecord(request) || typeof request.target !== 'string' || request.target.length === 0 || request.target.length > 128) return Promise.reject(new Error('Invalid IPC request'));
  return invoke(ipcChannels.openToolSetupTarget, { target: request.target }).then((value: unknown) => {
    if (!isRecord(value) || value.opened !== true) throw new Error('Invalid IPC response');
    return { opened: true };
  });
}
function copyToolCommand(request: CopyToolCommandRequest): Promise<{ readonly copied: true }> {
  if (!isRecord(request) || typeof request.commandId !== 'string' || request.commandId.length === 0 || request.commandId.length > 128) return Promise.reject(new Error('Invalid IPC request'));
  return invoke(ipcChannels.copyToolCommand, { commandId: request.commandId }).then((value: unknown) => {
    if (!isRecord(value) || value.copied !== true) throw new Error('Invalid IPC response');
    return { copied: true };
  });
}

function addWorkspace(request: AddWorkspaceRequest): Promise<WorkspaceSummary> {
  if (!isRecord(request) || typeof request.rootPath !== 'string' || request.rootPath.trim().length === 0) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.addWorkspace, { rootPath: request.rootPath }).then(workspaceSummary);
}

function selectWorkspace(request: SelectWorkspaceRequest): Promise<WorkspaceSummary> {
  if (!isRecord(request) || typeof request.workspaceId !== 'string' || request.workspaceId.trim().length === 0) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.selectWorkspace, { workspaceId: request.workspaceId }).then(workspaceSummary);
}

function setWorkspaceActive(request: SetWorkspaceActiveRequest): Promise<{ readonly workspace: WorkspaceSummary; readonly active: boolean }> {
  if (!isRecord(request) || typeof request.workspaceId !== 'string' || request.workspaceId.trim().length === 0 || typeof request.active !== 'boolean') {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.setWorkspaceActive, { workspaceId: request.workspaceId, active: request.active }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { workspace: workspaceSummary(value.workspace), active: booleanField(value, 'active') };
  });
}

function setWorkspaceArchived(request: SetWorkspaceArchivedRequest): Promise<WorkspaceSummary> {
  if (!isRecord(request) || typeof request.workspaceId !== 'string' || request.workspaceId.trim().length === 0 || typeof request.archived !== 'boolean') {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.setWorkspaceArchived, { workspaceId: request.workspaceId, archived: request.archived }).then(workspaceSummary);
}

function deleteWorkspace(request: DeleteWorkspaceRequest): Promise<{ readonly deleted: boolean; readonly workspaceId: string; readonly rootPath: string; readonly backupId: string }> {
  if (!isRecord(request) || typeof request.workspaceId !== 'string' || request.workspaceId.trim().length === 0
    || typeof request.userConfirmed !== 'boolean') {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.deleteWorkspace, { workspaceId: request.workspaceId, userConfirmed: request.userConfirmed }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return {
      deleted: booleanField(value, 'deleted'),
      workspaceId: stringField(value, 'workspaceId'),
      rootPath: stringField(value, 'rootPath'),
      backupId: stringField(value, 'backupId'),
    };
  });
}

function setPermissionProfile(request: SetPermissionProfileRequest): Promise<{ readonly profile: PermissionProfileName }> {
  if (!isRecord(request)) return Promise.reject(new Error('Invalid IPC request'));
  const profile = permissionProfile(request.profile);
  return invoke(ipcChannels.setPermissionProfile, { profile }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { profile: permissionProfile(value.profile) };
  });
}

function setUnrestrictedMode(request: SetUnrestrictedModeRequest): Promise<{ readonly unrestricted: boolean; readonly restartRequired: boolean }> {
  if (!isRecord(request) || typeof request.enabled !== 'boolean') {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.setUnrestrictedMode, { enabled: request.enabled }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { unrestricted: booleanField(value, 'unrestricted'), restartRequired: booleanField(value, 'restartRequired') };
  });
}

function setAiDeletePolicy(request: SetAiDeletePolicyRequest): Promise<{ readonly enabled: boolean; readonly policy: DestructiveDeletePolicy }> {
  if (!isRecord(request)) return Promise.reject(new Error('Invalid IPC request'));
  const enabled = typeof request.enabled === 'boolean' ? request.enabled : undefined;
  let policy: DestructiveDeletePolicy | undefined;
  try { policy = request.policy === undefined ? undefined : destructiveDeletePolicy(request.policy); }
  catch (error) { return Promise.reject(error); }
  if (enabled === undefined && policy === undefined) return Promise.reject(new Error('Invalid IPC request'));
  const payload = { ...(enabled === undefined ? {} : { enabled }), ...(policy === undefined ? {} : { policy }) };
  return invoke(ipcChannels.setAiDeletePolicy, payload).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { enabled: booleanField(value, 'enabled'), policy: destructiveDeletePolicy(value.policy) };
  });
}

function destructiveDeletePolicy(value: unknown): DestructiveDeletePolicy {
  if (!isRecord(value) || typeof value.protectCriticalFiles !== 'boolean' || typeof value.recoverableDelete !== 'boolean') throw new Error('Invalid IPC response');
  const approvalsRaw = value.approvals;
  if (!isRecord(approvalsRaw)) throw new Error('Invalid IPC response');
  const keys = ['delete_file', 'git_rm', 'git_clean', 'git_reset_restore', 'shell_rm_unlink', 'shell_rmdir', 'shell_del_erase', 'wsl_rm_unlink', 'wsl_rmdir'] as const;
  const approvals = Object.fromEntries(keys.map((key) => [key, booleanField(approvalsRaw, key)])) as Record<(typeof keys)[number], boolean>;
  return { protectCriticalFiles: value.protectCriticalFiles, recoverableDelete: value.recoverableDelete, approvals };
}

function setStdioPolicy(request: SetStdioPolicyRequest): Promise<{ readonly profile: PermissionProfileName; readonly strictRoots: boolean; readonly allowedRoots: readonly string[]; readonly restartRequired: boolean }> {
  if (!isRecord(request) || !Array.isArray(request.allowedRoots) || typeof request.strictRoots !== 'boolean') return Promise.reject(new Error('Invalid IPC request'));
  const profile = permissionProfile(request.profile);
  const allowedRoots = stringList(request.allowedRoots);
  return invoke(ipcChannels.setStdioPolicy, { profile, strictRoots: request.strictRoots, allowedRoots }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { profile: permissionProfile(value.profile), strictRoots: booleanField(value, 'strictRoots'), allowedRoots: stringList(value.allowedRoots), restartRequired: booleanField(value, 'restartRequired') };
  });
}

function createBackup(): Promise<BackupSummary> {
  return invoke(ipcChannels.createBackup).then((value: unknown) => {
    const [result] = backupSummaries([value]);
    if (result === undefined) throw new Error('Invalid IPC response');
    return result;
  });
}

function scheduleRestoreBackup(request: ScheduleRestoreBackupRequest): Promise<{ readonly scheduled: boolean; readonly restartRequired: boolean }> {
  if (!isRecord(request) || typeof request.backupId !== 'string' || request.backupId.trim().length === 0) return Promise.reject(new Error('Invalid IPC request'));
  return invoke(ipcChannels.scheduleRestoreBackup, { backupId: request.backupId }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { scheduled: booleanField(value, 'scheduled'), restartRequired: booleanField(value, 'restartRequired') };
  });
}

function restoreRecoveryItem(request: RestoreRecoveryItemRequest): Promise<{ readonly restored: boolean; readonly path: string; readonly rollbackRecoveryId: string | null }> {
  if (!isRecord(request) || typeof request.workspaceId !== 'string' || request.workspaceId.trim().length === 0
    || typeof request.recoveryId !== 'string' || request.recoveryId.trim().length === 0) return Promise.reject(new Error('Invalid IPC request'));
  return invoke(ipcChannels.restoreRecoveryItem, { workspaceId: request.workspaceId, recoveryId: request.recoveryId }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { restored: booleanField(value, 'restored'), path: stringField(value, 'path'), rollbackRecoveryId: nullableString(value.rollbackRecoveryId) };
  });
}

function restoreCheckpoint(request: RestoreCheckpointRequest): Promise<{ readonly restored: boolean; readonly paths: readonly string[]; readonly rollbackCheckpointId: string | null }> {
  if (!isRecord(request) || typeof request.workspaceId !== 'string' || request.workspaceId.trim().length === 0
    || typeof request.checkpointId !== 'string' || request.checkpointId.trim().length === 0) return Promise.reject(new Error('Invalid IPC request'));
  return invoke(ipcChannels.restoreCheckpoint, { workspaceId: request.workspaceId, checkpointId: request.checkpointId }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return {
      restored: booleanField(value, 'restored'),
      paths: stringList(value.paths),
      rollbackCheckpointId: nullableString(value.rollbackCheckpointId),
    };
  });
}

function stopProcess(request: StopProcessRequest): Promise<{ readonly stopped: boolean }> {
  if (!isRecord(request) || typeof request.processId !== 'string' || request.processId.trim().length === 0) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.stopProcess, { processId: request.processId }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { stopped: booleanField(value, 'stopped') };
  });
}

function startProcess(request: StartProcessRequest): Promise<ProcessSummary> {
  if (!isRecord(request) || typeof request.workspaceId !== 'string' || request.workspaceId.trim().length === 0
    || (request.mode !== 'fixture' && request.mode !== 'project-dev')) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.startProcess, { workspaceId: request.workspaceId, mode: request.mode }).then(processSummary);
}

function startMcp(request: StartMcpRequest): Promise<McpConnectionStatus> {
  if (!isRecord(request) || typeof request.workspaceId !== 'string' || request.workspaceId.trim().length === 0) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.startMcp, { workspaceId: request.workspaceId }).then(mcpStatus);
}

function stopMcp(): Promise<McpConnectionStatus> {
  return invoke(ipcChannels.stopMcp).then(mcpStatus);
}

function restartMcp(): Promise<McpConnectionStatus> {
  return invoke(ipcChannels.restartMcp).then(mcpStatus);
}

function clearWorkLog(request: ClearWorkLogRequest = {}): Promise<{ readonly cleared: boolean }> {
  if (!isRecord(request)) return Promise.reject(new Error('Invalid IPC request'));
  const payload = scopePayload(request);
  return invoke(ipcChannels.clearWorkLog, payload).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { cleared: booleanField(value, 'cleared') };
  });
}

function saveTunnelApiKey(request: SaveTunnelApiKeyRequest): Promise<{ readonly saved: boolean }> {
  if (!isRecord(request) || typeof request.apiKey !== 'string' || request.apiKey.trim().length === 0) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.saveTunnelApiKey, { apiKey: request.apiKey }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { saved: booleanField(value, 'saved') };
  });
}

function setTunnelClientPath(request: SetTunnelClientPathRequest): Promise<{ readonly clientPath: string }> {
  if (!isRecord(request) || typeof request.clientPath !== 'string' || request.clientPath.trim().length === 0) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.setTunnelClientPath, { clientPath: request.clientPath }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { clientPath: stringField(value, 'clientPath') };
  });
}

function setLocale(request: SetLocaleRequest): Promise<{ readonly locale: UiLocale }> {
  if (!isRecord(request) || (request.locale !== 'th' && request.locale !== 'en')) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.setLocale, { locale: request.locale }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { locale: uiLocale(value.locale) };
  });
}

function setUserSettings(request: SetUserSettingsRequest): Promise<{ readonly settings: UserSettings; readonly restartRequired: boolean }> {
  if (!isRecord(request) || !isRecord(request.settings)) return Promise.reject(new Error('Invalid IPC request'));
  return invoke(ipcChannels.setUserSettings, { settings: request.settings }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { settings: userSettings(value.settings), restartRequired: booleanField(value, 'restartRequired') };
  });
}

function chooseTunnelClientPath(): Promise<{ readonly clientPath: string | null }> {
  return invoke(ipcChannels.chooseTunnelClientPath).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { clientPath: nullableString(value.clientPath) };
  });
}

function configureTunnelProfile(request: ConfigureTunnelProfileRequest): Promise<{ readonly configured: boolean; readonly profilePath: string }> {
  if (!isRecord(request) || typeof request.tunnelId !== 'string' || request.tunnelId.trim().length === 0) return Promise.reject(new Error('Invalid IPC request'));
  return invoke(ipcChannels.configureTunnelProfile, { tunnelId: request.tunnelId }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { configured: booleanField(value, 'configured'), profilePath: stringField(value, 'profilePath') };
  });
}

function openExternalSetupPage(request: OpenExternalSetupPageRequest): Promise<{ readonly opened: true }> {
  if (
    !isRecord(request) ||
    (request.target !== 'openai_tunnels' && request.target !== 'openai_api_keys' && request.target !== 'chatgpt_plugins')
  ) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.openExternalSetupPage, { target: request.target }).then((value: unknown) => {
    if (!isRecord(value) || value.opened !== true) throw new Error('Invalid IPC response');
    return { opened: true };
  });
}

function launchManagedBrowser(): Promise<ManagedBrowserStatus> {
  return invoke(ipcChannels.launchManagedBrowser).then(managedBrowserStatus);
}

function installPdfProvider(): Promise<PdfProviderInstallResult> {
  return invoke(ipcChannels.installPdfProvider).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return {
      providerPath: stringField(value, 'providerPath'),
      version: stringField(value, 'version'),
      sourceUrl: stringField(value, 'sourceUrl'),
      archiveSha256: stringField(value, 'archiveSha256'),
      reused: booleanField(value, 'reused'),
      restartRequired: booleanField(value, 'restartRequired'),
    };
  });
}

function logLine(value: unknown): LogLine {
  if (!isRecord(value) || !isLogSource(value.source) || !isLogLevel(value.level)) throw new Error('Invalid IPC response');
  const correlation = parseLogCorrelation(value.correlation);
  return {
    id: numberField(value, 'id'),
    source: value.source,
    timestamp: stringField(value, 'timestamp'),
    level: value.level,
    text: stringField(value, 'text'),
    workspaceId: nullableString(value.workspaceId),
    sessionId: nullableString(value.sessionId),
    ...(correlation === undefined ? {} : { correlation }),
  };
}

function logSnapshot(value: unknown): LogSnapshot {
  if (!isRecord(value) || !Array.isArray(value.lines)) throw new Error('Invalid IPC response');
  return {
    lines: value.lines.map(logLine),
    tunnelLogPath: nullableString(value.tunnelLogPath),
    tunnelLogExists: booleanField(value, 'tunnelLogExists'),
  };
}

function isLogSource(value: unknown): value is 'tunnel' | 'mcp' | 'process' {
  return value === 'tunnel' || value === 'mcp' || value === 'process';
}

function isLogLevel(value: unknown): value is 'info' | 'warn' | 'error' {
  return value === 'info' || value === 'warn' || value === 'error';
}

function scopePayload(request: { readonly workspaceId?: string; readonly sessionId?: string }): { readonly workspaceId?: string; readonly sessionId?: string } {
  const workspaceId = typeof request.workspaceId === 'string' && request.workspaceId.trim().length > 0 ? request.workspaceId.trim() : undefined;
  const sessionId = typeof request.sessionId === 'string' && request.sessionId.trim().length > 0 ? request.sessionId.trim() : undefined;
  return { ...(workspaceId === undefined ? {} : { workspaceId }), ...(sessionId === undefined ? {} : { sessionId }) };
}

function clearLogBuffer(request: ClearLogBufferRequest): Promise<{ readonly cleared: boolean }> {
  if (!isRecord(request) || !isLogSource(request.source)) return Promise.reject(new Error('Invalid IPC request'));
  return invoke(ipcChannels.clearLogBuffer, { source: request.source, ...scopePayload(request) }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { cleared: booleanField(value, 'cleared') };
  });
}

function exportLogs(request: ExportLogsRequest): Promise<{ readonly exported: boolean }> {
  if (!isRecord(request) || !isLogSource(request.source)) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  const lineIds = request.lineIds;
  if (lineIds !== undefined && (!Array.isArray(lineIds) || lineIds.length > 5_000 || lineIds.some((id) => !Number.isSafeInteger(id) || id <= 0))) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.exportLogs, {
    source: request.source,
    filePath: request.filePath ?? '',
    ...scopePayload(request),
    ...(typeof request.query === 'string' && request.query.trim().length > 0 ? { query: request.query.trim().slice(0, 512) } : {}),
    ...(lineIds === undefined ? {} : { lineIds: [...lineIds] }),
  }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { exported: booleanField(value, 'exported') };
  });
}

function exportWorkLog(request: ExportWorkLogRequest): Promise<{ readonly exported: boolean }> {
  if (!isRecord(request) || !Array.isArray(request.rows) || request.rows.length > 5_000 || request.rows.some((row) => typeof row !== 'string' || row.length > 16_384)) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.exportWorkLog, { rows: [...request.rows] }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { exported: booleanField(value, 'exported') };
  });
}

function captureIncident(): Promise<IncidentExportResult> {
  return invoke(ipcChannels.captureIncident).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    const classification = value.classification;
    if (classification !== 'local_tool_failed' && classification !== 'tunnel_disconnected' && classification !== 'remote_turn_stopped' && classification !== 'healthy_or_inconclusive') throw new Error('Invalid IPC response');
    return { exported: booleanField(value, 'exported'), cancelled: booleanField(value, 'cancelled'), classification, capturedAt: nullableString(value.capturedAt) };
  });
}

function onUpdateStatus(callback: (status: UpdateStatus) => void): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    try {
      callback(updateStatus(payload));
    } catch {
      // Ignore malformed push events.
    }
  };
  ipcRenderer.on(pushChannels.updateStatus, listener);
  return (): void => {
    ipcRenderer.removeListener(pushChannels.updateStatus, listener);
  };
}

function onLogEvent(callback: (line: LogLine) => void): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    try {
      callback(logLine(payload));
    } catch {
      // Ignore malformed push events.
    }
  };
  ipcRenderer.on(pushChannels.logEvent, listener);
  return (): void => {
    ipcRenderer.removeListener(pushChannels.logEvent, listener);
  };
}

const api: LnwjudApi = {
  listWorkspaces: () => invoke(ipcChannels.listWorkspaces).then(workspaceList),
  addWorkspace,
  selectWorkspace,
  setWorkspaceActive,
  setWorkspaceArchived,
  deleteWorkspace,
  getDashboard: () => invoke(ipcChannels.getDashboard).then(dashboard),
  setPermissionProfile,
  setUnrestrictedMode,
  setAiDeletePolicy,
  setStdioPolicy,
  createBackup,
  scheduleRestoreBackup,
  restoreRecoveryItem,
  restoreCheckpoint,
  listProcesses: () => invoke(ipcChannels.listProcesses).then(processList),
  startProcess,
  stopProcess,
  startMcp,
  stopMcp,
  restartMcp,
  clearWorkLog,
  saveTunnelApiKey,
  startTunnel: () => invoke(ipcChannels.startTunnel).then(tunnelStatus),
  stopTunnel: () => invoke(ipcChannels.stopTunnel).then(tunnelStatus),
  getTunnelStatus: () => invoke(ipcChannels.getTunnelStatus).then(tunnelStatus),
  setTunnelClientPath,
  setLocale,
  setUserSettings,
  chooseTunnelClientPath,
  configureTunnelProfile,
  openExternalSetupPage,
  launchManagedBrowser,
  installPdfProvider,
  runDoctor: () => invoke(ipcChannels.runDoctor).then(doctorReport),
  getToolCatalog,
  recheckToolCatalog,
  openToolSetupTarget,
  copyToolCommand,
  getLogSnapshot: () => invoke(ipcChannels.getLogSnapshot).then(logSnapshot),
  clearLogBuffer,
  exportLogs,
  exportWorkLog,
  captureIncident,
  openLogViewer: () => invoke(ipcChannels.openLogViewer).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { opened: booleanField(value, 'opened') };
  }),
  getUpdateStatus: () => invoke(ipcChannels.getUpdateStatus).then(updateStatus),
  checkForUpdates: () => invoke(ipcChannels.checkForUpdates).then(updateStatus),
  installUpdate: () => invoke(ipcChannels.installUpdate).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { accepted: booleanField(value, 'accepted'), status: updateStatus(value.status) };
  }),
  onLogEvent,
  onUpdateStatus,
};

contextBridge.exposeInMainWorld('lnwjud', api);
