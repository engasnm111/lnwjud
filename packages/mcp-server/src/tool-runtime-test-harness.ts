import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ok, type AutomationMilestoneRecord, type AutomationRunSnapshot, type CommitAutomationTransitionRequest } from '@lnwjud/domain';
import type { McpApplicationServices } from './tools/tool-types.js';

type ServiceResolver = (method: string, args: readonly unknown[]) => unknown;

function serviceProxy(group: string, calls: string[], resolve: ServiceResolver): object {
  return new Proxy<Record<string, unknown>>({}, {
    get(_target, property) {
      return async (...args: unknown[]) => {
        const method = String(property);
        calls.push(`${group}.${method}`);
        return ok(resolve(method, args));
      };
    },
  });
}

export function runtimeRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function createRuntimeSuccessServices(calls: string[]): McpApplicationServices {
  const runtimeEccWorkspaceRoot = path.join(os.tmpdir(), `lnwjud-runtime-contract-ecc-${process.pid}`);
  mkdirSync(runtimeEccWorkspaceRoot, { recursive: true });
  const processSnapshot = {
    processId: 'process-1', executable: 'pnpm.cmd', args: ['typecheck'], cwd: 'E:\\project', state: 'exited',
    startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), exitCode: 0,
  };
  const png = { format: 'png', mime_type: 'image/png', data_base64: 'cG5n', width: 640, height: 480, origin_x: 0, origin_y: 0 };
  const automationTime = '2026-09-19T00:00:00.000Z';
  const automationMilestone = (runId: string, status: 'waiting_task' | 'completed' = 'completed'): AutomationMilestoneRecord => ({
    id: 'm1',
    runId,
    ordinal: 0,
    title: 'Smoke milestone',
    dependsOn: [],
    executionIntent: 'Exercise native automation surface.',
    verificationRequirements: [],
    retryPolicy: { classification: 'safe_read' as const, maxAttempts: 1 },
    status,
    ...(status === 'waiting_task' ? { currentAttemptId: 'attempt-1' } : {}),
    createdAt: automationTime,
    updatedAt: automationTime,
  });
  const automationSnapshot = (
    runId: string,
    mode: 'terminal' | 'observe' | 'recover' | 'paused' | 'running' = 'terminal',
    revision = 0,
  ): AutomationRunSnapshot => {
    if (mode === 'observe' || mode === 'recover') {
      const milestone = automationMilestone(runId, 'waiting_task');
      return {
        id: runId,
        goalId: 'goal-1',
        workspaceId: 'workspace-1',
        policyProfile: 'coding_guarded',
        revision,
        status: mode === 'recover' ? 'blocked' : 'waiting_task',
        basedOnGoalRevision: 0,
        basedOnUserIntentRevision: 0,
        currentMilestoneId: 'm1',
        currentAttemptId: 'attempt-1',
        createdAt: automationTime,
        updatedAt: automationTime,
        milestones: [milestone],
        attempts: [{
          id: 'attempt-1',
          runId,
          milestoneId: 'm1',
          sequence: 1,
          basedOnRunRevision: 0,
          basedOnGoalRevision: 0,
          basedOnUserIntentRevision: 0,
          status: 'waiting_task',
          verificationEvidence: [],
          startedAt: automationTime,
          updatedAt: automationTime,
        }],
        taskBindings: [{
          attemptId: 'attempt-1',
          provider: 'shell',
          taskId: 'shell-task-1',
          role: 'blocking_job',
          cancelWithGoal: true,
          boundAt: automationTime,
        }],
        dispatchReceipts: [{
          id: 'receipt-1',
          runId,
          milestoneId: 'm1',
          attemptId: 'attempt-1',
          operationKey: 'smoke-dispatch',
          state: 'confirmed',
          provider: 'shell',
          idempotencyKey: 'runtime-contract-dispatch',
          externalId: 'shell-task-1',
          createdAt: automationTime,
          updatedAt: automationTime,
        }],
      };
    }
    if (mode === 'paused' || mode === 'running') {
      return {
        id: runId,
        goalId: 'goal-1',
        workspaceId: 'workspace-1',
        policyProfile: 'coding_guarded',
        revision,
        status: mode,
        basedOnGoalRevision: 0,
        basedOnUserIntentRevision: 0,
        createdAt: automationTime,
        updatedAt: automationTime,
        milestones: [],
        attempts: [],
        taskBindings: [],
        dispatchReceipts: [],
      };
    }
    return {
      id: runId,
      goalId: 'goal-1',
      workspaceId: 'workspace-1',
      policyProfile: 'coding_guarded',
      revision,
      status: 'completed',
      basedOnGoalRevision: 0,
      basedOnUserIntentRevision: 0,
      createdAt: automationTime,
      updatedAt: automationTime,
      terminalAt: automationTime,
      milestones: [],
      attempts: [],
      taskBindings: [],
      dispatchReceipts: [],
    };
  };
  const automationSnapshotFor = (runId: string): AutomationRunSnapshot => {
    if (runId === 'run-observe') return automationSnapshot(runId, 'observe');
    if (runId === 'run-recover') return automationSnapshot(runId, 'recover');
    if (runId === 'run-pause') return automationSnapshot(runId, 'running');
    if (runId === 'run-resume') return automationSnapshot(runId, 'paused');
    return automationSnapshot(runId);
  };
  const automationRepository = {
    async createRun(request: { readonly runId: string }): Promise<AutomationRunSnapshot> {
      calls.push('automation.repository.createRun');
      return automationSnapshot(request.runId);
    },
    async getRunById(runId: string): Promise<AutomationRunSnapshot> {
      calls.push('automation.repository.getRunById');
      return automationSnapshotFor(runId);
    },
    async getRunByGoalId(): Promise<AutomationRunSnapshot | null> {
      calls.push('automation.repository.getRunByGoalId');
      return null;
    },
    async commitTransition(request: CommitAutomationTransitionRequest): Promise<AutomationRunSnapshot> {
      calls.push('automation.repository.commitTransition');
      const base = automationSnapshotFor(request.runId);
      return {
        ...base,
        revision: request.expectedRevision + 1,
        status: request.runPatch?.status ?? base.status,
        basedOnGoalRevision: request.runPatch?.basedOnGoalRevision ?? base.basedOnGoalRevision,
        basedOnUserIntentRevision: request.runPatch?.basedOnUserIntentRevision ?? base.basedOnUserIntentRevision,
        ...(request.runPatch?.lastRecoveryDecision === null
          ? {}
          : request.runPatch?.lastRecoveryDecision === undefined
            ? (base.lastRecoveryDecision === undefined ? {} : { lastRecoveryDecision: base.lastRecoveryDecision })
            : { lastRecoveryDecision: request.runPatch.lastRecoveryDecision }),
        updatedAt: request.now,
      };
    },
    async listEvents(): Promise<readonly []> {
      calls.push('automation.repository.listEvents');
      return [];
    },
  };
  const automationGoalSnapshot = {
    goalId: 'goal-1',
    goalKey: 'runtime-contract-goal',
    workspaceId: 'workspace-1',
    objective: 'Runtime contract goal',
    status: 'completed' as const,
    revision: 1,
    userIntentRevision: 0,
    currentPhase: 'completed',
    plan: { steps: [] },
    acceptanceCriteria: [],
    iterationPolicy: { mode: 'outcome' as const, maxIterations: 0, currentIteration: 0, stopOnNoNewEvidence: true },
    completedSteps: [],
    pendingSteps: [],
    nextAction: '',
    blockers: [],
    activeTaskIds: [],
    trackedTasks: [],
    leaseGeneration: 1,
    leaseActivitySeq: 0,
    lastCheckpoint: null,
  };
  const automationOrchestrator = {
    async create(request: { readonly runId?: string }): Promise<AutomationRunSnapshot> {
      calls.push('automation.orchestrator.create');
      return automationSnapshot(request.runId ?? 'run-created');
    },
    async get(runId: string): Promise<AutomationRunSnapshot> {
      calls.push('automation.orchestrator.get');
      return automationSnapshotFor(runId);
    },
    async advance(request: { readonly runId: string }): Promise<AutomationRunSnapshot> {
      calls.push('automation.orchestrator.advance');
      return automationSnapshotFor(request.runId);
    },
    async startCurrentAttempt(request: { readonly runId: string }): Promise<AutomationRunSnapshot> {
      calls.push('automation.orchestrator.startCurrentAttempt');
      return automationSnapshotFor(request.runId);
    },
    async completeCurrentMilestone(request: { readonly runId: string }): Promise<AutomationRunSnapshot> {
      calls.push('automation.orchestrator.completeCurrentMilestone');
      return automationSnapshot(request.runId);
    },
    async failCurrentAttempt(request: { readonly runId: string }): Promise<AutomationRunSnapshot> {
      calls.push('automation.orchestrator.failCurrentAttempt');
      return automationSnapshot(request.runId);
    },
    async beginVerification(request: { readonly runId: string }): Promise<AutomationRunSnapshot> {
      calls.push('automation.orchestrator.beginVerification');
      return automationSnapshot(request.runId);
    },
    async pause(request: { readonly runId: string }): Promise<AutomationRunSnapshot> {
      calls.push('automation.orchestrator.pause');
      return automationSnapshot(request.runId, 'paused', 1);
    },
    async resume(request: { readonly runId: string }): Promise<AutomationRunSnapshot> {
      calls.push('automation.orchestrator.resume');
      return automationSnapshot(request.runId, 'running', 1);
    },
  };
  const automationGoalIntegration = {
    async checkpointTaskBound(requestActor: unknown, request: { readonly runId: string }): Promise<{ run: AutomationRunSnapshot; goal: typeof automationGoalSnapshot }> {
      void requestActor;
      calls.push('automation.goalIntegration.checkpointTaskBound');
      return { run: automationSnapshotFor(request.runId), goal: automationGoalSnapshot };
    },
    async verifyAndCompleteMilestone(requestActor: unknown, request: { readonly runId: string }): Promise<{ run: AutomationRunSnapshot; goal: typeof automationGoalSnapshot }> {
      void requestActor;
      calls.push('automation.goalIntegration.verifyAndCompleteMilestone');
      return { run: automationSnapshot(request.runId), goal: automationGoalSnapshot };
    },
    async finalize(requestActor: unknown, request: { readonly runId: string }): Promise<{ run: AutomationRunSnapshot; goal: typeof automationGoalSnapshot; completionState: 'completed' }> {
      void requestActor;
      calls.push('automation.goalIntegration.finalize');
      return {
        run: automationSnapshot(request.runId),
        goal: automationGoalSnapshot,
        completionState: 'completed' as const,
      };
    },
  };

  return {
    sandboxRuntimeOptions: {
      platform: process.platform,
      sandboxExecutable: '__lnwjud_runtime_contract_missing_windows_sandbox__.exe',
    },
    eventLogRuntimeOptions: {
      runner: async () => ok(JSON.stringify([{
        time: '2026-09-11T00:00:00.000Z',
        provider: 'lnwjud-test',
        id: 1,
        level: 'Information',
        message: 'fixture event',
      }])),
    },
    workspaceInfo: serviceProxy('workspaceInfo', calls, (method, args) => {
      const requestedWorkspaceId = typeof args[1] === 'string' ? args[1] : 'workspace-1';
      const root = requestedWorkspaceId === 'ecc-workspace' ? runtimeEccWorkspaceRoot : process.cwd();
      return method === 'list'
        ? [{ id: 'workspace-1', path: process.cwd(), realRootPath: process.cwd() }, { id: 'ecc-workspace', path: runtimeEccWorkspaceRoot, realRootPath: runtimeEccWorkspaceRoot }]
        : { id: requestedWorkspaceId, path: root, realRootPath: root };
    }),
    workspaceQuery: serviceProxy('workspaceQuery', calls, () => ({ entries: [] })),
    projectSnapshot: serviceProxy('projectSnapshot', calls, () => ({ workspaceId: 'workspace-1', files: 1 })),
    project: serviceProxy('project', calls, () => ({ kind: 'node', packageManager: 'pnpm' })),
    file: serviceProxy('file', calls, (method, args) => {
      if (method === 'readFile') {
        const request = runtimeRecord(args[2]);
        const filePath = typeof request.path === 'string' ? request.path : 'README.md';
        const startLine = typeof request.startLine === 'number' ? request.startLine : 1;
        const paged = filePath === 'paged.txt';
        const content = filePath === '.lnwjud/project-profile.json'
          ? '{"language":"typescript"}\n'
          : filePath === 'package.json'
            ? '{"packageManager":"pnpm@10.15.0","scripts":{"benchmark":"vitest bench"}}\n'
            : filePath.toLowerCase().endsWith('skill.md')
              ? '---\nname: smoke-skill\ndescription: Smoke skill\n---\n\n# Smoke\n'
              : paged && startLine === 1 ? 'one\ntwo' : paged ? 'two' : 'export const smoke = true;\n';
        const endLine = paged ? 2 : startLine + Math.max(0, content.split(/\r?\n/).filter(Boolean).length - 1);
        return { path: filePath, content, startLine, endLine, encoding: 'utf8', mimeType: 'text/plain', byteLength: Buffer.byteLength(content) };
      }
      if (method === 'readFiles') return { files: [] };
      if (method === 'listRecoveryItems') return [];
      if (method === 'prepareExternalFileMutation') {
        const request = runtimeRecord(args[2]);
        return { sourcePaths: Array.isArray(request.sourcePaths) ? request.sourcePaths : [], targetPath: typeof request.targetPath === 'string' ? request.targetPath : 'output.tmp' };
      }
      return { executed: true };
    }),
    checkpoint: serviceProxy('checkpoint', calls, (method) => method === 'list' ? [] : { restored: true }),
    search: serviceProxy('search', calls, (method) => method === 'searchText'
      ? { matches: [{ path: 'src/smoke.ts', line: 1, text: 'smoke' }, { path: 'src/second.test.ts', line: 1, text: 'smoke' }], truncated: false }
      : { paths: ['src/smoke.ts', 'src/second.test.ts'], truncated: false }),
    workspaceIndex: serviceProxy('workspaceIndex', calls, (method) => method === 'status'
      ? { indexed: true, snapshot: { entries: [
        { relativePath: 'src/smoke.ts', kind: 'file', language: 'typescript', isTest: false, symbols: ['smoke'], functions: [], classes: [], interfaces: [], imports: [], exports: [] },
        { relativePath: 'src/second.test.ts', kind: 'file', language: 'typescript', isTest: true, symbols: ['second'], functions: [], classes: [], interfaces: [], imports: [], exports: [] },
      ] } }
      : { executed: true }),
    git: serviceProxy('git', calls, (method) => {
      if (method === 'status') return { entries: [] };
      if (method === 'diff') return { patch: '', truncated: false };
      if (method === 'log') return { commits: [], truncated: false };
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    process: serviceProxy('process', calls, (method) => {
      if (method === 'list') return [];
      if (method === 'logs') return { entries: [], truncated: false };
      if (method === 'previewProjectCommand') return { executable: 'pnpm.cmd', args: ['test'], cwd: 'E:\\project' };
      if (method === 'stop') return { stopped: true };
      return processSnapshot;
    }),
    codex: serviceProxy('codex', calls, (method) => method === 'list' ? [] : { ...processSnapshot, codexTaskId: 'codex-1' }),
    automation: {
      repository: automationRepository,
      orchestrator: automationOrchestrator,
      goalIntegration: automationGoalIntegration,
    },
    agentSwarm: serviceProxy('agentSwarm', calls, (method) => {
      if (method === 'list') return { items: [] };
      if (method === 'result') return { swarmId: '00000000-0000-4000-8000-000000000001', taskId: 'inspect', state: 'completed', text: '', eof: true, outputTruncated: false };
      return { swarmId: '00000000-0000-4000-8000-000000000001', state: method === 'cancel' ? 'cancelled' : 'running', tasks: [] };
    }),
    goals: serviceProxy('goals', calls, (method) => {
      const goal = {
        goalId: 'goal-1', goalKey: 'smoke-goal', workspaceId: 'workspace-1', objective: 'Smoke durable goal contract',
        status: 'active', revision: 0, userIntentRevision: 0, currentPhase: 'smoke',
        plan: { steps: [] }, acceptanceCriteria: [], iterationPolicy: { mode: 'outcome', maxIterations: 0, currentIteration: 0, stopOnNoNewEvidence: true },
        completedSteps: [], pendingSteps: [], nextAction: 'continue smoke', blockers: [], activeTaskIds: [], trackedTasks: [], lastCheckpoint: null,
        leaseGeneration: 1, leaseActivitySeq: 0,
      };
      if (method === 'listGoals') return { goals: [goal] };
      if (method === 'listContextCapsules' || method === 'listDeliveryReceipts') return [];
      if (method === 'getContextCapsule') return null;
      if (method === 'recordDeliveryReceipt') return { id: 'receipt-1', goalId: 'goal-1', channel: 'smoke', state: 'reserved', basedOnUserIntentRevision: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
      if (method === 'createContextCapsule') return { capsule: { id: 'capsule-1', goalId: 'goal-1', sourceGoalRevision: 0, sourceUserIntentRevision: 0, payload: {}, createdAt: new Date(0).toISOString() }, goal: { ...goal, revision: 1, currentContextCapsuleId: 'capsule-1' } };
      return method === 'runGoal' ? { ...goal, acquired: true, leaseToken: 'lease-token' } : goal;
    }),
    scheduledContinuations: serviceProxy('scheduledContinuations', calls, (method) => method === 'authorizeWorkspaceMutation'
      ? { allowed: true }
      : { continuationId: 'continuation-1', status: 'scheduled', version: 1 }),
    extensions: serviceProxy('extensions', calls, (method) => {
      if (method === 'listSkills') return { skills: [] };
      if (method === 'readSkill') return { id: 'skill-1', name: 'Smoke', description: 'Smoke', source: 'workspace', path: 'SKILL.md', content: '# Smoke' };
      if (method === 'listMcpServers') return { servers: [{ name: 'server-1' }] };
      if (method === 'describeMcpServer') return { server: 'server-1', enabled: true, connected: true, tools: [] };
      if (method === 'listMcpResources') return { server: 'server-1', enabled: true, connected: true, resources: [{ uri: 'file:///resource.txt', name: 'resource' }] };
      return { called: true };
    }),
    localProviders: () => ({ pdfProvider: '__lnwjud_missing_pdf_provider__.exe' }),
    capabilities: {
      async execute(tool: string, input: unknown) {
        calls.push(`capabilities.${tool}`);
        const request = runtimeRecord(input);
        if (tool === 'accessibility') {
          if (request.action === 'observe') return ok({ elements: [{ element: { name: 'Save', automation_id: 'save', enabled: true, offscreen: false, bounds: { x: 20, y: 30, width: 100, height: 40 } } }] });
          if (request.action === 'find_element') return ok({ element: { name: 'Save', automation_id: 'save', bounds: { x: 20, y: 30, width: 100, height: 40 } } });
          return ok({ executed: true });
        }
        if (tool === 'vision') return ok(png);
        if (tool === 'shell' && request.operation === 'list') return ok({ tasks: [] });
        if (tool === 'office' && request.app === 'excel' && request.action === 'sheets') return ok({ sheets: ['Sheet1'] });
        if (tool === 'office' && request.app === 'excel' && request.action === 'read') return ok({ values: [['smoke']] });
        return ok({ executed: true });
      },
    } as NonNullable<McpApplicationServices['capabilities']>,
  } as unknown as McpApplicationServices;
}
