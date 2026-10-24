export type ContainmentPlatform = 'win32' | 'darwin' | 'linux';

export interface ContainmentArtifactIdentity {
  readonly filename: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ContainmentArtifactEvidence {
  readonly runtime: ContainmentArtifactIdentity;
  readonly helper?: ContainmentArtifactIdentity;
  readonly pin?: ContainmentArtifactIdentity;
}

export interface ContainmentRuntimeEntry {
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export function verifyContainmentArtifacts(input: {
  readonly directory: string;
  readonly compiledBundlePath: string;
  readonly platform: ContainmentPlatform;
}): Promise<ContainmentArtifactEvidence>;

export function validateContainmentEvidence(
  containment: unknown,
  files: readonly ContainmentRuntimeEntry[],
  platform: ContainmentPlatform,
): ContainmentArtifactEvidence;
