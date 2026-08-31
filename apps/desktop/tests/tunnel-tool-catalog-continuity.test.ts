import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRuntime, type DesktopRuntime } from '../src/main/desktop-services.js';

const temporaryRoots: string[] = [];

beforeEach(() => {
  vi.stubEnv('LNWJUD_UNRESTRICTED', '1');
  vi.stubEnv('LNWJUD_MCP_PORT', '0');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }));
});

describe('v4.11 tool catalog continuity', () => {
  it('keeps the 2026-07-28 tool catalog byte-stable across a Desktop MCP listener restart without connector schema changes', async () => {
    const raw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-v411-catalog-'));
    temporaryRoots.push(raw);
    const root = await realpath(raw);
    const dataRoot = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    await Promise.all([mkdir(dataRoot, { recursive: true }), mkdir(workspaceRoot, { recursive: true })]);

    let firstRuntime: DesktopRuntime | null = createDesktopRuntime(dataRoot);
    let secondRuntime: DesktopRuntime | null = null;
    try {
      await firstRuntime.ensureDefaultWorkspace(workspaceRoot);
      const firstConnection = await firstRuntime.autoStartMcp();
      expect(firstConnection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      if (firstConnection.url === null) throw new Error('first MCP endpoint was not started');

      const first = await captureCatalog(firstConnection.url, 'before-desktop-restart');
      expect(first.tools.length).toBeGreaterThan(0);
      expect(first.tools.some((tool) => tool.name.startsWith('codex_'))).toBe(false);
      for (const required of ['prepare_scheduled_continuation', 'record_scheduled_continuation_receipt', 'claim_scheduled_continuation', 'get_scheduled_continuation', 'expedite_scheduled_continuation', 'run_goal', 'checkpoint_goal']) {
        expect(first.tools.some((tool) => tool.name === required), required).toBe(true);
      }
      expect(first.workspaceListSucceeded).toBe(true);

      await firstRuntime.close();
      firstRuntime = null;

      secondRuntime = createDesktopRuntime(dataRoot);
      await secondRuntime.ensureDefaultWorkspace(workspaceRoot);
      const secondConnection = await secondRuntime.autoStartMcp();
      expect(secondConnection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      if (secondConnection.url === null) throw new Error('second MCP endpoint was not started');

      const second = await captureCatalog(secondConnection.url, 'after-desktop-restart');
      expect(second.workspaceListSucceeded).toBe(true);
      expect(second.tools).toEqual(first.tools);
      expect(second.digest).toBe(first.digest);
    } finally {
      await firstRuntime?.close().catch(() => undefined);
      await secondRuntime?.close().catch(() => undefined);
    }
  }, 45_000);
});

async function captureCatalog(url: string, name: string): Promise<{
  readonly tools: readonly unknown[];
  readonly digest: string;
  readonly workspaceListSucceeded: boolean;
}> {
  const client = new Client(
    { name: `lnwjud-${name}`, version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    const tools = catalog.tools.map((tool) => canonicalize(tool));
    const digest = createHash('sha256').update(JSON.stringify(tools)).digest('hex');
    const result = await client.callTool({ name: 'workspace_list', arguments: {} });
    return { tools, digest, workspaceListSucceeded: result.isError !== true };
  } finally {
    await client.close();
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}
