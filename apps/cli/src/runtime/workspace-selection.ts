import path from 'node:path';

export interface RequestedWorkspacePathOptions {
  readonly requestedPath?: string;
  readonly strictAllowedRoots?: readonly string[];
  readonly registeredProjectPaths: readonly string[];
}

/** Resolve only user/configuration-selected projects; never infer a drive root. */
export function resolveRequestedWorkspacePath(options: RequestedWorkspacePathOptions): string | null {
  const requested = options.requestedPath?.trim();
  if (requested !== undefined && requested.length > 0) return path.resolve(requested);

  const fallback = options.strictAllowedRoots?.[0] ?? options.registeredProjectPaths[0];
  return fallback === undefined ? null : path.resolve(fallback);
}
