import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';

export class StrictWorkspaceRepository implements WorkspaceRepository {
  private readonly allowed = new Set<string>();

  public constructor(private readonly inner: WorkspaceRepository, allowedCanonicalRoots: readonly string[]) {
    for (const root of allowedCanonicalRoots) this.allowed.add(normalize(root));
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
    return this.allowed.has(normalize(workspace.realRootPath)) || this.allowed.has(normalize(workspace.rootPath));
  }
}

export async function canonicalizeAllowedRoots(roots: readonly string[]): Promise<readonly string[]> {
  if (roots.length === 0) throw new Error('Strict root mode requires at least one explicit --allowed-root or LNWJUD_ALLOWED_ROOTS entry');
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const input of roots) {
    const resolved = path.resolve(input);
    let actual: string;
    try {
      if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory');
      actual = await realpath(resolved);
    } catch {
      throw new Error(`Strict allowed root was not found or is not a directory: ${input}`);
    }
    const key = normalize(actual);
    if (seen.has(key)) continue;
    seen.add(key);
    canonical.push(actual);
  }
  if (canonical.length === 0) throw new Error('Strict root mode has no usable allowed roots');
  return canonical;
}

export async function requestedPathInsideAllowedRoot(requestedPath: string, allowedCanonicalRoots: readonly string[]): Promise<string> {
  let requestedCanonical: string;
  try {
    requestedCanonical = await realpath(path.resolve(requestedPath));
  } catch {
    throw new Error(`Workspace path does not exist: ${requestedPath}`);
  }
  const matches = allowedCanonicalRoots.filter((root) => isWithin(root, requestedCanonical));
  if (matches.length === 0) throw new Error(`Workspace path is outside strict allowed roots: ${requestedPath}`);
  matches.sort((left, right) => right.length - left.length);
  return matches[0]!;
}

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(path.sep);
  return firstSegment !== '..';
}
