import { AutomationStateError } from '@lnwjud/domain';

export type AutomationTaskExecution =
  | {
      readonly provider: 'shell';
      readonly executable: string;
      readonly arguments: readonly string[];
      readonly cwd?: string;
      readonly timeoutMs?: number;
    }
  | {
      readonly provider: 'process';
      readonly executable: string;
      readonly args: readonly string[];
      readonly cwd?: string;
      readonly timeoutMs?: number;
    }
  | {
      readonly provider: 'codex';
      readonly instruction: string;
    };

export type AutomationExecutionPolicyCode =
  | 'allowed'
  | 'unknown_policy_profile'
  | 'browser_or_desktop_control_denied'
  | 'destructive_workspace_operation_denied'
  | 'explicit_authorization_required'
  | 'invalid_execution';

export type AutomationExecutionPolicyDecision =
  | {
      readonly allowed: true;
      readonly code: 'allowed';
      readonly reason: string;
    }
  | {
      readonly allowed: false;
      readonly code: Exclude<AutomationExecutionPolicyCode, 'allowed'>;
      readonly reason: string;
    };

export interface AutomationExecutionPolicyInput {
  readonly policyProfile: string;
  readonly execution: AutomationTaskExecution;
  readonly userConfirmed: boolean;
}

const MAX_EXECUTABLE = 1_024;
const MAX_ARGUMENT = 8_192;
const MAX_ARGUMENTS = 512;
const MAX_INSTRUCTION = 32_768;

const UI_EXECUTABLES = new Set([
  'chrome', 'chrome.exe', 'chromium', 'chromium.exe',
  'msedge', 'msedge.exe', 'firefox', 'firefox.exe',
  'playwright', 'playwright.cmd', 'selenium-side-runner',
  'xdotool', 'ydotool', 'cliclick', 'osascript',
]);

const UI_TEXT_PATTERNS = [
  /\bplaywright\b/i,
  /\bselenium\b/i,
  /\bpyautogui\b/i,
  /\bpynput\b/i,
  /\bxdotool\b/i,
  /\buser32\b/i,
  /\bmouse_event\b/i,
  /\bkeybd_event\b/i,
  /\bsendkeys?\b/i,
  /\bappactivate\b/i,
  /\buiautomation\b/i,
];

const DESTRUCTIVE_PATTERNS = [
  /\bgit\s+clean(?:\s|$)/i,
  /\bgit\s+reset\s+--hard(?:\s|$)/i,
  /\bgit\s+worktree\s+remove(?:\s|$)/i,
  /\bgit\s+checkout\s+--\s+[.*]/i,
  /\bgit\s+restore\s+(?:--source\s+\S+\s+)?(?:--worktree\s+)?(?:--staged\s+)?[.*](?:\s|$)/i,
  /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)(?:\s|$)/i,
  /\brm\s+--recursive\b/i,
  /\brmdir\s+\/(?:s|q)(?:\s|$)/i,
  /\brd\s+\/(?:s|q)(?:\s|$)/i,
  /\bremove-item\b[^\r\n]*\s-(?:recurse|r)\b/i,
  /\bdel\s+\/s(?:\s|$)/i,
  /\berase\s+\/s(?:\s|$)/i,
];

const EXPLICIT_AUTH_PATTERNS = [
  /\bgit\s+push(?:\s|$)/i,
  /\bgit\s+merge(?:\s|$)/i,
  /\bgit\s+tag(?:\s|$)/i,
  /\bgh\s+release(?:\s|$)/i,
  /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?publish(?:\s|$)/i,
  /\bdocker\s+push(?:\s|$)/i,
  /\bkubectl\s+(?:apply|delete|rollout)(?:\s|$)/i,
  /\b(?:vercel|netlify)\s+(?:deploy|--prod)(?:\s|$)/i,
  /\bdeploy(?:\s|$)/i,
];

export class AutomationExecutionPolicyService {
  public decide(input: AutomationExecutionPolicyInput): AutomationExecutionPolicyDecision {
    if (input.policyProfile !== 'coding_guarded') {
      return deny(
        'unknown_policy_profile',
        `Automation policy profile is not supported by the native execution layer: ${input.policyProfile}`,
      );
    }

    const validation = validateExecution(input.execution);
    if (validation !== null) return validation;

    if (input.execution.provider === 'codex') {
      if (!input.userConfirmed) {
        return deny(
          'explicit_authorization_required',
          'Codex workspace execution is opaque and requires explicit user authorization',
        );
      }
      return allow('Codex execution is allowed only after explicit user authorization and remains subject to ToolRegistry policy');
    }

    const executable = basename(input.execution.executable);
    const args = input.execution.provider === 'shell'
      ? input.execution.arguments
      : input.execution.args;
    const text = commandText(input.execution);
    if (UI_EXECUTABLES.has(executable) || UI_TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
      return deny(
        'browser_or_desktop_control_denied',
        'coding_guarded automation forbids browser, desktop, keyboard, mouse, and UI automation',
      );
    }

    const gitDecision = structuredGitDecision(executable, args, input.userConfirmed);
    if (gitDecision !== null) return gitDecision;

    if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(text))) {
      return deny(
        'destructive_workspace_operation_denied',
        'coding_guarded automation forbids recursive workspace/repository deletion and destructive Git cleanup/reset operations',
      );
    }

    if (EXPLICIT_AUTH_PATTERNS.some((pattern) => pattern.test(text)) && !input.userConfirmed) {
      return deny(
        'explicit_authorization_required',
        'Push, merge, tag, publish, release, and deploy operations require explicit user authorization',
      );
    }

    return allow('Execution passed the additional coding_guarded automation policy');
  }

  public assertAllowed(input: AutomationExecutionPolicyInput): void {
    const decision = this.decide(input);
    if (decision.allowed) return;
    throw new AutomationStateError('conflict', `${decision.code}: ${decision.reason}`);
  }
}

function structuredGitDecision(
  executable: string,
  args: readonly string[],
  userConfirmed: boolean,
): AutomationExecutionPolicyDecision | null {
  if (executable !== 'git' && executable !== 'git.exe') return null;
  const command = args.find((arg) => !arg.startsWith('-'))?.toLowerCase();
  if (command === undefined) return null;
  if (
    command === 'clean'
    || (command === 'reset' && args.some((arg) => arg.toLowerCase() === '--hard'))
    || (command === 'worktree' && args.some((arg) => arg.toLowerCase() === 'remove'))
  ) {
    return deny(
      'destructive_workspace_operation_denied',
      'coding_guarded automation forbids destructive Git cleanup/reset/worktree removal',
    );
  }
  if (command === 'push' || command === 'merge' || command === 'tag') {
    return userConfirmed
      ? null
      : deny(
          'explicit_authorization_required',
          'Push, merge, and tag operations require explicit user authorization',
        );
  }
  return null;
}

function commandText(execution: Extract<AutomationTaskExecution, { provider: 'shell' | 'process' }>): string {
  const args = execution.provider === 'shell' ? execution.arguments : execution.args;
  return [execution.executable, ...args].join(' ');
}

function basename(value: string): string {
  return value.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)?.toLowerCase() ?? value.toLowerCase();
}

function validateExecution(execution: AutomationTaskExecution): AutomationExecutionPolicyDecision | null {
  if (execution.provider === 'codex') {
    if (execution.instruction.trim().length === 0 || execution.instruction.length > MAX_INSTRUCTION || containsControl(execution.instruction)) {
      return deny('invalid_execution', 'Codex automation instruction is invalid');
    }
    return null;
  }

  if (
    execution.executable.trim().length === 0
    || execution.executable.length > MAX_EXECUTABLE
    || containsControl(execution.executable)
  ) {
    return deny('invalid_execution', 'Automation executable is invalid');
  }
  const args = execution.provider === 'shell' ? execution.arguments : execution.args;
  if (args.length > MAX_ARGUMENTS) return deny('invalid_execution', 'Automation command has too many arguments');
  if (args.some((arg) => arg.length > MAX_ARGUMENT || containsControl(arg))) {
    return deny('invalid_execution', 'Automation command argument is invalid');
  }
  if (execution.cwd !== undefined && (execution.cwd.trim().length === 0 || containsControl(execution.cwd))) {
    return deny('invalid_execution', 'Automation command cwd is invalid');
  }
  if (
    execution.timeoutMs !== undefined
    && (!Number.isInteger(execution.timeoutMs) || execution.timeoutMs < 1_000 || execution.timeoutMs > 86_400_000)
  ) {
    return deny('invalid_execution', 'Automation command timeoutMs must be between 1000 and 86400000');
  }
  return null;
}

function allow(reason: string): AutomationExecutionPolicyDecision {
  return { allowed: true, code: 'allowed', reason };
}

function deny(
  code: Exclude<AutomationExecutionPolicyCode, 'allowed'>,
  reason: string,
): AutomationExecutionPolicyDecision {
  return { allowed: false, code, reason };
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 0x1f || point === 0x7f)) return true;
  }
  return false;
}
