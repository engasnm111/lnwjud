import { observeEngineeringCapabilities } from './engineering-capabilities.js';
import { applyDeliveryContract } from './engineering-delivery-contract.js';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { DEFAULT_ENGINEERING_HARNESS_SETTINGS, type EngineeringHarnessSettings } from '@lnwjud/shared';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import { EngineeringProjectAssessmentService, type EngineeringProjectAssessment } from './engineering-project-assessment.js';
import { planEngineeringWorkflow, type EngineeringWorkflowPlan } from './engineering-workflow.js';
import {
  classifyEngineeringTaskScope,
  resolveEngineeringPolicy,
  type EffectiveEngineeringPolicy,
  type EngineeringWorkspaceOverride,
} from './engineering-policy.js';

export interface EngineeringPreparation {
  readonly objective: string;
  readonly assessment: EngineeringProjectAssessment;
  readonly policy: EffectiveEngineeringPolicy;
  readonly workflow: EngineeringWorkflowPlan;
}

export interface EngineeringPreparationServiceOptions {
  readonly globalSettingsProvider?: () => EngineeringHarnessSettings;
  readonly workspaceOverrideProvider?: (workspaceId: string) => EngineeringWorkspaceOverride | undefined;
  readonly assessmentService?: EngineeringProjectAssessmentService;
}

export class EngineeringPreparationService {
  private readonly assessmentService: EngineeringProjectAssessmentService;

  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly options: EngineeringPreparationServiceOptions = {},
  ) {
    this.assessmentService = options.assessmentService ?? new EngineeringProjectAssessmentService();
  }

  public async prepare(workspaceId: string, objective: string, scopedPath?: string): Promise<Result<EngineeringPreparation>> {
    const workspace = await this.workspaces.get(workspaceId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
    const trimmedObjective = objective.trim();
    if (trimmedObjective.length === 0) return err(appError('INVALID_INPUT', 'Engineering objective must not be empty'));

    const globalSettings = this.options.globalSettingsProvider?.() ?? DEFAULT_ENGINEERING_HARNESS_SETTINGS;
    const workspaceOverride = this.options.workspaceOverrideProvider?.(workspaceId);
    const taskScope = classifyEngineeringTaskScope(trimmedObjective);
    const userEnabled = workspaceOverride?.mode === 'on'
      ? true
      : workspaceOverride?.mode === 'off'
        ? false
        : globalSettings.enabled;

    let assessment: EngineeringProjectAssessment;
    if (!userEnabled || taskScope !== 'coding') {
      assessment = inactiveAssessment(workspace.realRootPath);
    } else {
      try {
        assessment = await this.assessmentService.assess(workspace.realRootPath, scopedPath);
      } catch (error) {
        return err(appError('INVALID_INPUT', error instanceof Error ? error.message : 'Engineering project assessment failed'));
      }
    }

    const policy = resolveEngineeringPolicy({
      workspaceId,
      globalSettings,
      ...(workspaceOverride === undefined ? {} : { workspaceOverride }),
      projectProfile: assessment.projectProfile,
      projectAssessment: assessment.project,
      projectAssessmentFingerprint: assessment.fingerprint,
      taskScope,
    });

    let workflow = planEngineeringWorkflow(trimmedObjective, assessment, 0, {
      profile: policy.profile,
      ...(policy.custom === undefined ? {} : { custom: policy.custom }),
    });
    if (policy.enabled) {
      try { workflow = applyDeliveryContract(workflow, await observeEngineeringCapabilities(workspace.realRootPath), globalSettings, policy.policyDigest); }
      catch {
        const unavailable = { state: 'unreadable' as const, reasonCode: 'WORKSPACE_UNREADABLE' };
        workflow = applyDeliveryContract(workflow, { git: unavailable, remote: unavailable, ci: unavailable, artifact: unavailable, deployment: unavailable, source: unavailable, digest: '0'.repeat(64) }, globalSettings, policy.policyDigest);
      }
    }
    return ok({ objective: trimmedObjective, assessment, policy, workflow });
  }
}

function inactiveAssessment(rootPath: string): EngineeringProjectAssessment {
  return {
    project: {
      rootPath,
      kind: 'unknown',
      packageManager: 'unknown',
      frameworks: [],
      scripts: {},
      configFiles: [],
      confidence: 'none',
      detectedFiles: [],
      platforms: [],
      suggestedCommands: {},
    },
    instructions: [],
    projectProfile: {},
    projectProfileStatus: 'missing',
    fingerprint: 'engineering-inactive-no-project-scan',
    codeGraphIndexed: false,
    warnings: [],
  };
}
