export interface UpdateWorkerIdentity { readonly filename: string; readonly sha256: string; readonly sizeBytes: number }
export function verifyUpdateWorkerArtifacts(input: { directory: string; compiledBundlePath: string }): Promise<UpdateWorkerIdentity>;
export function validateUpdateWorkerEvidence(identity: unknown, files: readonly { relativePath: string; sha256: string; sizeBytes: number }[], platform: string): UpdateWorkerIdentity | null;
