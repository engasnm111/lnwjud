import { realpath, stat } from 'node:fs/promises';
import { isHostPathWithin, isPosixMountRoot, resolveHostPath, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';

export class StrictWorkspaceRepository implements WorkspaceRepository {
  private readonly allowed = new Set<string>();

  public constructor(
    private readonly inner: WorkspaceRepository,
    allowedCanonicalRoots: readonly string[],
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    for (const root of allowedCanonicalRoots) {
      const normalized = normalize(root, this.platform);
      if (normalized !== null) this.allowed.add(normalized);
    }
  }

  public async list(): Promise<Workspace[]> {
    return (await this.inner.list()).filter((workspace) => this.isAllowed(workspace));
  }

  public async get(id: string): Promise<Workspace | null> {
    const workspace = await this.inner.get(id);
    return workspace !== null && this.isAllowed(workspace) ? workspace : null;
  }

  public async insert(workspace: Workspace): Promise<void> {
    if (!this.isAllowed(workspace)) throw new Error('Strict workspace repository rejected a root outside the explicit allowlist');
    await this.inner.insert(workspace);
  }

  public async delete(id: string): Promise<void> {
    const workspace = await this.get(id);
    if (workspace === null) return;
    await this.inner.delete(id);
  }

  private isAllowed(workspace: Workspace): boolean {
    const realRoot = normalize(workspace.realRootPath, this.platform);
    const root = normalize(workspace.rootPath, this.platform);
    return (realRoot !== null && this.allowed.has(realRoot)) || (root !== null && this.allowed.has(root));
  }
}

export async function canonicalizeAllowedRoots(roots: readonly string[], platform: NodeJS.Platform = process.platform): Promise<readonly string[]> {
  if (roots.length === 0) throw new Error('Strict root mode requires at least one explicit --allowed-root or LNWJUD_ALLOWED_ROOTS entry');
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const input of roots) {
    const resolved = resolveHostPath(input, platform);
    if (resolved === null) throw new Error(`Strict allowed root uses a foreign host path syntax: ${input}`);
    if (isPosixMountRoot(resolved, platform)) throw new Error(`Strict allowed root must be a project directory, not a POSIX mount root: ${input}`);
    let actual: string;
    try {
      if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory');
      actual = await realpath(resolved);
    } catch {
      throw new Error(`Strict allowed root was not found or is not a directory: ${input}`);
    }
    const key = normalize(actual, platform);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    canonical.push(actual);
  }
  if (canonical.length === 0) throw new Error('Strict root mode has no usable allowed roots');
  return canonical;
}

export async function requestedPathInsideAllowedRoot(requestedPath: string, allowedCanonicalRoots: readonly string[], platform: NodeJS.Platform = process.platform): Promise<string> {
  let requestedCanonical: string;
  try {
    const resolved = resolveHostPath(requestedPath, platform);
    if (resolved === null) throw new Error('foreign path');
    requestedCanonical = await realpath(resolved);
  } catch {
    throw new Error(`Workspace path does not exist: ${requestedPath}`);
  }
  const matches = allowedCanonicalRoots.filter((root) => isHostPathWithin(root, requestedCanonical, platform));
  if (matches.length === 0) throw new Error(`Workspace path is outside strict allowed roots: ${requestedPath}`);
  matches.sort((left, right) => right.length - left.length);
  return matches[0]!;
}

function normalize(value: string, platform: NodeJS.Platform): string | null {
  const resolved = resolveHostPath(value, platform);
  if (resolved === null) return null;
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}
