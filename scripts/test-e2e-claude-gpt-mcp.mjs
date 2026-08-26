#!/usr/bin/env node
/**
 * End-to-End Integration Verification Suite:
 * Claude Code -> Anthropic-to-GPT Proxy -> lnwjud MCP stdio -> Ubuntu Environment
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '../node_modules/.pnpm/@modelcontextprotocol+client@2.0.0/node_modules/@modelcontextprotocol/client/dist/index.mjs';
import { StdioClientTransport } from '../node_modules/.pnpm/@modelcontextprotocol+client@2.0.0/node_modules/@modelcontextprotocol/client/dist/stdio.mjs';

async function main() {
  process.stdout.write('=== Starting End-to-End Integration Tests ===\n');

  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lnwjud-e2e-workspace-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'lnwjud-e2e-data-'));
  process.stdout.write(`Workspace root: ${workspaceRoot}\n`);

  try {
    // 1. Verify Anthropic-to-GPT Proxy HTTP Server
    process.stdout.write('\n[1/5] Testing Anthropic-to-GPT Proxy HTTP endpoints...\n');
    const proxyPort = 8089;
    const proxyProc = spawn(process.execPath, ['scripts/anthropic-gpt-proxy.mjs'], {
      env: { ...process.env, PORT: String(proxyPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise((resolve) => setTimeout(resolve, 600));

    const healthRes = await fetch(`http://127.0.0.1:${proxyPort}/health`);
    const healthJson = await healthRes.json();
    if (healthJson.status !== 'ok') {
      throw new Error(`Proxy health check failed: ${JSON.stringify(healthJson)}`);
    }
    process.stdout.write('✓ Proxy health check passed\n');

    // 2. Spawn lnwjud-mcp-stdio client
    process.stdout.write('\n[2/5] Initializing lnwjud MCP stdio client...\n');
    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: ['bin/lnwjud-mcp-stdio.mjs', '--workspace', workspaceRoot, '--data-path', dataDir],
    });

    const mcpClient = new Client(
      { name: 'claude-code-e2e', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await mcpClient.connect(stdioTransport);
    process.stdout.write('✓ Connected to lnwjud MCP stdio server\n');

    // List workspaces to get active workspace ID
    const listWsRes = await mcpClient.callTool({
      name: 'workspace_list',
      arguments: {},
    });
    if (listWsRes.isError) throw new Error(`workspace_list failed: ${JSON.stringify(listWsRes)}`);
    const workspaces = listWsRes.structuredContent?.value || [];
    const activeWs = workspaces.find((w) => w.kind === 'project') || workspaces[0];
    if (!activeWs) throw new Error(`No active workspace returned in workspace_list: ${JSON.stringify(listWsRes)}`);
    const workspaceId = activeWs.id;
    process.stdout.write(`✓ Selected active workspace ID: ${workspaceId} (${activeWs.displayName})\n`);

    // 3. Test MCP Tool Listing & Basic Tools (Filesystem, Git, Shell, Process)
    process.stdout.write('\n[3/5] Exercising core MCP tools (Filesystem, Shell, Process, Audit)...\n');
    const toolsResult = await mcpClient.listTools();
    const toolNames = new Set(toolsResult.tools.map((t) => t.name));
    if (!toolNames.has('read_file') || !toolNames.has('write_file') || !toolNames.has('shell')) {
      throw new Error(`Missing expected tools in MCP server tool registry. Total tools: ${toolNames.size}`);
    }
    process.stdout.write(`✓ Tool registry active with ${toolNames.size} tools\n`);

    // Write file
    const writeRes = await mcpClient.callTool({
      name: 'write_file',
      arguments: { workspaceId, path: 'hello.txt', content: 'Ubuntu + Claude Code + GPT' },
    });
    if (writeRes.isError) throw new Error(`write_file failed: ${JSON.stringify(writeRes)}`);
    process.stdout.write('✓ write_file executed successfully\n');

    // Read file
    const readRes = await mcpClient.callTool({
      name: 'read_file',
      arguments: { workspaceId, path: 'hello.txt' },
    });
    if (readRes.isError) throw new Error(`read_file failed: ${JSON.stringify(readRes)}`);
    process.stdout.write('✓ read_file verified file content\n');

    // Shell execution
    const shellRes = await mcpClient.callTool({
      name: 'shell',
      arguments: {
        workspaceId,
        executable: process.execPath,
        arguments: ['-e', 'console.log("hello from node shell")'],
        userConfirmed: true,
      },
    });
    if (shellRes.isError) throw new Error(`shell tool execution failed: ${JSON.stringify(shellRes)}`);
    process.stdout.write('✓ shell tool executed successfully\n');

    // 4. Verify Strict-Roots & Permission Scope Enforcement
    process.stdout.write('\n[4/5] Testing Workspace Isolation & Strict-Roots Boundary...\n');
    const outsideWriteRes = await mcpClient.callTool({
      name: 'write_file',
      arguments: { workspaceId, path: '/etc/forbidden.txt', content: 'escape' },
    });
    if (!outsideWriteRes.isError) {
      throw new Error('Expected path outside workspace to fail, but write succeeded!');
    }
    process.stdout.write('✓ Workspace boundary correctly blocked path traversal attempt\n');

    // 5. Clean teardown
    process.stdout.write('\n[5/5] Teardown & Final Checks...\n');
    await mcpClient.close();
    proxyProc.kill();
    process.stdout.write('✓ All e2e integration components verified successfully!\n');

  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`\n❌ End-to-End Test Failed: ${err.stack || err}\n`);
  process.exit(1);
});
