import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ok } from '@lnwjud/domain';
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
    resourceSnapshot: serviceProxy('resourceSnapshot', calls, () => ({workspaceId:'workspace-1',resources:[],coverage:'unknown'})),
    callHistory: serviceProxy('callHistory', calls, () => ({items:[],nextCursor:null,coverage:'unknown'})),
    taskResults: serviceProxy('taskResults', calls, () => ({workspaceId:'workspace-1',goalId:'goal-1',observedChanges:[],artifacts:[],evidenceCoverage:'partial'})),
    workflowTemplates: serviceProxy('workflowTemplates', calls, (method) => method === 'list' ? [] : {readiness:'ready'}),
    workflowStart: serviceProxy('workflowStart', calls, () => ({goalId:'goal-1',status:'active'})),
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
    engineeringPreparation: serviceProxy('engineeringPreparation', calls, (_method, args) => {
      const objective = typeof args[1] === 'string' ? args[1] : 'Fix the auth persistence bug';
      return {
        objective,
        assessment: {
          project: {
            rootPath: process.cwd(), kind: 'node', packageManager: 'pnpm', frameworks: ['typescript'], scripts: {}, configFiles: [],
            confidence: 'strong', detectedFiles: ['package.json'], platforms: ['node'], suggestedCommands: {},
          },
          instructions: [], projectProfile: {}, projectProfileStatus: 'missing', fingerprint: 'runtime-contract-engineering', warnings: [],
        },
        policy: {
          enabled: true, source: 'global', profile: 'senior', workspaceId: 'workspace-1', taskScope: 'coding',
          project: { mode: 'inherit' }, policyDigest: 'engineering-policy-smoke',
          reasons: ['Runtime contract fixture enables Engineering Harness.'],
        },
        workflow: {
          primaryTaskKind: 'bugfix', riskTier: 'high', deliveryScope: 'local',
          workflow: [{ id: 'requirements', title: 'Resolve requirement and affected contracts' }], gates: [], riskReasons: ['Runtime contract fixture.'],
        },
      };
    }),
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
    agentSwarm: serviceProxy('agentSwarm', calls, (method) => {
      if (method === 'list') return { items: [] };
      if (method === 'result') return { swarmId: '00000000-0000-4000-8000-000000000001', taskId: 'inspect', state: 'completed', text: '', eof: true, outputTruncated: false };
      return { swarmId: '00000000-0000-4000-8000-000000000001', state: method === 'cancel' ? 'cancelled' : 'running', tasks: [] };
    }),
    automation: serviceProxy('automation', calls, (method) => {
      if (method === 'events') return { events: [] };
      if (method === 'advance') return { boundary: 'idle', run: { run: { id: 'automation-run-1', status: 'active', revision: 1 } } };
      if (method === 'finalize') return { run: { run: { id: 'automation-run-1', status: 'completed', revision: 2 } }, goal: { goalId: 'goal-1', status: 'completed' } };
      return { run: { id: 'automation-run-1', status: method === 'cancel' ? 'cancelled' : 'active', revision: 1 } };
    }),
    goals: serviceProxy('goals', calls, (method) => {
      const goal = {
        goalId: 'goal-1', goalKey: 'smoke-goal', workspaceId: 'workspace-1', objective: 'Fix the auth persistence bug',
        status: 'active', revision: 0, userIntentRevision: 0, currentPhase: 'smoke',
        plan: { steps: [] }, acceptanceCriteria: [], iterationPolicy: { mode: 'outcome', maxIterations: 0, currentIteration: 0, stopOnNoNewEvidence: true },
        completedSteps: [], pendingSteps: [], nextAction: 'continue smoke', blockers: [], activeTaskIds: [], trackedTasks: [], lastCheckpoint: null,
        leaseGeneration: 1, leaseActivitySeq: 0,
        engineering: {
          schemaVersion: 1, primaryTaskKind: 'bugfix', riskTier: 'high', policyDigest: 'engineering-policy-smoke', deliveryScope: 'local', gates: [],
        },
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
