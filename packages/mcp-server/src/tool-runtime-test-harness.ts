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
  const processSnapshot = {
    processId: 'process-1', executable: 'pnpm.cmd', args: ['typecheck'], cwd: 'E:\\project', state: 'exited',
    startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), exitCode: 0,
  };
  const png = { format: 'png', mime_type: 'image/png', data_base64: 'cG5n', width: 640, height: 480, origin_x: 0, origin_y: 0 };

  return {
    workspaceInfo: serviceProxy('workspaceInfo', calls, (method) => method === 'list'
      ? [{ id: 'workspace-1', path: process.cwd(), realRootPath: process.cwd() }]
      : { id: 'workspace-1', path: process.cwd(), realRootPath: process.cwd() }),
    workspaceQuery: serviceProxy('workspaceQuery', calls, () => ({ entries: [] })),
    projectSnapshot: serviceProxy('projectSnapshot', calls, () => ({ workspaceId: 'workspace-1', files: 1 })),
    project: serviceProxy('project', calls, () => ({ kind: 'node', packageManager: 'pnpm' })),
    file: serviceProxy('file', calls, (method, args) => {
      if (method === 'readFile') {
        const request = runtimeRecord(args[2]);
        const filePath = typeof request.path === 'string' ? request.path : 'README.md';
        const startLine = typeof request.startLine === 'number' ? request.startLine : 1;
        const paged = filePath === 'paged.txt';
        const content = paged && startLine === 1 ? 'one\ntwo' : paged ? 'two' : 'export const smoke = true;\n';
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
    goals: serviceProxy('goals', calls, (method) => method === 'listGoals' ? [] : { goalId: 'goal-1', status: 'active', acquired: true, leaseToken: 'lease-token' }),
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
