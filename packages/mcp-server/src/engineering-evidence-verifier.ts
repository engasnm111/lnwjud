import type { EngineeringDeliveryObservationProvider } from './engineering-delivery-observations.js';
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { observeSourceSnapshot, type EngineeringGateEvidenceVerifier } from '@lnwjud/application';
import type { EngineeringDeliveryContract, EngineeringGateEvidence, Result } from '@lnwjud/domain';
import { engineeringCommandFingerprint, formatEngineeringCommand } from '@lnwjud/shared';

interface EngineeringEvidenceStatusProvider {
  statusForGoalLiveness(workspaceId: string, taskId: string): Result<unknown> | Promise<Result<unknown>>;
  /** Explicit bounded terminal proof, not used during polling. */
  statusForGoalEvidence?(workspaceId: string, taskId: string): Result<unknown> | Promise<Result<unknown>>;
}

export interface EngineeringSourceState {
  readonly commit: string;
  readonly clean: boolean;
}

export interface EngineeringGithubJobEvidence {
  readonly runId: string;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly labels: readonly string[];
}

export interface EngineeringGithubJobsEvidence {
  readonly runId: string;
  readonly jobs: readonly EngineeringGithubJobEvidence[];
}

export type EngineeringGithubJobsProvider = (
  workspaceId: string,
  runId: string,
) => EngineeringGithubJobsEvidence | undefined | Promise<EngineeringGithubJobsEvidence | undefined>;

export type EngineeringGithubCommandRunner = (
  workspaceRoot: string,
  args: readonly string[],
) => Promise<string>;

const GITHUB_JOBS_PAGE_SIZE = 100;
const MAX_GITHUB_JOBS = 1_000;
const MAX_GITHUB_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;

interface EngineeringGitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

type EngineeringGitRunner = (
  workspaceId: string,
  args: readonly string[],
) => Result<EngineeringGitCommandResult> | Promise<Result<EngineeringGitCommandResult>>;

export function createEngineeringSourceStateProvider(runGit: EngineeringGitRunner): (workspaceId: string) => Promise<EngineeringSourceState | undefined> {
  return async (workspaceId: string): Promise<EngineeringSourceState | undefined> => {
    try {
      const [commitResult, statusResult] = await Promise.all([
        runGit(workspaceId, ['rev-parse', 'HEAD']),
        runGit(workspaceId, ['status', '--porcelain=v1', '--untracked-files=all']),
      ]);
      if (!commitResult.ok || !statusResult.ok || commitResult.value.exitCode !== 0 || statusResult.value.exitCode !== 0) return undefined;
      const commit = commitResult.value.stdout.trim();
      if (!/^[0-9a-f]{40}$/i.test(commit)) return undefined;
      return { commit, clean: statusResult.value.stdout.trim().length === 0 };
    } catch {
      return undefined;
    }
  };
}

export function createEngineeringGithubJobsProvider(
  resolveWorkspaceRoot: (workspaceId: string) => string | undefined | Promise<string | undefined>,
  runCommand: EngineeringGithubCommandRunner = runEngineeringGithubCommand,
): EngineeringGithubJobsProvider {
  return async (workspaceId, runId): Promise<EngineeringGithubJobsEvidence | undefined> => {
    if (!/^[1-9]\d{0,15}$/.test(runId) || !Number.isSafeInteger(Number(runId))) return undefined;
    try {
      const workspaceRoot = await resolveWorkspaceRoot(workspaceId);
      if (workspaceRoot === undefined || !isAbsolute(workspaceRoot)) return undefined;
      const repositoryOutput = await runCommand(workspaceRoot, ['repo', 'view', '--json', 'nameWithOwner']);
      const repository = parseGithubRepository(repositoryOutput);
      if (repository === undefined) return undefined;

      const jobs: EngineeringGithubJobEvidence[] = [];
      let totalCount: number | undefined;
      const pages = Math.ceil(MAX_GITHUB_JOBS / GITHUB_JOBS_PAGE_SIZE);
      for (let page = 1; page <= pages; page += 1) {
        const output = await runCommand(workspaceRoot, [
          'api',
          `repos/${repository}/actions/runs/${runId}/jobs?per_page=${GITHUB_JOBS_PAGE_SIZE}&page=${page}`,
        ]);
        const result = parseGithubJobsPage(output);
        if (result === undefined || result.totalCount > MAX_GITHUB_JOBS
          || (totalCount !== undefined && result.totalCount !== totalCount)) return undefined;
        totalCount = result.totalCount;
        if (totalCount === 0) return result.jobs.length === 0 ? { runId, jobs } : undefined;
        const expectedOnPage = Math.min(GITHUB_JOBS_PAGE_SIZE, totalCount - jobs.length);
        if (expectedOnPage <= 0 || result.jobs.length !== expectedOnPage) return undefined;
        for (const rawJob of result.jobs) {
          const job = parseGithubJob(rawJob);
          if (job === undefined || job.runId !== runId) return undefined;
          jobs.push(job);
        }
        if (jobs.length === totalCount) return { runId, jobs };
      }
      return totalCount === 0 ? { runId, jobs } : undefined;
    } catch {
      return undefined;
    }
  };
}

async function runEngineeringGithubCommand(workspaceRoot: string, args: readonly string[]): Promise<string> {
  const executable = process.platform === 'win32' ? 'gh.exe' : 'gh';
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(executable, [...args], {
      cwd: workspaceRoot,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: MAX_GITHUB_COMMAND_OUTPUT_BYTES,
      encoding: 'utf8',
    }, (error, stdout) => {
      if (error !== null) rejectOutput(error);
      else resolveOutput(stdout);
    });
  });
}

function parseGithubRepository(output: string): string | undefined {
  try {
    const value: unknown = JSON.parse(output.trim());
    if (!isRecord(value) || typeof value.nameWithOwner !== 'string'
      || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(value.nameWithOwner)) return undefined;
    return value.nameWithOwner;
  } catch {
    return undefined;
  }
}

function parseGithubJobsPage(output: string): { readonly totalCount: number; readonly jobs: readonly unknown[] } | undefined {
  try {
    const value: unknown = JSON.parse(output.trim());
    if (!isRecord(value) || !Number.isSafeInteger(value.total_count) || typeof value.total_count !== 'number'
      || value.total_count < 0 || !Array.isArray(value.jobs)) return undefined;
    return { totalCount: value.total_count, jobs: value.jobs };
  } catch {
    return undefined;
  }
}

function parseGithubJob(value: unknown): EngineeringGithubJobEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const runId = typeof value.run_id === 'number' && Number.isSafeInteger(value.run_id)
    ? String(value.run_id)
    : typeof value.run_id === 'string' && /^[1-9]\d{0,15}$/.test(value.run_id) ? value.run_id : undefined;
  if (runId === undefined || typeof value.head_sha !== 'string' || !/^[0-9a-f]{40}$/i.test(value.head_sha)
    || typeof value.status !== 'string' || (value.conclusion !== null && typeof value.conclusion !== 'string')
    || !Array.isArray(value.labels) || value.labels.some((label) => typeof label !== 'string')) return undefined;
  return {
    runId,
    headSha: value.head_sha,
    status: value.status,
    conclusion: value.conclusion,
    labels: value.labels,
  };
}

export interface EngineeringArtifactObservation {
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export type EngineeringArtifactVerifier = (
  workspaceId: string,
  artifact: string,
  observation: EngineeringArtifactObservation,
) => boolean | Promise<boolean>;

export function createEngineeringArtifactVerifier(
  resolveWorkspaceRoot: (workspaceId: string) => string | undefined | Promise<string | undefined>,
): EngineeringArtifactVerifier {
  return async (workspaceId, artifact, observation) => {
    if (artifact.length === 0 || isAbsolute(artifact)) return false;
    const startedAt = Date.parse(observation.startedAt);
    const finishedAt = observation.finishedAt === undefined ? undefined : Date.parse(observation.finishedAt);
    if (Number.isNaN(startedAt) || (finishedAt !== undefined && Number.isNaN(finishedAt))) return false;
    try {
      const configuredRoot = await resolveWorkspaceRoot(workspaceId);
      if (configuredRoot === undefined) return false;
      const root = await realpath(configuredRoot);
      const candidate = await realpath(resolve(root, artifact));
      const contained = relative(root, candidate);
      if (contained.length === 0 || contained === '..' || contained.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(contained)) return false;
      const file = await stat(candidate);
      if (!file.isFile() || file.size <= 0) return false;
      const toleranceMs = 2_000;
      if (file.mtimeMs < startedAt - toleranceMs) return false;
      return finishedAt === undefined || file.mtimeMs <= finishedAt + toleranceMs;
    } catch {
      return false;
    }
  };
}

export interface RuntimeEngineeringEvidenceVerifierOptions {
  readonly workspaceRoot?: (workspaceId: string) => string | undefined | Promise<string | undefined>;
  readonly deliveryObservations?: readonly EngineeringDeliveryObservationProvider[];
  readonly githubJobs?: EngineeringGithubJobsProvider;
  readonly process?: EngineeringEvidenceStatusProvider;
  readonly shell?: EngineeringEvidenceStatusProvider;
  readonly sourceState?: (workspaceId: string) => Promise<EngineeringSourceState | undefined>;
  readonly artifactVerifier?: EngineeringArtifactVerifier;
}

/**
 * Verifies a claimed host-observed gate against an actual host-owned task.
 * The caller still records the human-readable command in resumeContext, while
 * this verifier prevents a client/model from inventing a successful run ID.
 */
export class RuntimeEngineeringEvidenceVerifier implements EngineeringGateEvidenceVerifier {
  private readonly providers: readonly EngineeringEvidenceStatusProvider[];
  private readonly sourceState: RuntimeEngineeringEvidenceVerifierOptions['sourceState'];
  private readonly artifactVerifier: RuntimeEngineeringEvidenceVerifierOptions['artifactVerifier'];

  public constructor(private readonly options: RuntimeEngineeringEvidenceVerifierOptions) {
    this.providers = [options.process, options.shell]
      .filter((provider): provider is EngineeringEvidenceStatusProvider => provider !== undefined);
    this.sourceState = options.sourceState;
    this.artifactVerifier = options.artifactVerifier;
  }

  public async verify(
    workspaceId: string,
    evidence: EngineeringGateEvidence,
    gateId: string,
    requiredPlatforms: readonly ('win32' | 'darwin' | 'linux')[] = [],
    contract?: EngineeringDeliveryContract,
  ): Promise<boolean> {
    if (contract !== undefined) {
      if (contract.sourceDigest === undefined || evidence.sourceDigest !== contract.sourceDigest || evidence.contractDigest !== contract.digest) return false;
      const root = await this.options.workspaceRoot?.(workspaceId);
      if (root === undefined) return false;
      const source = await observeSourceSnapshot(root);
      if (source.state !== 'present' || source.value.digest !== contract.sourceDigest) return false;
      if (gateId === 'source_identity') return true;
      if (gateId === 'package' || gateId === 'deployment') {
        for (const provider of this.options.deliveryObservations ?? []) {
          if (await provider.verify({ workspaceId, gateId, contract, evidence })) return true;
        }
        return false;
      }
    }
    const runId = evidence.runId;
    const command = evidence.command;
    if (runId === undefined || command === undefined || this.providers.length === 0) return false;
    if ((gateId === 'exact_sha_ci' || gateId === 'package' || gateId === 'cross_platform')
      && !(await this.matchesCurrentTrackedSource(workspaceId, evidence))) return false;
    let workflowRunId: string | undefined;
    let workflowJobs: EngineeringGithubJobsEvidence | undefined;
    if (gateId === 'cross_platform') {
      workflowRunId = parseCanonicalGithubWorkflowRunId(command);
      if (workflowRunId === undefined || this.options.githubJobs === undefined) return false;
      try {
        workflowJobs = await this.options.githubJobs(workspaceId, workflowRunId);
      } catch {
        return false;
      }
      if (workflowJobs === undefined || workflowJobs.runId !== workflowRunId) return false;
    }
    const results = await Promise.all(this.providers.map(async (provider) => {
      try {
        const needsOutput = gateId === 'exact_sha_ci' || gateId === 'cross_platform'
          || (gateId === 'package' && evidence.command?.includes('verify-release-evidence.mjs'));
        const result = await (needsOutput && provider.statusForGoalEvidence !== undefined
          ? provider.statusForGoalEvidence(workspaceId, runId)
          : provider.statusForGoalLiveness(workspaceId, runId));
        if (!successfulObservation(result, command, evidence.exitCode)) return false;
        if (gateId === 'exact_sha_ci') return exactShaCiObservation(result, evidence);
        if (gateId === 'package') return packageObservation(workspaceId, result, evidence, this.artifactVerifier);
        if (gateId === 'cross_platform' && workflowRunId !== undefined && workflowJobs !== undefined) {
          return crossPlatformObservation(result, evidence, requiredPlatforms, workflowRunId, workflowJobs);
        }
        return true;
      } catch {
        return false;
      }
    }));
    return results.some(Boolean);
  }

  private async matchesCurrentTrackedSource(workspaceId: string, evidence: EngineeringGateEvidence): Promise<boolean> {
    if (this.sourceState === undefined || typeof evidence.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(evidence.commit)) return false;
    try {
      const current = await this.sourceState(workspaceId);
      return current !== undefined
        && current.clean
        && /^[0-9a-f]{40}$/i.test(current.commit)
        && current.commit.toLowerCase() === evidence.commit.toLowerCase();
    } catch {
      return false;
    }
  }
}

function successfulObservation(result: Result<unknown>, claimedCommand: string, expectedExitCode: number | undefined): boolean {
  if (!result.ok || !isRecord(result.value) || typeof result.value.state !== 'string') return false;
  if (result.value.state !== 'completed' && result.value.state !== 'exited') return false;
  const actualExitCode = typeof result.value.exit_code === 'number'
    ? result.value.exit_code
    : typeof result.value.exitCode === 'number'
      ? result.value.exitCode
      : undefined;
  if (actualExitCode !== 0) return false;
  const actualCommand = typeof result.value.executable === 'string' && Array.isArray(result.value.args) && result.value.args.every((arg) => typeof arg === 'string')
    ? formatEngineeringCommand(result.value.executable, result.value.args as string[])
    : typeof result.value.executable === 'string' && Array.isArray(result.value.arguments) && result.value.arguments.every((arg) => typeof arg === 'string')
      ? formatEngineeringCommand(result.value.executable, result.value.arguments as string[])
      : undefined;
  const matches = actualCommand === claimedCommand
    || result.value.command_fingerprint === engineeringCommandFingerprint(claimedCommand);
  if (!matches) return false;
  return expectedExitCode === undefined || expectedExitCode === actualExitCode;
}

function exactShaCiObservation(result: Result<unknown>, evidence: EngineeringGateEvidence): boolean {
  if (!result.ok || !isRecord(result.value) || typeof evidence.command !== 'string'
    || !isCanonicalClaimedCommand(evidence.command, /^gh(?:\.exe)?$/i, ['run', 'view'], ['--json', 'headSha,status,conclusion'])) return false;
  if (typeof evidence.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(evidence.commit) || evidence.conclusion !== 'success') return false;
  if (typeof result.value.stdout !== 'string') return false;
  try {
    const output: unknown = JSON.parse(result.value.stdout.trim());
    return isRecord(output)
      && output.status === 'completed'
      && output.conclusion === 'success'
      && typeof output.headSha === 'string'
      && output.headSha.toLowerCase() === evidence.commit.toLowerCase();
  } catch {
    return false;
  }
}

function crossPlatformObservation(
  result: Result<unknown>,
  evidence: EngineeringGateEvidence,
  requiredPlatforms: readonly ('win32' | 'darwin' | 'linux')[],
  workflowRunId: string,
  workflowJobs: EngineeringGithubJobsEvidence,
): boolean {
  if (!result.ok || !isRecord(result.value) || typeof evidence.command !== 'string'
    || !isCanonicalClaimedCommand(evidence.command, /^gh(?:\.exe)?$/i, ['run', 'view'], ['--json', 'headSha,status,conclusion,jobs'])) return false;
  if (typeof evidence.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(evidence.commit) || evidence.conclusion !== 'success') return false;
  if (typeof result.value.stdout !== 'string') return false;
  try {
    const output: unknown = JSON.parse(result.value.stdout.trim());
    if (!isRecord(output)
      || output.status !== 'completed'
      || output.conclusion !== 'success'
      || typeof output.headSha !== 'string'
      || output.headSha.toLowerCase() !== evidence.commit.toLowerCase()) return false;
    if (workflowJobs.runId !== workflowRunId || !Array.isArray(workflowJobs.jobs)) return false;
    const targets = requiredPlatforms.length > 0 ? requiredPlatforms : ['win32', 'darwin', 'linux'] as const;
    const commit = evidence.commit;
    if (typeof commit !== 'string') return false;
    return targets.every((platform) => workflowJobs.jobs.some((job) => successfulPlatformContractJob(job, platform, workflowRunId, commit)));
  } catch {
    return false;
  }
}

function successfulPlatformContractJob(
  value: unknown,
  platform: 'win32' | 'darwin' | 'linux',
  workflowRunId: string,
  commit: string,
): boolean {
  if (!isRecord(value) || value.runId !== workflowRunId || typeof value.headSha !== 'string'
    || value.headSha.toLowerCase() !== commit.toLowerCase()
    || value.status !== 'completed' || value.conclusion !== 'success'
    || !Array.isArray(value.labels) || value.labels.some((label) => typeof label !== 'string')) return false;
  const labels = value.labels.map((label) => label.toLowerCase());
  const platformLabel = platform === 'win32' ? /^(windows|windows-latest|windows-\d+)$/ : platform === 'darwin' ? /^(macos|macos-latest|macos-\d+|macos-\d+-arm64)$/ : /^(linux|ubuntu-latest|ubuntu-\d+\.\d+)$/;
  return labels.some((label) => platformLabel.test(label));
}

function parseCanonicalGithubWorkflowRunId(command: string): string | undefined {
  if (!isCanonicalClaimedCommand(command, /^gh(?:\.exe)?$/i, ['run', 'view'], ['--json', 'headSha,status,conclusion,jobs'])) return undefined;
  const parsed = parseFormattedEngineeringCommand(command);
  const runId = parsed?.args[2];
  return runId !== undefined && /^[1-9]\d{0,15}$/.test(runId) && Number.isSafeInteger(Number(runId)) ? runId : undefined;
}

async function packageObservation(
  workspaceId: string,
  result: Result<unknown>,
  evidence: EngineeringGateEvidence,
  artifactVerifier: EngineeringArtifactVerifier | undefined,
): Promise<boolean> {
  if (!result.ok || !isRecord(result.value) || typeof evidence.command !== 'string') return false;
  if (typeof evidence.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(evidence.commit)
    || typeof evidence.artifact !== 'string' || evidence.artifact.length === 0) return false;

  if (isCanonicalClaimedCommand(evidence.command, /^node(?:\.exe)?$/i, [], ['apps/desktop/scripts/verify-release-evidence.mjs'])) {
    if (typeof result.value.stdout !== 'string') return false;
    const match = /Release evidence verified for lnwjud (\S+) (win32|darwin|linux)\/(x64|arm64) commit ([0-9a-f]{40})/i.exec(result.value.stdout);
    if (match?.[4]?.toLowerCase() !== evidence.commit.toLowerCase()) return false;
    const artifactName = evidence.artifact.replace(/\\/g, '/').split('/').at(-1);
    const expectedNames = packageArtifactNames(match[2]?.toLowerCase(), match[1], match[3]?.toLowerCase());
    const normalizedArtifact = evidence.artifact.replace(/\\/g, '/');
    return artifactName !== undefined
      && expectedNames.includes(artifactName)
      && normalizedArtifact.endsWith(`apps/desktop/dist/installers/${artifactName}`);
  }

  if (artifactVerifier === undefined || !isPackageArtifactPath(evidence.artifact)) return false;
  const startedAt = typeof result.value.started_at === 'string' ? result.value.started_at : undefined;
  const finishedAt = typeof result.value.finished_at === 'string' ? result.value.finished_at : undefined;
  if (startedAt === undefined || Number.isNaN(Date.parse(startedAt)) || (finishedAt !== undefined && Number.isNaN(Date.parse(finishedAt)))) return false;
  return artifactVerifier(workspaceId, evidence.artifact, {
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
  });
}

function isPackageArtifactPath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/').toLowerCase();
  return ['.exe', '.msi', '.msix', '.zip', '.tar.gz', '.tgz', '.dmg', '.pkg', '.appimage', '.deb', '.rpm', '.apk', '.aab', '.ipa', '.jar', '.war', '.nupkg']
    .some((suffix) => normalized.endsWith(suffix));
}

function packageArtifactNames(platform: string | undefined, version: string | undefined, arch: string | undefined): readonly string[] {
  if (version === undefined || (arch !== 'x64' && arch !== 'arm64')) return [];
  if (platform === 'win32') return [`lnwjud-Setup-${version}.exe`, `lnwjud-Portable-${version}.exe`];
  if (platform === 'darwin') return [`lnwjud-${version}-${arch}.dmg`, `lnwjud-${version}-${arch}.zip`];
  if (platform === 'linux') return [`lnwjud-${version}-${arch}.AppImage`, `lnwjud-${version}-${arch}.deb`];
  return [];
}

function isCanonicalClaimedCommand(command: string, executablePattern: RegExp, prefixArgs: readonly string[], suffixArgs: readonly string[]): boolean {
  const parts = parseFormattedEngineeringCommand(command);
  if (parts === undefined || !executablePattern.test(parts.executable.split(/[\\/]/).at(-1) ?? '')) return false;
  const { args } = parts;
  if (args.length !== prefixArgs.length + suffixArgs.length + (prefixArgs.length > 0 ? 1 : 0)) return false;
  if (!prefixArgs.every((arg, index) => args[index] === arg)) return false;
  if (prefixArgs.length > 0 && !/^\d+$/.test(args[prefixArgs.length] ?? '')) return false;
  return suffixArgs.every((arg, index) => args[args.length - suffixArgs.length + index] === arg);
}

function parseFormattedEngineeringCommand(command: string): { readonly executable: string; readonly args: readonly string[] } | undefined {
  const parts: string[] = [];
  let offset = 0;
  while (offset < command.length) {
    let part: string;
    if (command[offset] === '"') {
      let end = offset + 1;
      let escaped = false;
      for (; end < command.length; end += 1) {
        const character = command[end];
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') break;
      }
      if (end >= command.length || command[end] !== '"') return undefined;
      try {
        const parsed: unknown = JSON.parse(command.slice(offset, end + 1));
        if (typeof parsed !== 'string') return undefined;
        part = parsed;
      } catch {
        return undefined;
      }
      offset = end + 1;
    } else {
      let end = command.indexOf(' ', offset);
      if (end < 0) end = command.length;
      part = command.slice(offset, end);
      if (!/^[A-Za-z0-9_./:@+\\-]+$/.test(part)) return undefined;
      offset = end;
    }
    parts.push(part);
    if (offset === command.length) break;
    if (command[offset] !== ' ' || offset + 1 >= command.length || command[offset + 1] === ' ') return undefined;
    offset += 1;
  }
  const executable = parts[0];
  return executable === undefined ? undefined : { executable, args: parts.slice(1) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
