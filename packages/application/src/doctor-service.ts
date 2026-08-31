export type DoctorCheckId = 'os' | 'database' | 'git' | 'ripgrep' | 'workspaces' | 'mcp-port' | 'codex';
export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorProbeResult {
  readonly status: DoctorCheckStatus;
  readonly message: string;
}

export interface DoctorProbes {
  os(): Promise<DoctorProbeResult>;
  database(): Promise<DoctorProbeResult>;
  git(): Promise<DoctorProbeResult>;
  ripgrep(): Promise<DoctorProbeResult>;
  workspaces(): Promise<DoctorProbeResult>;
  mcpPort(): Promise<DoctorProbeResult>;
  codex(): Promise<DoctorProbeResult>;
}

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  readonly required: boolean;
  readonly status: DoctorCheckStatus;
  readonly message: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly exitCode: 0 | 1;
}

interface CheckDefinition {
  readonly id: DoctorCheckId;
  readonly required: boolean;
  readonly probe: () => Promise<DoctorProbeResult>;
}

export class DoctorService {
  public constructor(private readonly probes: DoctorProbes) {}

  public async run(): Promise<DoctorReport> {
    const definitions: readonly CheckDefinition[] = [
      { id: 'os', required: true, probe: () => this.probes.os() },
      { id: 'database', required: true, probe: () => this.probes.database() },
      { id: 'git', required: false, probe: () => this.probes.git() },
      { id: 'ripgrep', required: true, probe: () => this.probes.ripgrep() },
      // A clean profile has no project yet. Keep that state visible in Doctor,
      // but never make the recovery action itself a startup prerequisite.
      { id: 'workspaces', required: false, probe: () => this.probes.workspaces() },
      { id: 'mcp-port', required: true, probe: () => this.probes.mcpPort() },
      { id: 'codex', required: false, probe: () => this.probes.codex() },
    ];
    const checks: DoctorCheck[] = [];
    for (const definition of definitions) checks.push(await this.runCheck(definition));
    const hasFatalFailure = checks.some((check) => check.required && check.status === 'fail');
    return { checks, exitCode: hasFatalFailure ? 1 : 0 };
  }

  private async runCheck(definition: CheckDefinition): Promise<DoctorCheck> {
    try {
      const result = await definition.probe();
      return {
        id: definition.id,
        required: definition.required,
        status: result.status,
        message: redactDoctorMessage(result.message),
      };
    } catch {
      return {
        id: definition.id,
        required: definition.required,
        status: 'fail',
        message: 'Check could not be completed',
      };
    }
  }
}

function redactDoctorMessage(message: string): string {
  return message
    .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
}
