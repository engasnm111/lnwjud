import { appError, err, ok, type Result } from '@lnwjud/domain';
import { formatCodexDiscoveryError, type CodexDiscoveryResult } from '@lnwjud/codex';
import type { DoctorReport } from '@lnwjud/application';
import type { Workspace } from '@lnwjud/workspace';
import { formatDoctorReport } from './commands/doctor.js';

export type CliCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'workspace-add'; readonly rootPath: string }
  | { readonly kind: 'workspace-list' }
  | { readonly kind: 'mcp-stdio'; readonly workspaceReference?: string }
  | { readonly kind: 'mcp-http'; readonly workspaceReference?: string }
  | { readonly kind: 'doctor' }
  | { readonly kind: 'codex-doctor' };

export interface CliServerHandle {
  close(): Promise<void>;
}

export interface CliStatus {
  readonly workspaceCount: number;
}

export interface CliDependencies {
  status(): Promise<CliStatus>;
  workspaceAdd(rootPath: string): Promise<Result<Workspace>>;
  workspaceList(): Promise<readonly Workspace[]>;
  mcpStdio(workspaceReference?: string): Promise<Result<{ readonly handle: CliServerHandle }>>;
  mcpHttp(workspaceReference?: string): Promise<Result<{ readonly handle: CliServerHandle }>>;
  doctor(): Promise<DoctorReport>;
  codexDoctor(): Promise<Result<CodexDiscoveryResult>>;
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
}

export function parseCliArgs(args: readonly string[]): Result<CliCommand> {
  if (args.length === 1 && args[0] === 'status') return ok({ kind: 'status' });
  if (args[0] === 'doctor' && args.length === 1) return ok({ kind: 'doctor' });
  if (args[0] === 'codex' && args[1] === 'doctor' && args.length === 2) return ok({ kind: 'codex-doctor' });
  if (args[0] === 'workspace') return parseWorkspaceArgs(args);
  if (args[0] === 'mcp') return parseMcpArgs(args);
  return err(appError('INVALID_INPUT', 'Unknown lnwjud command'));
}

export async function runCli(args: readonly string[], dependencies: CliDependencies): Promise<number> {
  const parsed = parseCliArgs(args);
  const write = dependencies.write ?? ((text: string): void => { process.stdout.write(`${text}\n`); });
  const writeError = dependencies.writeError ?? ((text: string): void => { process.stderr.write(`${text}\n`); });
  if (!parsed.ok) {
    writeError(parsed.error.message);
    return 2;
  }

  switch (parsed.value.kind) {
    case 'status': {
      const status = await dependencies.status();
      write(`workspaces: ${status.workspaceCount}`);
      return 0;
    }
    case 'workspace-add': {
      const result = await dependencies.workspaceAdd(parsed.value.rootPath);
      if (!result.ok) {
        writeError(result.error.message);
        return 1;
      }
      write(`workspace added: ${result.value.id}`);
      return 0;
    }
    case 'workspace-list': {
      const workspaces = await dependencies.workspaceList();
      for (const workspace of workspaces) write(`${workspace.id}\t${workspace.displayName}\t${workspace.rootPath}`);
      if (workspaces.length === 0) write('No workspaces configured');
      return 0;
    }
    case 'mcp-stdio':
      return runMcpLaunch(dependencies.mcpStdio, parsed.value.workspaceReference, writeError);
    case 'mcp-http':
      return runMcpLaunch(dependencies.mcpHttp, parsed.value.workspaceReference, writeError);
    case 'doctor': {
      const report = await dependencies.doctor();
      write(formatDoctorReport(report));
      return report.exitCode;
    }
    case 'codex-doctor': {
      const result = await dependencies.codexDoctor();
      if (!result.ok) {
        writeError(formatCodexDiscoveryError(result.error));
        return 1;
      }
      write(result.value.status.installed ? 'Codex available' : 'Codex not installed (optional)');
      return 0;
    }
  }
}

function parseWorkspaceArgs(args: readonly string[]): Result<CliCommand> {
  if (args[1] === 'add' && args.length === 3 && args[2] !== undefined) return ok({ kind: 'workspace-add', rootPath: args[2] });
  if (args[1] === 'list' && args.length === 2) return ok({ kind: 'workspace-list' });
  return err(appError('INVALID_INPUT', 'Usage: lnwjud workspace add <path> | workspace list'));
}

function parseMcpArgs(args: readonly string[]): Result<CliCommand> {
  let kind: 'mcp-stdio' | 'mcp-http' | undefined;
  let workspaceReference: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--stdio' || flag === '--http') {
      if (kind !== undefined) return err(appError('INVALID_INPUT', 'Choose exactly one MCP transport'));
      kind = flag === '--stdio' ? 'mcp-stdio' : 'mcp-http';
    } else if (flag === '--workspace' && args[index + 1] !== undefined) {
      workspaceReference = args[index + 1];
      index += 1;
    } else {
      return err(appError('INVALID_INPUT', 'Usage: lnwjud mcp --stdio|--http [--workspace <id-or-path>]'));
    }
  }
  if (kind === undefined) return err(appError('INVALID_INPUT', 'Choose an MCP transport with --stdio or --http'));
  return workspaceReference === undefined ? ok({ kind }) : ok({ kind, workspaceReference });
}

async function runMcpLaunch(
  launch: (workspaceReference?: string) => Promise<Result<{ readonly handle: CliServerHandle }>>,
  workspaceReference: string | undefined,
  writeError: (text: string) => void,
): Promise<number> {
  const result = await launch(workspaceReference);
  if (!result.ok) {
    writeError(result.error.message);
    return 1;
  }
  return 0;
}
