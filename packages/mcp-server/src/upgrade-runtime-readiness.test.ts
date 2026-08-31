import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import { UpgradeRuntimeService } from './upgrade-runtime.js';
import { UPGRADE_TOOL_CATALOG } from './upgrade-catalog.js';
import type { McpApplicationServices } from './tools/tool-types.js';

const actor: FileActor = { clientId: 'readiness-test', clientName: 'readiness-test' };

describe('upgrade runtime readiness facades', () => {
  it('requires every advertised ready upgrade tool to have an explicit runtime implementation case', () => {
    const source = readFileSync(new URL('./upgrade-runtime.ts', import.meta.url), 'utf8');
    const explicitCases = new Set([...source.matchAll(/case '([^']+)'/g)].map((match) => match[1]));
    const missingReadyCases = UPGRADE_TOOL_CATALOG
      .filter((entry) => (entry.availability ?? 'ready') === 'ready')
      .map((entry) => entry.name)
      .filter((name) => !explicitCases.has(name))
      .sort();
    expect(missingReadyCases).toEqual([]);
  });

  it('dispatches Git insight facades to the real Git service', async () => {
    const calls: string[] = [];
    const services = {
      git: {
        async status() { calls.push('status'); return ok({ entries: [{ path: 'packages/app/src/a.ts', kind: 'modified', indexStatus: ' ', worktreeStatus: 'M' }] }); },
        async diff() { calls.push('diff'); return ok({ patch: 'diff --git a/a b/a', truncated: false }); },
        async log() { calls.push('log'); return ok({ commits: [{ hash: 'abc', subject: 'change' }], truncated: false }); },
        async run() { calls.push('run'); return ok({ exitCode: 0, stdout: 'blame-output', stderr: '' }); },
      },
    } as unknown as McpApplicationServices;
    const runtime = new UpgradeRuntimeService(services, actor);

    await expect(runtime.execute('review_changes', { workspaceId: 'ws' })).resolves.toMatchObject({ ok: true, value: { executed: true, status: 'ready' } });
    await expect(runtime.execute('affected_modules', { workspaceId: 'ws' })).resolves.toMatchObject({ ok: true, value: { executed: true, modules: ['packages'] } });
    await expect(runtime.execute('git_history_context', { workspaceId: 'ws' })).resolves.toMatchObject({ ok: true, value: { executed: true } });
    await expect(runtime.execute('git_blame_context', { workspaceId: 'ws', path: 'a.ts' })).resolves.toMatchObject({ ok: true, value: { executed: true, path: 'a.ts' } });
    expect(calls).toEqual(['status', 'diff', 'log', 'status', 'log', 'run']);
  });

  it('discovers tests through the real workspace index and previews/runs the project test command', async () => {
    const calls: string[] = [];
    const services = {
      workspaceIndex: {
        async status() {
          calls.push('index');
          return ok({ indexed: true, snapshot: { entries: [
            { relativePath: 'src/a.ts', kind: 'file', language: 'typescript', isTest: false, symbols: [], functions: [], classes: [], interfaces: [], imports: [], exports: [] },
            { relativePath: 'src/a.test.ts', kind: 'file', language: 'typescript', isTest: true, symbols: ['works'], functions: [], classes: [], interfaces: [], imports: [], exports: [] },
          ] } });
        },
      },
      process: {
        async previewProjectCommand() { calls.push('preview'); return ok({ executable: 'pnpm.cmd', args: ['test'] }); },
        async startProjectCommand() { calls.push('start'); return ok({ processId: 'p1', executable: 'pnpm.cmd', args: ['test'], cwd: 'E:\\repo', state: 'running', startedAt: new Date(0).toISOString() }); },
      },
    } as unknown as McpApplicationServices;
    const runtime = new UpgradeRuntimeService(services, actor);

    await expect(runtime.execute('discover_tests', { workspaceId: 'ws' })).resolves.toMatchObject({ ok: true, value: { executed: true, tests: [{ path: 'src/a.test.ts' }] } });
    await expect(runtime.execute('run_affected_tests', { workspaceId: 'ws' })).resolves.toMatchObject({ ok: true, value: { executed: true, dryRun: true, started: false } });
    await expect(runtime.execute('run_affected_tests', { workspaceId: 'ws', dryRun: false, userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { executed: true, started: true, process: { processId: 'p1' } } });
    expect(calls).toEqual(['index', 'preview', 'preview', 'start']);
  });

  it('dispatches skill discovery and loading to the real extensions service', async () => {
    const calls: string[] = [];
    const services = {
      extensions: {
        async listSkills(input: unknown) { calls.push(`list:${JSON.stringify(input)}`); return ok({ skills: [{ id: 'skill-1', name: 'Smoke Skill', source: 'workspace' }] }); },
        async readSkill(input: unknown) { calls.push(`read:${JSON.stringify(input)}`); return ok({ id: 'skill-1', content: '# Smoke Skill', source: 'workspace' }); },
      },
    } as unknown as McpApplicationServices;
    const runtime = new UpgradeRuntimeService(services, actor);

    await expect(runtime.execute('skill_match', { query: 'smoke', source: 'workspace' })).resolves.toMatchObject({
      ok: true,
      value: { tool: 'skill_match', status: 'ready', executed: true, skills: [{ id: 'skill-1' }] },
    });
    await expect(runtime.execute('skill_load', { skillId: 'skill-1' })).resolves.toMatchObject({
      ok: true,
      value: { tool: 'skill_load', status: 'ready', executed: true, skill: { id: 'skill-1' } },
    });
    expect(calls).toEqual([
      'list:{"query":"smoke","source":"workspace"}',
      'read:{"skillId":"skill-1"}',
    ]);
  });

  it('pins browser and visual facades to the caller-selected DOM/CDP tab', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const services = {
      capabilities: {
        async execute(tool: string, input: unknown) {
          const record = input as Record<string, unknown>;
          calls.push({ tool, input: record });
          if (record.action === 'status') return ok({ ready: true, port: 9222 });
          if (record.action === 'list_tabs') return ok({ tabs: [{ id: 'tab-1', title: 'App', url: 'http://localhost' }] });
          if (record.action === 'query') return ok({ ok: true, tag: 'BODY', text: 'hello', frame: { x: 0, y: 0, width: 100, height: 100 } });
          if (record.action === 'screenshot') return ok({ format: 'png', data_base64: 'aGVsbG8=' });
          return ok({});
        },
      },
    } as unknown as McpApplicationServices;
    const runtime = new UpgradeRuntimeService(services, actor);

    await expect(runtime.execute('inspect_web_app', { tab_id: 'tab-1' }))
      .resolves.toMatchObject({ ok: true, value: { executed: true, status: 'ready' } });
    await expect(runtime.execute('capture_ui_state', { tab_id: 'tab-1' }))
      .resolves.toMatchObject({ ok: true, value: { executed: true } });
    await expect(runtime.execute('capture_screenshot', { tab_id: 'tab-1' }))
      .resolves.toMatchObject({ ok: true, value: { executed: true } });
    await expect(runtime.execute('dom_snapshot', { tab_id: 'tab-1' }))
      .resolves.toMatchObject({ ok: true, value: { executed: true } });

    const pageCalls = calls.filter((call) => ['query', 'screenshot'].includes(String(call.input.action)));
    expect(pageCalls.length).toBeGreaterThan(0);
    expect(pageCalls.every((call) => call.input.tab_id === 'tab-1')).toBe(true);

    const callCountBeforeMissingTarget = calls.length;
    await expect(runtime.execute('inspect_web_app', {}))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('tab_id') } });
    await expect(runtime.execute('capture_screenshot', {}))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('tab_id') } });
    const missingTargetCalls = calls.slice(callCountBeforeMissingTarget);
    expect(missingTargetCalls.some((call) => ['query', 'screenshot'].includes(String(call.input.action)))).toBe(false);
  });

  it('does not fake browser console/network history when the backend has no retained event stream', async () => {
    const services = {
      capabilities: {
        async execute(_tool: string, input: unknown) {
          return ok({ ready: (input as { action?: string }).action === 'status' });
        },
      },
    } as unknown as McpApplicationServices;
    const runtime = new UpgradeRuntimeService(services, actor);

    for (const tool of ['network_context', 'console_context'] as const) {
      await expect(runtime.execute(tool, {})).resolves.toMatchObject({
        ok: true,
        value: { status: 'needs_setup', available: false, ready: false, executed: false, requirements: expect.any(Array) },
      });
    }
  });

  it('performs deterministic screenshot artifact comparison instead of returning metadata-only success', async () => {
    const runtime = new UpgradeRuntimeService({}, actor);
    await expect(runtime.execute('compare_screenshot', { baseline_base64: 'same', actual_base64: 'same' }))
      .resolves.toMatchObject({ ok: true, value: { executed: true, equal: true, baseline: { sha256: expect.any(String) } } });
    await expect(runtime.execute('compare_screenshot', { baseline_base64: 'left', actual_base64: 'right' }))
      .resolves.toMatchObject({ ok: true, value: { executed: true, equal: false } });
  });
});
