export type AddWorkspaceAction = (rootPath: string) => Promise<boolean>;

/** Keep the typed path on every handled failure; clear it only after success. */
export async function settleWorkspaceAdd(rootPath: string, add: AddWorkspaceAction): Promise<string> {
  try {
    return await add(rootPath) ? '' : rootPath;
  } catch {
    return rootPath;
  }
}
