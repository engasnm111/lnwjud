import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';

const execFileAsync = promisify(execFile);
const TASK_NAME_PATTERN = /^[\w .-]{1,200}$/;

export interface SchedulerRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface SchedulerBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly executable?: string;
  readonly runImpl?: (executable: string, args: readonly string[]) => Promise<SchedulerRunResult>;
}

export class SchedulerCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly executable: string;
  private readonly runImpl: (executable: string, args: readonly string[]) => Promise<SchedulerRunResult>;

  public constructor(options: SchedulerBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.executable = options.executable ?? 'schtasks.exe';
    this.runImpl = options.runImpl ?? (async (executable, args): Promise<SchedulerRunResult> => {
      const result = await execFileAsync(executable, [...args], { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      return { stdout: typeof result.stdout === 'string' ? result.stdout : '', stderr: typeof result.stderr === 'string' ? result.stderr : '' };
    });
  }

  public async execute(input: unknown): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return err(appError('INTERNAL_ERROR', 'Scheduled tasks are unavailable on this platform', true));
    const parsed = parseRequest(input);
    if (!parsed.ok) return parsed;
    const request = parsed.value;

    try {
      switch (request.action) {
        case 'list': return ok({ tasks: await this.list() });
        case 'create': return ok(await this.create(request.taskName, request.command, request.arguments ?? [], request.schedule ?? 'DAILY', request.startTime ?? '09:00'));
        case 'delete': return ok(await this.delete(request.taskName));
        case 'run': return ok(await this.run(request.taskName));
      }
    } catch (error: unknown) {
      const detail = extractDetail(error);
      return err(appError('INTERNAL_ERROR', detail.length > 0 ? detail : 'Scheduled task operation failed', true));
    }
  }

  private async list(): Promise<readonly Record<string, unknown>[]> {
    const result = await this.runImpl(this.executable, ['/Query', '/FO', 'LIST']);
    const lines = result.stdout.split(/\r?\n/);
    const tasks: Record<string, unknown>[] = [];
    let current: Record<string, unknown> | null = null;
    for (const raw of lines) {
      const separator = raw.indexOf(':');
      if (separator < 0) {
        if (current !== null) {
          tasks.push(current);
          current = null;
        }
        continue;
      }
      const key = raw.slice(0, separator).trim();
      const value = raw.slice(separator + 1).trim();
      if (key.length === 0 || value.length === 0) continue;
      if (key === 'TaskName') {
        if (current !== null) tasks.push(current);
        current = { name: value };
      } else if (current !== null) {
        current[key.toLowerCase().replace(/[^a-z0-9]/g, '_')] = value;
      }
    }
    if (current !== null) tasks.push(current);
    return tasks;
  }

  private async create(taskName: string, command: string, args: readonly string[], schedule: string, startTime: string): Promise<Record<string, unknown>> {
    const taskRun = buildTaskRun(command, args);
    await this.runImpl(this.executable, [
      '/Create', '/TN', taskName, '/TR', taskRun,
      '/SC', schedule.toUpperCase(), '/ST', startTime, '/F',
    ]);
    return { created: true, task_name: taskName, schedule, start_time: startTime };
  }

  private async delete(taskName: string): Promise<Record<string, unknown>> {
    await this.runImpl(this.executable, ['/Delete', '/TN', taskName, '/F']);
    return { deleted: true, task_name: taskName };
  }

  private async run(taskName: string): Promise<Record<string, unknown>> {
    await this.runImpl(this.executable, ['/Run', '/TN', taskName]);
    return { started: true, task_name: taskName };
  }
}

interface SchedulerRequest {
  readonly action: 'list' | 'create' | 'delete' | 'run';
  readonly taskName: string;
  readonly command: string;
  readonly arguments: readonly string[];
  readonly schedule: string;
  readonly startTime: string;
}

function parseRequest(value: unknown): Result<SchedulerRequest> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'scheduler input must be an object'));
  const action: unknown = value.action === undefined ? 'list' : value.action;
  if (action !== 'list' && action !== 'create' && action !== 'delete' && action !== 'run') {
    return err(appError('INVALID_INPUT', 'scheduler action is invalid'));
  }
  const taskName: unknown = value.task_name === undefined ? '' : value.task_name;
  if (action !== 'list' && (typeof taskName !== 'string' || !TASK_NAME_PATTERN.test(taskName.trim()))) {
    return err(appError('INVALID_INPUT', 'task_name must be 1-200 letters, digits, spaces, dots, dashes, or underscores'));
  }
  const command: unknown = value.command === undefined ? '' : value.command;
  if (action === 'create' && (typeof command !== 'string' || command.trim().length === 0 || command.length > 2_048)) {
    return err(appError('INVALID_INPUT', 'command is required (at most 2048 characters)'));
  }
  const argumentsValue: unknown = value.arguments === undefined ? [] : value.arguments;
  if (action === 'create' && (!Array.isArray(argumentsValue) || argumentsValue.length > 64 || !argumentsValue.every((entry) => typeof entry === 'string' && entry.length <= 2_048))) {
    return err(appError('INVALID_INPUT', 'arguments must be at most 64 strings'));
  }
  const schedule: unknown = value.schedule === undefined ? 'DAILY' : value.schedule;
  if (action === 'create' && (typeof schedule !== 'string' || !/^[A-Z]{1,16}$/.test(schedule.toUpperCase()))) {
    return err(appError('INVALID_INPUT', 'schedule must be a short uppercase schedule name (e.g. DAILY)'));
  }
  const startTime: unknown = value.start_time === undefined ? '09:00' : value.start_time;
  if (action === 'create' && (typeof startTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime))) {
    return err(appError('INVALID_INPUT', 'start_time must be HH:MM'));
  }
  return ok({
    action,
    taskName: typeof taskName === 'string' ? taskName.trim() : '',
    command: typeof command === 'string' ? command.trim() : '',
    arguments: action === 'create' && Array.isArray(argumentsValue) ? argumentsValue.filter((entry): entry is string => typeof entry === 'string') : [],
    schedule: typeof schedule === 'string' ? schedule.toUpperCase() : 'DAILY',
    startTime: typeof startTime === 'string' ? startTime : '09:00',
  });
}

function buildTaskRun(command: string, args: readonly string[]): string {
  const quoted = [command, ...args].map((entry) => /[\s"]/.test(entry) ? `"${entry.replaceAll('"', '\\"')}"` : entry).join(' ');
  return quoted.length > 250 ? quoted.slice(0, 250) : quoted;
}

function extractDetail(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const record = error as { stderr?: unknown; message?: unknown };
  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
  if (stderr.length > 0) return stderr.slice(0, 500);
  return typeof record.message === 'string' ? record.message.slice(0, 500) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
