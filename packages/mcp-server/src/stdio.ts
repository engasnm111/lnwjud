import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { createMcpServer, type McpServerOptions } from './server.js';
import { SetOfMarksObservationStore } from './set-of-marks-service.js';
import { IncrementalVerifier } from './incremental-verifier.js';
import { RunBudgetGuard } from './run-budget.js';
import { createStdioRequestScope } from './request-scope.js';

export interface McpStdioOptions extends McpServerOptions {
  readonly onError?: (error: Error) => void;
}

export function isBenignStdioPipeError(error: Error): boolean {
  return /EPIPE|ECONNRESET|broken pipe/i.test(error.message);
}

function writeStdioDiagnostic(error: Error): void {
  if (isBenignStdioPipeError(error)) {
    process.stderr.write(`lnwjud MCP stdio: peer closed (${error.message})\n`);
    return;
  }
  process.stderr.write(`lnwjud MCP stdio error: ${error.message}\n`);
}

export function startMcpStdio(options: McpStdioOptions): StdioServerHandle {
  const runBudgetGuard = options.runBudgetGuard ?? new RunBudgetGuard();
  const incrementalVerifier = options.incrementalVerifier ?? new IncrementalVerifier();
  const setOfMarksStore = options.setOfMarksStore ?? new SetOfMarksObservationStore();
  const requestScope = options.requestScope ?? createStdioRequestScope();
  return serveStdio(
    () => createMcpServer({ ...options, runBudgetGuard, incrementalVerifier, setOfMarksStore, requestScope }),
    { legacy: 'reject', onerror: options.onError ?? writeStdioDiagnostic },
  );
}
