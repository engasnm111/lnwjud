import { resolveHostPath } from '@lnwjud/workspace';

export interface RequestedWorkspacePathOptions {
  readonly requestedPath?: string;
  readonly strictAllowedRoots?: readonly string[];
  readonly registeredProjectPaths: readonly string[];
  readonly platform?: NodeJS.Platform;
}

/** Resolve only user/configuration-selected projects; never infer a drive root. */
export function resolveRequestedWorkspacePath(options: RequestedWorkspacePathOptions): string | null {
  const platform = options.platform ?? process.platform;
  const requested = options.requestedPath?.trim();
  if (requested !== undefined && requested.length > 0) return resolveHostPath(requested, platform);

  const fallback = options.strictAllowedRoots?.[0] ?? options.registeredProjectPaths[0];
  return fallback === undefined ? null : resolveHostPath(fallback, platform);
}
