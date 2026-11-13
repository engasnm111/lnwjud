import fs from 'node:fs';
import path from 'node:path';
import { assertHostWindowsUpdateStartup } from '@lnwjud/capabilities';
import { startMcpStdio } from '@lnwjud/mcp-server';
import {
  STDIO_ALLOWED_ROOTS_SETTING_KEY,
  STDIO_PERMISSION_PROFILE_SETTING_KEY,
  STDIO_STRICT_ROOTS_SETTING_KEY,
  UNRESTRICTED_SETTING_KEY,
  USER_SETTING_KEYS,
  isUnrestricted,
  parseAllowedRoots,
  parseBooleanSetting,
  parseStdioPermissionProfile,
  resolveLnwjudDataPath,
} from '@lnwjud/shared';
import { applyPendingSqliteRestoreSync, SqliteBackupService, SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository } from '@lnwjud/storage';
import { comparableHostPath, hostPathApi, isMachineRootPath, normalizeWorkspaceRoot, WorkspaceService, type Workspace } from '@lnwjud/workspace';
import { createStdioMcpRuntime, resolveStdioCheckpointKey, type PersistedStdioSecurityPolicy } from '../runtime/stdio-mcp-runtime.js';
import { StrictWorkspaceRepository, canonicalizeAllowedRoots, requestedPathInsideAllowedRoot } from '../runtime/strict-workspace-repository.js';
import { resolveRequestedWorkspacePath } from '../runtime/workspace-selection.js';
import { resetWorkspaceRegistrations } from '../runtime/workspace-reset.js';

function readArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readArgs(flag: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== flag) continue;
    const value = process.argv[index + 1];
    if (typeof value === 'string' && value.trim().length > 0) values.push(value.trim());
  }
  return values;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function resolveDataPath(): string {
  return resolveLnwjudDataPath(process.env);
}

interface StdioSecurityPolicyOverrides {
  readonly profile?: string;
  readonly fullBypassFlag: boolean;
  readonly fullBypassEnv?: string;
  readonly strictRootsFlag: boolean;
  readonly strictRootsEnv?: string;
  readonly cliAllowedRoots: readonly string[];
  readonly envAllowedRoots: readonly string[];
  readonly unrestrictedEnv?: string;
}

interface EffectiveStdioSecurityPolicy {
  readonly profile: ReturnType<typeof parseStdioPermissionProfile>;
  readonly fullBypassAll: boolean;
  readonly strictRoots: boolean;
  readonly allowedRoots: readonly string[];
  readonly unrestricted: boolean;
  readonly customPermissionRaw: string;
}

function readPersistedSecurityPolicy(settingsRepository: SqliteSettingsRepository): PersistedStdioSecurityPolicy {
  return {
    profile: parseStdioPermissionProfile(settingsRepository.get(STDIO_PERMISSION_PROFILE_SETTING_KEY), 'full'),
    fullBypassAll: parseBooleanSetting(settingsRepository.get(USER_SETTING_KEYS.stdioFullBypassAll), false),
    strictRoots: parseBooleanSetting(settingsRepository.get(STDIO_STRICT_ROOTS_SETTING_KEY), false),
    allowedRoots: parseAllowedRoots(settingsRepository.get(STDIO_ALLOWED_ROOTS_SETTING_KEY)),
    unrestricted: isUnrestricted({}, settingsRepository.get(UNRESTRICTED_SETTING_KEY)),
    customPermissionRaw: settingsRepository.get(USER_SETTING_KEYS.customPermissionProfile) ?? '',
  };
}

function resolveEffectiveSecurityPolicy(
  persisted: PersistedStdioSecurityPolicy,
  overrides: StdioSecurityPolicyOverrides,
): EffectiveStdioSecurityPolicy {
  const profile = parseStdioPermissionProfile(overrides.profile ?? persisted.profile, 'full');
  const fullBypassRequested = overrides.fullBypassFlag
    || (overrides.fullBypassEnv !== undefined
      ? parseBooleanSetting(overrides.fullBypassEnv, false)
      : persisted.fullBypassAll);
  const fullBypassAll = profile === 'full' && fullBypassRequested;
  const strictRootsRequested = overrides.strictRootsFlag
    || (overrides.strictRootsEnv !== undefined
      ? parseBooleanSetting(overrides.strictRootsEnv, false)
      : persisted.strictRoots);
  const strictRoots = !fullBypassAll && strictRootsRequested;
  const allowedRoots = overrides.cliAllowedRoots.length > 0
    ? overrides.cliAllowedRoots
    : overrides.envAllowedRoots.length > 0
      ? overrides.envAllowedRoots
      : persisted.allowedRoots;
  const unrestrictedSetting = overrides.unrestrictedEnv === undefined
    ? persisted.unrestricted
    : isUnrestricted({ LNWJUD_UNRESTRICTED: overrides.unrestrictedEnv }, undefined);
  return {
    profile,
    fullBypassAll,
    strictRoots,
    allowedRoots,
    unrestricted: fullBypassAll || (!strictRoots && unrestrictedSetting),
    customPermissionRaw: profile === 'custom' ? persisted.customPermissionRaw : '',
  };
}

function securityPolicyFingerprint(policy: EffectiveStdioSecurityPolicy): string {
  const allowedRoots = policy.strictRoots
    ? [...policy.allowedRoots].map((root) => root.trim()).filter((root) => root.length > 0).sort()
    : [];
  return JSON.stringify({
    profile: policy.profile,
    fullBypassAll: policy.fullBypassAll,
    strictRoots: policy.strictRoots,
    allowedRoots,
    unrestricted: policy.unrestricted,
    customPermissionRaw: policy.customPermissionRaw,
  });
}

async function main(): Promise<void> {
  const dataPath = resolveDataPath();
  await assertHostWindowsUpdateStartup(dataPath);
  fs.mkdirSync(dataPath, { recursive: true });
  // Resolve the pure-Node checkpoint key before opening SQLite. Packaged
  // Electron STDIO supplies this through safeStorage instead; this entrypoint
  // deliberately accepts only an explicit development key.
  const checkpointEncryptionKey = resolveStdioCheckpointKey();
  const restore = applyPendingSqliteRestoreSync(path.join(dataPath, 'lnwjud.sqlite'), path.join(dataPath, 'backups'), { platform: process.platform, arch: process.arch });
  if (restore.error !== undefined) process.stderr.write(`lnwjud MCP stdio: scheduled restore failed: ${restore.error}\n`);
  if (restore.applied) process.stderr.write(`lnwjud MCP stdio: restored database from ${restore.backupId ?? 'scheduled backup'}\n`);

  const database = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'), { backupDirectory: path.join(dataPath, 'backups'), platform: process.platform, arch: process.arch });
  const rawWorkspaceRepository = new SqliteWorkspaceRepository(database);
  const settingsRepository = new SqliteSettingsRepository(database);

  const profileOverride = readArg('--profile') ?? process.env.LNWJUD_STDIO_PROFILE;
  const fullBypassEnv = process.env.LNWJUD_STDIO_FULL_BYPASS_ALL;
  const strictRootsEnv = process.env.LNWJUD_STRICT_ROOTS;
  const unrestrictedEnv = process.env.LNWJUD_UNRESTRICTED;
  const cliAllowedRoots = readArgs('--allowed-root');
  const envAllowedRoots = parseAllowedRoots(process.env.LNWJUD_ALLOWED_ROOTS);
  const securityPolicyOverrides: StdioSecurityPolicyOverrides = {
    fullBypassFlag: hasFlag('--full-bypass-all'),
    strictRootsFlag: hasFlag('--strict-roots'),
    cliAllowedRoots,
    envAllowedRoots,
    ...(profileOverride === undefined ? {} : { profile: profileOverride }),
    ...(fullBypassEnv === undefined ? {} : { fullBypassEnv }),
    ...(strictRootsEnv === undefined ? {} : { strictRootsEnv }),
    ...(unrestrictedEnv === undefined ? {} : { unrestrictedEnv }),
  };
  const initialSecurityPolicy = resolveEffectiveSecurityPolicy(readPersistedSecurityPolicy(settingsRepository), securityPolicyOverrides);
  const initialSecurityPolicyFingerprint = securityPolicyFingerprint(initialSecurityPolicy);
  const profileName = initialSecurityPolicy.profile;
  const stdioFullBypassAll = initialSecurityPolicy.fullBypassAll;
  const strictRootsEnabled = initialSecurityPolicy.strictRoots;
  const strictAllowedRoots = strictRootsEnabled ? await canonicalizeAllowedRoots(initialSecurityPolicy.allowedRoots) : undefined;

  const rawWorkspaceService = new WorkspaceService(rawWorkspaceRepository);
  const reset = hasFlag('--reset-workspaces')
    || process.env.LNWJUD_RESET_WORKSPACES === '1'
    || process.env.LNWJUD_RESET_WORKSPACES === 'true';
  if (reset) {
    const backupService = new SqliteBackupService(database, {
      databaseFilename: path.join(dataPath, 'lnwjud.sqlite'),
      backupDirectory: path.join(dataPath, 'backups'),
      platform: process.platform,
      arch: process.arch,
    });
    const result = await resetWorkspaceRegistrations(
      rawWorkspaceService,
      backupService,
      readArg('--confirm-reset-workspaces') ?? process.env.LNWJUD_CONFIRM_RESET_WORKSPACES,
    );
    process.stderr.write(
      `lnwjud MCP stdio: cleared ${result.deleted} previous workspace registration(s)`
      + `${result.backupId === null ? '' : ` after backup ${result.backupId}`}\n`,
    );
  }

  const workspaceRepository = strictAllowedRoots === undefined
    ? rawWorkspaceRepository
    : new StrictWorkspaceRepository(rawWorkspaceRepository, strictAllowedRoots);
  const workspaceService = new WorkspaceService(workspaceRepository);
  const unrestricted = initialSecurityPolicy.unrestricted;

  const requestedRaw = readArg('--workspace') ?? process.env.LNWJUD_WORKSPACE;
  const registeredProjects = (await workspaceService.list())
    .filter((entry) => !isMachineRootPath(entry.realRootPath) && !isMachineRootPath(entry.rootPath));
  const requestedPath = resolveRequestedWorkspacePath({
    ...(requestedRaw === undefined ? {} : { requestedPath: requestedRaw }),
    ...(strictAllowedRoots === undefined ? {} : { strictAllowedRoots }),
    registeredProjectPaths: registeredProjects.map((entry) => entry.realRootPath),
  });
  if (requestedPath === null) {
    process.stderr.write('lnwjud MCP stdio: no project workspace is configured; pass --workspace <path>\n');
    process.exit(2);
  }
  if (!fs.existsSync(requestedPath)) {
    process.stderr.write(`lnwjud MCP stdio: workspace path does not exist: ${requestedPath}\n`);
    process.exit(2);
  }

  let workspace: Workspace;
  if (strictAllowedRoots !== undefined) {
    // This environment variable is consumed by the host-native runtime. Use
    // the platform delimiter so POSIX roots remain independently addressable
    // while Windows drive-letter paths continue to use `;`.
    process.env.LNWJUD_CAPABILITY_ROOTS = strictAllowedRoots.join(path.delimiter);
    for (const root of strictAllowedRoots) {
      const normalized = comparableWorkspaceRoot(root);
      const existing = normalized === null ? undefined : (await workspaceService.list()).find((entry) => comparableWorkspaceRoot(entry.realRootPath) === normalized);
      if (existing !== undefined) continue;
      const added = await workspaceService.add(hostPathApi(process.platform).basename(root) || root, root);
      if (!added.ok) throw new Error(`Could not register strict allowed root ${root}: ${added.error.message}`);
    }
    const selectedAllowedRoot = await requestedPathInsideAllowedRoot(requestedPath, strictAllowedRoots);
    const selectedNorm = comparableWorkspaceRoot(selectedAllowedRoot);
    const selected = selectedNorm === null ? undefined : (await workspaceService.list()).find((entry) => comparableWorkspaceRoot(entry.realRootPath) === selectedNorm);
    if (selected === undefined) throw new Error(`Strict allowed root was not registered: ${selectedAllowedRoot}`);
    workspace = selected;
  } else {
    process.env.LNWJUD_CAPABILITY_ROOTS = process.env.LNWJUD_CAPABILITY_ROOTS?.trim()
      || requestedPath.replace(/\\/g, '/');

    const requestedNorm = comparableWorkspaceRoot(requestedPath);
    const workspaces = await workspaceService.list();
    let selected = requestedNorm === null ? undefined : workspaces.find((entry) => comparableWorkspaceRoot(entry.realRootPath) === requestedNorm);
    if (selected === undefined) {
      const added = await workspaceService.add(hostPathApi(process.platform).basename(requestedPath) || 'Workspace', requestedPath);
      if (!added.ok) throw new Error(`Could not register ${requestedPath}: ${added.error.message}`);
      selected = added.value;
    }
    workspace = selected;
  }

  for (const entry of await workspaceService.list()) {
    process.stderr.write(`lnwjud workspace id=${entry.id} root=${entry.realRootPath}\n`);
  }
  database.close();

  const runtime = createStdioMcpRuntime(dataPath, workspace, unrestricted, {
    checkpointEncryptionKey,
    permissionProfile: profileName,
    fullBypassAll: stdioFullBypassAll,
    ...(strictAllowedRoots === undefined ? {} : { strictAllowedRoots }),
  });
  await runtime.activityReady;
  const invocationGuardProvider = (): string | undefined => {
    const currentPolicy = resolveEffectiveSecurityPolicy(runtime.persistedSecurityPolicyProvider(), securityPolicyOverrides);
    return securityPolicyFingerprint(currentPolicy) === initialSecurityPolicyFingerprint
      ? undefined
      : 'Direct STDIO security settings changed. Reconnect Direct STDIO before using tools so the new permissions apply safely.';
  };
  process.stderr.write(
    `lnwjud MCP stdio ready primary=${workspace.id} root=${workspace.realRootPath} profile=${profileName}`
      + `${stdioFullBypassAll ? ' full_bypass=1' : ''}${unrestricted ? ' unrestricted=1' : ''}${strictAllowedRoots === undefined ? '' : ` strict_roots=${strictAllowedRoots.length}`}\n`,
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await handle?.close(); } catch { /* transport may already be closed */ }
    try { await runtime.close(); } catch { /* runtime may already be closing */ }
    process.exit(0);
  };

  const handle = startMcpStdio({
    services: runtime.services,
    actor: runtime.actor,
    activityTracker: runtime.activityTracker,
    codexToolsEnabled: runtime.codexToolsEnabled,
    ponytailModeProvider: () => runtime.ponytailMode,
    profileProvider: runtime.profileProvider,
    authorizationModeProvider: (): 'standard' | 'full_bypass' => stdioFullBypassAll ? 'full_bypass' : 'standard',
    invocationGuardProvider,
    allowAiDeleteProvider: runtime.allowAiDeleteProvider,
    destructivePolicyProvider: runtime.destructivePolicyProvider,
    activeWorkspaceScopeProvider: runtime.activeWorkspaceScopeProvider,
    toolAvailabilitySnapshotProvider: () => runtime.toolAvailabilityService.snapshot(),
    toolAvailabilitySubscribe: (listener) => runtime.toolAvailabilityService.subscribe(listener),
    onError: (error): void => {
      if (/EPIPE|ECONNRESET|broken pipe/i.test(error.message)) {
        process.stderr.write(`lnwjud MCP stdio: peer closed (${error.message})\n`);
        void shutdown();
        return;
      }
      process.stderr.write(`lnwjud MCP stdio error: ${error.message}\n`);
    },
  });

  process.stdin.on('end', () => { void shutdown(); });
  process.stdin.on('close', () => { void shutdown(); });
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE' || error.code === 'ECONNRESET') void shutdown();
  });
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

function comparableWorkspaceRoot(value: string): string | null {
  return comparableHostPath(normalizeWorkspaceRoot(value, process.platform), process.platform);
}

main().catch((error: unknown) => {
  process.stderr.write(`lnwjud MCP stdio failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exit(1);
});
