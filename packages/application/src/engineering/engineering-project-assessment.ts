import { createHash } from 'node:crypto';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ProjectDetector, type ProjectProfile } from '@lnwjud/project';
import { normalizeProjectProfile } from '@lnwjud/shared';

const AGENTS_MAX_BYTES = 64 * 1024;
const PROFILE_MAX_BYTES = 128 * 1024;
const MAX_AGENT_SCOPES = 16;

export type EngineeringInstructionStatus = 'loaded' | 'missing' | 'unreadable' | 'truncated';
export type EngineeringProjectProfileStatus = 'loaded' | 'missing' | 'unreadable' | 'truncated' | 'invalid';

export interface EngineeringInstructionFile {
  readonly path: string;
  readonly scopePath: string;
  readonly status: EngineeringInstructionStatus;
  readonly bytes: number;
  readonly freshness?: string;
  readonly content?: string;
}

export interface EngineeringProjectAssessment {
  readonly project: ProjectProfile;
  readonly instructions: readonly EngineeringInstructionFile[];
  readonly projectProfile: Readonly<Record<string, unknown>>;
  readonly projectProfileStatus: EngineeringProjectProfileStatus;
  readonly projectProfileFreshness?: string;
  readonly fingerprint: string;
  readonly codeGraphIndexed?: boolean;
  readonly warnings: readonly string[];
}

export class EngineeringProjectAssessmentService {
  public constructor(private readonly detector: ProjectDetector = new ProjectDetector()) {}

  public async assess(rootPath: string, scopedPath?: string): Promise<EngineeringProjectAssessment> {
    const detected = await this.detector.detect(rootPath);
    if (!detected.ok) throw new Error(detected.error.message);

    const warnings: string[] = [];
    const codeGraphIndexed = await hasCodeGraphIndex(rootPath);
    const instructionCandidates = await this.agentInstructionCandidates(rootPath, scopedPath);
    const instructions = await Promise.all(instructionCandidates.map(async ({ filePath, scopePath }) => {
      const result = await readBoundedText(filePath, AGENTS_MAX_BYTES, rootPath);
      if (result.status === 'truncated') warnings.push(`${relativeSlash(rootPath, filePath)} exceeds ${AGENTS_MAX_BYTES} bytes and was truncated.`);
      if (result.status === 'unreadable') warnings.push(`${relativeSlash(rootPath, filePath)} could not be read.`);
      return {
        path: relativeSlash(rootPath, filePath),
        scopePath: relativeSlash(rootPath, scopePath) || '.',
        status: result.status,
        bytes: result.bytes,
        ...(result.freshness === undefined ? {} : { freshness: result.freshness }),
        ...(result.content === undefined ? {} : { content: result.content }),
      } satisfies EngineeringInstructionFile;
    }));

    const projectProfilePath = path.join(rootPath, '.lnwjud', 'project-profile.json');
    const rawProfile = await readBoundedText(projectProfilePath, PROFILE_MAX_BYTES, rootPath);
    let projectProfile: Readonly<Record<string, unknown>> = {};
    let projectProfileStatus: EngineeringProjectProfileStatus = rawProfile.status;
    if (rawProfile.status === 'loaded') {
      try {
        const parsed = JSON.parse(rawProfile.content ?? '') as unknown;
        if (!isRecord(parsed)) throw new Error('Project profile must contain a JSON object');
        projectProfile = normalizeProjectProfile(parsed);
      } catch (error) {
        projectProfileStatus = 'invalid';
        warnings.push(error instanceof Error ? error.message : 'Project profile is invalid.');
      }
    } else if (rawProfile.status === 'truncated') {
      warnings.push(`.lnwjud/project-profile.json exceeds ${PROFILE_MAX_BYTES} bytes and is ignored.`);
    } else if (rawProfile.status === 'unreadable') {
      warnings.push('.lnwjud/project-profile.json could not be read.');
    }

    const fingerprint = createHash('sha256').update(JSON.stringify({
      project: {
        kind: detected.value.kind,
        confidence: detected.value.confidence,
        detectedFiles: detected.value.detectedFiles,
        platforms: detected.value.platforms,
      },
      instructions: instructions.map((entry) => ({ path: entry.path, status: entry.status, freshness: entry.freshness ?? null })),
      projectProfileStatus,
      projectProfileFreshness: rawProfile.freshness ?? null,
      codeGraphIndexed,
    })).digest('hex');

    return {
      project: detected.value,
      instructions,
      projectProfile,
      projectProfileStatus,
      ...(rawProfile.freshness === undefined ? {} : { projectProfileFreshness: rawProfile.freshness }),
      fingerprint,
      codeGraphIndexed,
      warnings,
    };
  }

  private async agentInstructionCandidates(rootPath: string, scopedPath?: string): Promise<readonly { filePath: string; scopePath: string }[]> {
    const candidates: { filePath: string; scopePath: string }[] = [{ filePath: path.join(rootPath, 'AGENTS.md'), scopePath: rootPath }];
    if (scopedPath === undefined || scopedPath.trim().length === 0) return candidates;
    const realRoot = await realpath(rootPath);

    const absoluteTarget = path.resolve(rootPath, scopedPath);
    if (!pathContains(rootPath, absoluteTarget)) throw new Error('Scoped path escapes the project root');
    let targetDirectory = absoluteTarget;
    while (true) {
      try {
        const targetMetadata = await stat(targetDirectory);
        if (targetMetadata.isDirectory()) break;
        if (targetDirectory !== absoluteTarget) throw new Error('Scoped path traverses a file before reaching the target');
        targetDirectory = path.dirname(targetDirectory);
        break;
      } catch (error) {
        if (!isPathLookupMiss(error)) throw error;
        const parentDirectory = path.dirname(targetDirectory);
        if (parentDirectory === targetDirectory) {
          targetDirectory = rootPath;
          break;
        }
        targetDirectory = parentDirectory;
      }
    }
    const relativeDirectory = path.relative(rootPath, targetDirectory);
    if (relativeDirectory.length === 0) return candidates;

    const realTargetDirectory = await realpath(targetDirectory);
    if (!pathContains(realRoot, realTargetDirectory)) throw new Error('Scoped path escapes the project root through a symlink');
    // Evidence, project commands and Git operations all use the registered root.
    // A nested checkout must be registered as its own workspace to share that identity.
    for (let directory = realTargetDirectory; path.relative(realRoot, directory) !== ''; directory = path.dirname(directory)) {
      try {
        await lstat(path.join(directory, '.git'));
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      const relativeCheckout = relativeSlash(realRoot, directory);
      throw new Error(`Scoped path enters a separate Git checkout (${relativeCheckout}). Register that checkout root as its own workspace and prepare the task with that workspaceId.`);
    }

    let current = rootPath;
    for (const segment of relativeDirectory.split(path.sep).filter(Boolean).slice(0, MAX_AGENT_SCOPES - 1)) {
      current = path.join(current, segment);
      try {
        const realCurrent = await realpath(current);
        if (!pathContains(realRoot, realCurrent)) throw new Error('Scoped path escapes the project root through a symlink');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      candidates.push({ filePath: path.join(current, 'AGENTS.md'), scopePath: current });
    }
    return candidates;
  }
}

async function hasCodeGraphIndex(rootPath: string): Promise<boolean> {
  try {
    const [realRoot, realIndex] = await Promise.all([realpath(rootPath), realpath(path.join(rootPath, '.codegraph'))]);
    return pathContains(realRoot, realIndex) && (await stat(realIndex)).isDirectory();
  } catch {
    return false;
  }
}

interface BoundedTextResult {
  readonly status: EngineeringInstructionStatus;
  readonly bytes: number;
  readonly freshness?: string;
  readonly content?: string;
}

async function readBoundedText(filePath: string, maxBytes: number, rootPath: string): Promise<BoundedTextResult> {
  let metadata;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(rootPath), realpath(filePath)]);
    if (!pathContains(realRoot, realFile)) return { status: 'unreadable', bytes: 0 };
    metadata = await stat(realFile);
    filePath = realFile;
  } catch (error) {
    return isMissing(error) ? { status: 'missing', bytes: 0 } : { status: 'unreadable', bytes: 0 };
  }
  if (!metadata.isFile()) return { status: 'unreadable', bytes: 0 };

  let handle;
  try {
    handle = await open(filePath, 'r');
    const bytesToRead = Math.min(metadata.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    const freshness = `${metadata.size}:${Math.trunc(metadata.mtimeMs)}:${createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex')}`;
    return {
      status: metadata.size > maxBytes ? 'truncated' : 'loaded',
      bytes: metadata.size,
      freshness,
      content,
    };
  } catch {
    return { status: 'unreadable', bytes: metadata.size };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function relativeSlash(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).split(path.sep).join('/');
}

function pathContains(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative.length === 0 || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function isPathLookupMiss(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
