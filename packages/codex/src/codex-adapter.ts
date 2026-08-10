import { err, ok, type Result } from '@lnwjud/domain';
import { ProcessManager, type LogQuery, type ManagedProcess, type ManagedProcessStart, type ProcessLogResult } from '@lnwjud/process';
import { CodexDiscovery } from './codex-discovery.js';
import { CodexInvocationBuilder, type CodexDiscoveryResult, type CodexInvocation, type CodexStatus } from './codex-capabilities.js';

export interface CodexDiscoveryPort {
  discover(): Promise<Result<CodexDiscoveryResult>>;
}

export interface CodexProcessManagerPort {
  start(spec: ManagedProcessStart): Promise<Result<ManagedProcess>>;
  status(processId: string): Result<ManagedProcess>;
  logs(processId: string, query: LogQuery): Result<ProcessLogResult>;
  stop(processId: string): Promise<Result<void>>;
}

export interface CodexInvocationBuilderPort {
  build(executable: string, capabilities: CodexDiscoveryResult['capabilities'], instruction: string): Result<CodexInvocation>;
}

export class CodexAdapter {
  private readonly builder: CodexInvocationBuilderPort;

  public constructor(
    private readonly discovery: CodexDiscoveryPort = new CodexDiscovery(),
    private readonly processManager: CodexProcessManagerPort = new ProcessManager(),
    builder: CodexInvocationBuilderPort = new CodexInvocationBuilder(),
  ) {
    this.builder = builder;
  }

  public async status(): Promise<Result<CodexStatus>> {
    const discovered = await this.discovery.discover();
    return discovered.ok ? ok(discovered.value.status) : discovered;
  }

  public async start(cwd: string, instruction: string): Promise<Result<ManagedProcess>> {
    const discovered = await this.discovery.discover();
    if (!discovered.ok) return discovered;
    if (!discovered.value.status.installed || discovered.value.status.executablePath === undefined) {
      return err({ code: 'CODEX_NOT_AVAILABLE', message: 'Codex is not installed', recoverable: true });
    }
    const invocation = this.builder.build(discovered.value.status.executablePath, discovered.value.capabilities, instruction);
    if (!invocation.ok) return invocation;
    return this.processManager.start({ executable: invocation.value.executable, args: invocation.value.args, cwd });
  }

  public statusProcess(processId: string): Result<ManagedProcess> {
    return this.processManager.status(processId);
  }

  public logs(processId: string, query: LogQuery): Result<ProcessLogResult> {
    return this.processManager.logs(processId, query);
  }

  public stop(processId: string): Promise<Result<void>> {
    return this.processManager.stop(processId);
  }
}
