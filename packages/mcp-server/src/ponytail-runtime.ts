import type { ResolvedPonytailPolicy } from '@lnwjud/shared';

export const BUNDLED_PONYTAIL_SKILL_ID = 'bundled:agent-skills/ponytail';
export const BUNDLED_PONYTAIL_REVIEW_SKILL_ID = 'bundled:agent-skills/ponytail-review';

export interface PonytailActivationContext {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly goalId?: string;
}

export interface PonytailActivationState {
  readonly policyFingerprint: string;
  readonly primarySkillLoaded: boolean;
  readonly primarySkillId?: string;
  readonly primaryLoadedAt?: string;
  readonly codeMutationGeneration: number;
  readonly reviewGeneration: number;
  readonly reviewSkillLoadedAtGeneration?: number;
  readonly sessionSuppressed: boolean;
}

export class PonytailActivationLedger {
  private readonly states = new Map<string, PonytailActivationState>();

  public state(context: PonytailActivationContext, policy: ResolvedPonytailPolicy): PonytailActivationState {
    const key = activationKey(context);
    const fingerprint = ponytailPolicyFingerprint(policy);
    const existing = this.states.get(key);
    if (existing?.policyFingerprint === fingerprint) return existing;
    const fresh: PonytailActivationState = {
      policyFingerprint: fingerprint,
      primarySkillLoaded: false,
      codeMutationGeneration: 0,
      reviewGeneration: 0,
      sessionSuppressed: existing?.sessionSuppressed ?? false,
    };
    this.states.set(key, fresh);
    return fresh;
  }

  public markPrimaryLoaded(
    context: PonytailActivationContext,
    policy: ResolvedPonytailPolicy,
    skillId: string,
    loadedAt = new Date().toISOString(),
  ): PonytailActivationState {
    const current = this.state(context, policy);
    if (skillId !== BUNDLED_PONYTAIL_SKILL_ID) return current;
    return this.replace(context, {
      ...current,
      primarySkillLoaded: true,
      primarySkillId: skillId,
      primaryLoadedAt: loadedAt,
    });
  }

  public markReviewSkillLoaded(
    context: PonytailActivationContext,
    policy: ResolvedPonytailPolicy,
    skillId: string,
  ): PonytailActivationState {
    const current = this.state(context, policy);
    if (skillId !== BUNDLED_PONYTAIL_REVIEW_SKILL_ID) return current;
    return this.replace(context, {
      ...current,
      reviewSkillLoadedAtGeneration: current.codeMutationGeneration,
    });
  }

  public recordCodeMutation(context: PonytailActivationContext, policy: ResolvedPonytailPolicy): PonytailActivationState {
    const current = this.state(context, policy);
    return this.replace(context, {
      ...current,
      codeMutationGeneration: current.codeMutationGeneration + 1,
    });
  }

  public markReviewComplete(context: PonytailActivationContext, policy: ResolvedPonytailPolicy): PonytailActivationState {
    const current = this.state(context, policy);
    if (current.reviewSkillLoadedAtGeneration !== current.codeMutationGeneration) return current;
    return this.replace(context, {
      ...current,
      reviewGeneration: current.codeMutationGeneration,
    });
  }

  public setSessionSuppressed(context: PonytailActivationContext, policy: ResolvedPonytailPolicy, suppressed: boolean): PonytailActivationState {
    const current = this.state(context, policy);
    return this.replace(context, { ...current, sessionSuppressed: suppressed });
  }

  private replace(context: PonytailActivationContext, state: PonytailActivationState): PonytailActivationState {
    this.states.set(activationKey(context), state);
    return state;
  }
}

export function ponytailPolicyFingerprint(policy: ResolvedPonytailPolicy): string {
  return `${policy.source}:${policy.mode}`;
}

export function isCodingMutation(toolName: string, input: unknown): boolean {
  if (toolName === 'lsp_rename') return true;
  if (!isRecord(input)) return false;
  const paths: string[] = [];
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'delete_file' || toolName === 'restore_deleted_file') {
    pushPath(paths, input.path);
  } else if (toolName === 'move_file' || toolName === 'copy_file') {
    pushPath(paths, input.sourcePath);
    pushPath(paths, input.destinationPath);
  } else if (toolName === 'apply_patch') {
    if (Array.isArray(input.files)) {
      for (const entry of input.files) if (isRecord(entry)) pushPath(paths, entry.path);
    }
  } else {
    return false;
  }
  return paths.some(isDevelopmentArtifactPath);
}

export function isDevelopmentArtifactPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/').toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const codeExtensions = [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.kts', '.cs',
    '.c', '.cc', '.cpp', '.h', '.hpp', '.swift', '.rb', '.php', '.vue', '.svelte', '.sql', '.proto', '.graphql', '.gql',
  ];
  if (codeExtensions.some((extension) => basename.endsWith(extension))) return true;
  if (basename === 'package.json' || basename === 'dockerfile' || basename === 'makefile' || basename === 'cargo.toml') return true;
  if (/^tsconfig(?:\.[^.]+)?\.json$/.test(basename)) return true;
  if (/^(?:vite|vitest|jest|eslint|prettier|webpack|rollup|babel|electron-builder|docker-compose)(?:\.config)?\.(?:js|cjs|mjs|ts|json|ya?ml|toml)$/.test(basename)) return true;
  if (/^[^.]+\.config\.(?:js|cjs|mjs|ts|json|ya?ml|toml)$/.test(basename)) return true;
  return false;
}

function activationKey(context: PonytailActivationContext): string {
  return `${context.sessionId}\u0000${context.workspaceId}\u0000${context.goalId ?? ''}`;
}

function pushPath(target: string[], value: unknown): void {
  if (typeof value === 'string' && value.trim().length > 0) target.push(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
