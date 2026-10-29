import { engineeringGoalMetadata, reconcileEngineeringMetadata, sameEngineeringMetadataContract, engineeringMetadataCheckpointDetails } from '@lnwjud/application';
import { appError, err, evaluateGoalReadiness, ok, type GoalCheckpointResumeContext } from '@lnwjud/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { engineeringGetStatusSchema, engineeringPrepareTaskSchema, engineeringStartTaskSchema } from './schemas.js';
import { engineeringBuildArtifactSchema, engineeringCaptureHandleSchema, engineeringUploadWorkerSchema } from '../engineering-build-capture.js';

const MAX_ENGINEERING_RESUME_CONTEXT_LENGTH = 64_000;

export function engineeringTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'engineering_prepare_task',
      description: 'Read-only Engineering Harness preparation. Assess the registered workspace, applicable project instructions, effective Engineering policy, and policy digest without creating a goal, starting a process, scheduling work, or writing repository files.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: engineeringPrepareTaskSchema,
      handler: async (input) => {
        if (context.services.engineeringPreparation === undefined) return missingService();
        const prepared = await context.services.engineeringPreparation.prepare(input.workspaceId, input.objective, input.scopedPath);
        if (!prepared.ok) return prepared;
        return ok({
          ...prepared.value,
          engineeringTask: {
            objective: prepared.value.objective,
            ...(input.scopedPath === undefined ? {} : { scopedPath: input.scopedPath }),
            policyDigest: prepared.value.policy.policyDigest,
            primaryTaskKind: prepared.value.workflow.primaryTaskKind,
            riskTier: prepared.value.workflow.riskTier,
            deliveryScope: prepared.value.workflow.deliveryScope,
            ...(context.actor.sessionId === undefined ? {} : { sessionId: context.actor.sessionId }),
          },
        });
      },
    }),
    defineTool({
      name: 'engineering_start_task',
      description: 'Start or resume a substantive Engineering Harness task by reusing the existing durable Goal authority. This operation does not create or authorize a scheduled continuation.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: engineeringStartTaskSchema,
      handler: async (input) => {
        const goals = context.services.goals;
        const preparation = context.services.engineeringPreparation;
        if (goals === undefined || preparation === undefined) return missingService();
        const existing = await goals.getGoal(context.actor, { workspaceId: input.workspaceId, goalKey: input.goalKey });
        const persistedEngineering = existing.ok ? existing.value.engineering : undefined;
        if (existing.ok && persistedEngineering === undefined) return err(appError('INVALID_INPUT', 'Existing goal is not an Engineering Harness task'));
        let effectiveScopedPath = existing.ok ? input.scopedPath ?? persistedEngineering?.scopedPath : input.scopedPath;
        let prepared = await preparation.prepare(input.workspaceId, input.objective, effectiveScopedPath);
        if (!prepared.ok) return prepared;
        let continuingThroughProjectOptOut = existing.ok && !prepared.value.policy.enabled && prepared.value.policy.source === 'project';
        if (!prepared.value.policy.enabled && !continuingThroughProjectOptOut) {
          return err(appError('INVALID_INPUT', `Engineering Harness is inactive: ${prepared.value.policy.reasons.join(' ')}`));
        }
        if (continuingThroughProjectOptOut && input.scopedPath !== undefined && input.scopedPath !== persistedEngineering?.scopedPath) {
          return err(appError('INVALID_INPUT', 'Project Engineering Harness is disabled for new scope preparation; resume the active task with its existing scopedPath.'));
        }
        if (existing.ok) {
          if (persistedEngineering === undefined) return err(appError('INVALID_INPUT', 'Existing goal is not an Engineering Harness task'));
          const resumed = await goals.runGoal(context.actor, {
            workspaceId: input.workspaceId,
            goalKey: input.goalKey,
            objective: input.objective,
            ...(input.leaseSeconds === undefined ? {} : { leaseSeconds: input.leaseSeconds }),
          });
          if (!resumed.ok) return resumed;
          const resumedGoal = resumed.value;
          const leaseToken = resumedGoal.leaseToken;
          if (!resumedGoal.acquired || leaseToken === undefined) return ok(resumedGoal);
          let current = resumedGoal;
          const existingEngineering = resumedGoal.engineering;
          const releaseAcquiredLease = (summary: string, failureDetail: string): ReturnType<typeof goals.checkpointGoal> => {
            const previousResumeContext = resumedGoal.lastCheckpoint?.resumeContext ?? {
              changedFiles: [],
              commands: [],
              decisions: [],
              failedAttempts: [],
              pendingValidation: [],
              resumePrerequisites: [],
              stateFacts: [],
              artifacts: [],
            };
            const failureAttempt = failureDetail.slice(0, 1_024);
            let priorFailedAttempts = [...previousResumeContext.failedAttempts.slice(-99)];
            const withFailureAttempt = (detail: string): GoalCheckpointResumeContext => ({
              ...previousResumeContext,
              failedAttempts: [...priorFailedAttempts, detail],
            });
            let resumeContext = withFailureAttempt(failureAttempt);
            const fitsResumeContext = (candidate: GoalCheckpointResumeContext): boolean => JSON.stringify(candidate).length <= MAX_ENGINEERING_RESUME_CONTEXT_LENGTH;
            while (!fitsResumeContext(resumeContext) && priorFailedAttempts.length > 0) {
              priorFailedAttempts = priorFailedAttempts.slice(1);
              resumeContext = withFailureAttempt(failureAttempt);
            }
            let releaseSummary = summary;
            if (!fitsResumeContext(resumeContext)) {
              let low = 1;
              let high = failureAttempt.length;
              let fittingLength = 0;
              while (low <= high) {
                const middle = Math.floor((low + high) / 2);
                const candidate = withFailureAttempt(failureAttempt.slice(0, middle));
                if (fitsResumeContext(candidate)) {
                  fittingLength = middle;
                  low = middle + 1;
                } else {
                  high = middle - 1;
                }
              }
              if (fittingLength > 0) {
                resumeContext = withFailureAttempt(failureAttempt.slice(0, fittingLength));
                releaseSummary = `${summary}; ${failureAttempt}`;
              } else {
                resumeContext = previousResumeContext;
                releaseSummary = `${summary}; ${failureAttempt}`;
              }
            }
            return goals.checkpointGoal(context.actor, {
              goalId: resumedGoal.goalId,
              leaseToken,
              expectedRevision: resumedGoal.revision,
              expectedUserIntentRevision: resumedGoal.userIntentRevision,
              currentPhase: resumedGoal.currentPhase,
              summary: releaseSummary,
              stepUpdates: [],
              nextAction: resumedGoal.nextAction,
              blockers: resumedGoal.blockers,
              evidence: resumedGoal.lastCheckpoint?.evidence ?? [],
              trackedTasks: resumedGoal.trackedTasks,
              resumeContext,
              releaseLease: true,
            });
          };
          if (existingEngineering === undefined) {
            const released = await releaseAcquiredLease(
              'Released Engineering Harness lease because the acquired goal metadata was missing.',
              'The acquired Engineering Harness goal is missing its metadata.',
            );
            return released.ok ? err(appError('INTERNAL_ERROR', 'Acquired Engineering Harness goal is missing its metadata')) : released;
          }
          if (input.scopedPath === undefined && existingEngineering.scopedPath !== effectiveScopedPath) {
            const acquiredScopePrepared = await preparation.prepare(input.workspaceId, input.objective, existingEngineering.scopedPath);
            if (!acquiredScopePrepared.ok) {
              const released = await releaseAcquiredLease(
                'Released Engineering Harness lease after acquired-scope preparation failed.',
                `Acquired-scope Engineering preparation failed (${acquiredScopePrepared.error.code}): ${acquiredScopePrepared.error.message}`,
              );
              return released.ok ? acquiredScopePrepared : released;
            }
            prepared = acquiredScopePrepared;
            effectiveScopedPath = existingEngineering.scopedPath;
            continuingThroughProjectOptOut = !prepared.value.policy.enabled && prepared.value.policy.source === 'project';
            if (!prepared.value.policy.enabled && !continuingThroughProjectOptOut) {
              const inactive = err(appError('INVALID_INPUT', `Engineering Harness is inactive: ${prepared.value.policy.reasons.join(' ')}`));
              const released = await releaseAcquiredLease(
                'Released Engineering Harness lease because the acquired scope is no longer enabled.',
                `Acquired-scope Engineering preparation is disabled: ${prepared.value.policy.reasons.join(' ')}`,
              );
              return released.ok ? inactive : released;
            }
          }
          const nextEngineering = engineeringGoalMetadata(prepared.value.policy.policyDigest, prepared.value.workflow, effectiveScopedPath);
          if (!continuingThroughProjectOptOut && (existingEngineering.policyDigest !== nextEngineering.policyDigest || !sameEngineeringMetadataContract(existingEngineering, nextEngineering))) {
            const reconciled = reconcileEngineeringMetadata(existingEngineering, prepared.value.policy.policyDigest, prepared.value.workflow, resumedGoal.userIntentRevision, effectiveScopedPath);
            const checkpointDetails = engineeringMetadataCheckpointDetails(existingEngineering, reconciled, resumedGoal.lastCheckpoint?.resumeContext ?? undefined);
            const checkpointed = await goals.checkpointGoal(context.actor, {
              goalId: resumedGoal.goalId,
              leaseToken,
              expectedRevision: resumedGoal.revision,
              expectedUserIntentRevision: resumedGoal.userIntentRevision,
              currentPhase: resumedGoal.currentPhase,
              summary: 'Reconciled changed Engineering Harness workflow metadata before resume.',
              stepUpdates: [],
              nextAction: resumedGoal.nextAction,
              blockers: resumedGoal.blockers,
              evidence: checkpointDetails.evidence,
              resumeContext: checkpointDetails.resumeContext,
              trackedTasks: resumedGoal.trackedTasks,
              engineering: reconciled,
            });
            if (!checkpointed.ok) {
              const released = await releaseAcquiredLease(
                'Released Engineering Harness lease after metadata reconciliation failed.',
                `Engineering metadata reconciliation failed (${checkpointed.error.code}): ${checkpointed.error.message}`,
              );
              return released.ok ? checkpointed : released;
            }
            current = { ...resumed.value, ...checkpointed.value };
          }
          return ok({
            ...current,
            acquired: true,
            leaseToken,
            engineeringTask: {
              goalId: current.goalId,
              policyDigest: current.engineering?.policyDigest ?? prepared.value.policy.policyDigest,
              goalRevision: current.revision,
              userIntentRevision: current.userIntentRevision,
              ...(effectiveScopedPath === undefined ? {} : { scopedPath: effectiveScopedPath }),
              ...(context.actor.sessionId === undefined ? {} : { sessionId: context.actor.sessionId }),
            },
          });
        }
        if (existing.error.code !== 'INVALID_INPUT') return existing;
        const started = await goals.runGoal(context.actor, {
          workspaceId: input.workspaceId,
          goalKey: input.goalKey,
          objective: input.objective,
          plan: { steps: prepared.value.workflow.workflow.map((step) => ({ id: step.id, title: step.title })) },
          engineering: engineeringGoalMetadata(prepared.value.policy.policyDigest, prepared.value.workflow, effectiveScopedPath),
          ...(input.leaseSeconds === undefined ? {} : { leaseSeconds: input.leaseSeconds }),
        });
        if (!started.ok) return started;
        if (!started.value.acquired || started.value.leaseToken === undefined) return ok(started.value);
        return ok({
          ...started.value,
          engineeringTask: {
            goalId: started.value.goalId,
            policyDigest: prepared.value.policy.policyDigest,
            goalRevision: started.value.revision,
            userIntentRevision: started.value.userIntentRevision,
            ...(effectiveScopedPath === undefined ? {} : { scopedPath: effectiveScopedPath }),
            ...(context.actor.sessionId === undefined ? {} : { sessionId: context.actor.sessionId }),
          },
        });
      },
    }),
    defineTool({
      name: 'engineering_get_status',
      description: 'Read the current Engineering Harness task projection, effective policy, required gates, blockers, and truthful delivery boundary without changing goal state.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: engineeringGetStatusSchema,
      handler: async (input) => {
        if (context.services.goals === undefined || context.services.engineeringPreparation === undefined) return missingService();
        const goal = await context.services.goals.getGoal(context.actor, { goalId: input.goalId });
        if (!goal.ok) return goal;
        if (goal.value.engineering === undefined) return err(appError('INVALID_INPUT', 'Goal is not an Engineering Harness task'));
        const prepared = await context.services.engineeringPreparation.prepare(goal.value.workspaceId, goal.value.objective, goal.value.engineering.scopedPath);
        if (!prepared.ok) return prepared;
        const readiness = evaluateGoalReadiness(goal.value);
        const { unresolvedGateIds, incompleteAcceptanceIds, incompleteStepIds } = readiness;
        const policyChanged = prepared.value.policy.policyDigest !== goal.value.engineering.policyDigest;
        const deliveryBoundary = goal.value.status !== 'active'
          ? goal.value.status
          : goal.value.blockers.length > 0
            ? 'blocked'
            : policyChanged || !readiness.ready
              ? 'checks_pending'
              : goal.value.engineering.deliveryScope === 'local'
                ? 'ready_locally'
                : `${goal.value.engineering.deliveryScope}_ready`;
        return ok({
          goalId: goal.value.goalId,
          workspaceId: goal.value.workspaceId,
          status: goal.value.status,
          currentPhase: goal.value.currentPhase,
          nextAction: goal.value.nextAction,
          blockers: goal.value.blockers,
          acceptanceCriteria: goal.value.acceptanceCriteria,
          readiness,
          incompleteAcceptanceIds,
          incompleteStepIds,
          primaryTaskKind: goal.value.engineering.primaryTaskKind,
          riskTier: goal.value.engineering.riskTier,
          deliveryScope: goal.value.engineering.deliveryScope,
          gates: goal.value.engineering.gates,
          unresolvedGateIds,
          deliveryBoundary,
          effectivePolicy: prepared.value.policy,
          policyChanged,
          engineeringTask: {
            goalId: goal.value.goalId,
            policyDigest: goal.value.engineering.policyDigest,
            goalRevision: goal.value.revision,
            userIntentRevision: goal.value.userIntentRevision,
            ...(goal.value.engineering.scopedPath === undefined ? {} : { scopedPath: goal.value.engineering.scopedPath }),
            ...(context.actor.sessionId === undefined ? {} : { sessionId: context.actor.sessionId }),
          },
        });
      },
    }),
    defineTool({
      name: 'engineering_build_artifact',
      description: 'Capture the current Engineering source and contract before starting an authorized managed build. Reserves observationId once; retries never launch a second command. Returns processId. Follow process status then engineering_complete_build. Worker artifacts use a self-contained schemaVersion 1 JSON manifest with exact upload metadata and inline base64 modules.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: engineeringBuildArtifactSchema,
      handler: async (input, signal, authorization, internal) => context.services.engineeringCapture === undefined ? missingService() : context.services.engineeringCapture.start(context.actor, { ...input, goalLease: internal?.checkedInvocation?.goalLease ?? input.goalLease }, signal, authorization),
    }),
    defineTool({
      name: 'engineering_complete_build',
      description: 'Verify a captured build has host-confirmed successful process termination, unchanged source/intent/contract, and a readable artifact. Persist a signed host receipt. Unknown attempts after restart cannot be adopted or replayed.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: engineeringCaptureHandleSchema,
      handler: async (input, _signal, _authorization, internal) => context.services.engineeringCapture === undefined ? missingService() : context.services.engineeringCapture.complete(context.actor, { ...input, goalLease: internal?.checkedInvocation?.goalLease ?? input.goalLease }),
    }),
    defineTool({
      name: 'engineering_upload_worker',
      description: 'Upload the exact signed Worker build manifest to the contract target using host credentials. Preserves captured metadata and modules, reads back version ID and script etag, and persists a signed receipt. This creates a version; it does not deploy traffic. Observation IDs are reserved once and unresolved uploads are never retried automatically.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: engineeringUploadWorkerSchema,
      handler: async (input, _signal, _authorization, internal) => context.services.engineeringCapture === undefined ? missingService() : context.services.engineeringCapture.uploadWorker(context.actor, { ...input, goalLease: internal?.checkedInvocation?.goalLease ?? input.goalLease }),
    }),
  ];
}
