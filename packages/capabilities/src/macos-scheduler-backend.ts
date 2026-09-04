import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appError, err, isApplicationAuthorized, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';

const execFileAsync = promisify(execFile);
const TASK_NAME_PATTERN = /^[\w .-]{1,200}$/;
const OWNED_LABEL_PREFIX = 'com.lnwjud.scheduler.';
const OWNED_PLIST_SUFFIX = '.plist';
const SUPPORTED_SCHEDULES = new Set(['DAILY', 'HOURLY']);

export interface MacOsSchedulerRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface MacOsSchedulerFileSystem {
  listDirectory(directory: string): Promise<readonly string[]>;
  readText(filePath: string): Promise<string>;
  exists(filePath: string): Promise<boolean>;
  ensureDirectory(directory: string): Promise<void>;
  writeExclusive(filePath: string, content: string): Promise<void>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  remove(filePath: string): Promise<void>;
}

export interface MacOsSchedulerBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly userId?: number;
  readonly executable?: string;
  readonly runImpl?: (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<MacOsSchedulerRunResult>;
  readonly fileSystem?: MacOsSchedulerFileSystem;
}

export class MacOsSchedulerCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly homeDirectory: string;
  private readonly userId: number | undefined;
  private readonly executable: string;
  private readonly runImpl: (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<MacOsSchedulerRunResult>;
  private readonly fileSystem: MacOsSchedulerFileSystem;

  public constructor(options: MacOsSchedulerBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.userId = options.userId ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
    this.executable = options.executable ?? '/bin/launchctl';
    this.runImpl = options.runImpl ?? (async (executable, args, signal): Promise<MacOsSchedulerRunResult> => {
      const result = await execFileAsync(executable, [...args], {
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
      };
    });
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
  }

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (this.platform !== 'darwin') return err(appError('INTERNAL_ERROR', 'launchd scheduled tasks are unavailable on this platform', true));
    const parsed = parseRequest(input);
    if (!parsed.ok) return parsed;
    const request = parsed.value;
    if (request.action === 'create' && !SUPPORTED_SCHEDULES.has(request.schedule)) {
      return err(appError('INVALID_INPUT', `macOS scheduler supports DAILY or HOURLY schedules; received ${request.schedule}`));
    }
    if (isSignalAborted(signal)) return cancelledOperation();
    if (request.dryRun) {
      return ok({
        dry_run: true,
        action: request.action,
        ...(request.taskName.length === 0 ? {} : { task_name: request.taskName, label: identityFor(request.taskName).label }),
        ...(request.action === 'create' ? {
          command: request.command,
          arguments: request.arguments,
          schedule: request.schedule,
          start_time: request.startTime,
        } : {}),
        provider: 'launchd',
      });
    }
    if (request.action !== 'list' && !isApplicationAuthorized(authorization, request.userConfirmed)) {
      return err(appError('PERMISSION_REQUIRED', 'Creating, running, or deleting a scheduled task requires explicit user confirmation'));
    }

    if (request.action === 'list') {
      try {
        return ok({ tasks: await this.listOwnedTasks(), provider: 'launchd' });
      } catch (error) {
        return err(appError('INTERNAL_ERROR', extractDetail(error) || 'Unable to inspect owned launchd tasks', true));
      }
    }
    if (this.userId === undefined || !Number.isSafeInteger(this.userId) || this.userId < 0) {
      return err(appError('INTERNAL_ERROR', 'Unable to resolve the macOS user id required for launchd scheduling', true));
    }

    const identity = identityFor(request.taskName);
    const plistPath = this.plistPath(identity.label);
    try {
      const exists = await this.fileSystem.exists(plistPath);
      if (request.action === 'create' && exists) {
        return err(appError('INVALID_INPUT', `Scheduled task ${request.taskName} already exists`));
      }
      if ((request.action === 'run' || request.action === 'delete') && !exists) {
        return err(appError('PROCESS_NOT_FOUND', `Owned scheduled task ${request.taskName} was not found`, true));
      }
    } catch (error) {
      return err(appError('INTERNAL_ERROR', extractDetail(error) || 'Unable to inspect the owned launchd task definition', true));
    }

    try {
      switch (request.action) {
        case 'create': return ok(await this.create(request, identity, plistPath, signal));
        case 'run': return ok(await this.run(identity.label, request.taskName, signal));
        case 'delete': return ok(await this.delete(identity.label, request.taskName, plistPath, signal));
      }
    } catch (error) {
      const detail = extractDetail(error);
      const reason = isSignalAborted(signal) || (error instanceof Error && error.name === 'AbortError')
        ? 'Scheduled task operation was cancelled or timed out after dispatch'
        : (detail.length > 0 ? detail : 'Scheduled task operation failed after dispatch');
      return uncertainMutationFailure(reason);
    }
  }

  private launchAgentsDirectory(): string {
    return path.posix.join(this.homeDirectory, 'Library', 'LaunchAgents');
  }

  private plistPath(label: string): string {
    return path.posix.join(this.launchAgentsDirectory(), `${label}${OWNED_PLIST_SUFFIX}`);
  }

  private async listOwnedTasks(): Promise<readonly Record<string, unknown>[]> {
    const directory = this.launchAgentsDirectory();
    let entries: readonly string[];
    try {
      entries = await this.fileSystem.listDirectory(directory);
    } catch (error) {
      if (isMissingPathError(error)) return [];
      throw error;
    }
    const tasks: Record<string, unknown>[] = [];
    for (const entry of entries.slice(0, 2_000)) {
      if (!entry.startsWith(OWNED_LABEL_PREFIX) || !entry.endsWith(OWNED_PLIST_SUFFIX)) continue;
      const label = entry.slice(0, -OWNED_PLIST_SUFFIX.length);
      const filePath = path.posix.join(directory, entry);
      try {
        const content = await this.fileSystem.readText(filePath);
        const embeddedLabel = parsePlistLabel(content);
        if (embeddedLabel !== label) continue;
        tasks.push({
          name: parseTaskName(content) ?? label,
          label,
          path: filePath,
        });
      } catch {
        tasks.push({ name: label, label, path: filePath, state: 'unreadable' });
      }
    }
    return tasks;
  }

  private async create(request: SchedulerRequest, identity: TaskIdentity, plistPath: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const directory = this.launchAgentsDirectory();
    await this.fileSystem.ensureDirectory(directory);
    const tempPath = path.posix.join(directory, `.${identity.label}.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      await this.fileSystem.writeExclusive(tempPath, buildPlist(identity.label, request.taskName, request.command, request.arguments, request.schedule, request.startTime));
      await this.fileSystem.rename(tempPath, plistPath);
      renamed = true;
    } finally {
      if (!renamed) await this.fileSystem.remove(tempPath).catch(() => undefined);
    }
    await this.runCommand(['bootstrap', this.domainTarget(), plistPath], signal);
    return {
      created: true,
      task_name: request.taskName,
      label: identity.label,
      schedule: request.schedule,
      start_time: request.startTime,
      provider: 'launchd',
    };
  }

  private async run(label: string, taskName: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.runCommand(['kickstart', '-k', `${this.domainTarget()}/${label}`], signal);
    return { started: true, task_name: taskName, label, provider: 'launchd' };
  }

  private async delete(label: string, taskName: string, plistPath: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.runCommand(['bootout', `${this.domainTarget()}/${label}`], signal);
    await this.fileSystem.remove(plistPath);
    return { deleted: true, task_name: taskName, label, provider: 'launchd' };
  }

  private domainTarget(): string {
    return `gui/${this.userId!}`;
  }

  private runCommand(args: readonly string[], signal?: AbortSignal): Promise<MacOsSchedulerRunResult> {
    return signal === undefined ? this.runImpl(this.executable, args) : this.runImpl(this.executable, args, signal);
  }
}

interface SchedulerRequest {
  readonly action: 'list' | 'create' | 'delete' | 'run';
  readonly taskName: string;
  readonly command: string;
  readonly arguments: readonly string[];
  readonly schedule: string;
  readonly startTime: string;
  readonly userConfirmed: boolean;
  readonly dryRun: boolean;
}

interface TaskIdentity {
  readonly label: string;
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
    userConfirmed: value.userConfirmed === true,
    dryRun: value.dry_run === true,
  });
}

function identityFor(taskName: string): TaskIdentity {
  const slug = taskName.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';
  const digest = createHash('sha256').update(taskName, 'utf8').digest('hex').slice(0, 12);
  return { label: `${OWNED_LABEL_PREFIX}${slug}.${digest}` };
}

function buildPlist(label: string, taskName: string, command: string, args: readonly string[], schedule: string, startTime: string): string {
  const [hour, minute] = startTime.split(':').map((value) => Number.parseInt(value, 10));
  const scheduleXml = schedule === 'HOURLY'
    ? '  <key>StartInterval</key>\n  <integer>3600</integer>'
    : [
      '  <key>StartCalendarInterval</key>',
      '  <dict>',
      '    <key>Hour</key>',
      `    <integer>${hour}</integer>`,
      '    <key>Minute</key>',
      `    <integer>${minute}</integer>`,
      '  </dict>',
    ].join('\n');
  const programArguments = [command, ...args].map((entry) => `    <string>${escapeXml(entry)}</string>`).join('\n');
  const encodedTaskName = Buffer.from(taskName, 'utf8').toString('base64');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<plist version="1.0">`,
    `<!-- lnwjud-task-name:${encodedTaskName} -->`,
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    programArguments,
    '  </array>',
    scheduleXml,
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function parseTaskName(content: string): string | undefined {
  const match = /<!--\s*lnwjud-task-name:([A-Za-z0-9+/=]+)\s*-->/.exec(content);
  if (match?.[1] === undefined) return undefined;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    return TASK_NAME_PATTERN.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function parsePlistLabel(content: string): string | undefined {
  const match = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(content);
  return match?.[1] === undefined ? undefined : unescapeXml(match[1]);
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function unescapeXml(value: string): string {
  return value.replaceAll('&apos;', "'").replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelledOperation(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Scheduled task operation was cancelled', true));
}

function uncertainMutationFailure(reason: string): Result<never> {
  return err(appError(
    'PROCESS_TIMEOUT',
    `${reason}. Scheduler mutation outcome may be unknown after dispatch; inspect the current task state before any manual retry. Do not retry automatically.`,
    true,
  ));
}

function extractDetail(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const record = error as { stderr?: unknown; message?: unknown };
  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
  if (stderr.length > 0) return stderr.slice(0, 500);
  return typeof record.message === 'string' ? record.message.slice(0, 500) : '';
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const defaultFileSystem: MacOsSchedulerFileSystem = {
  async listDirectory(directory): Promise<readonly string[]> {
    return readdir(directory);
  },
  async readText(filePath): Promise<string> {
    return readFile(filePath, 'utf8');
  },
  async exists(filePath): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
  },
  async ensureDirectory(directory): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  },
  async writeExclusive(filePath, content): Promise<void> {
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  },
  async rename(sourcePath, destinationPath): Promise<void> {
    await rename(sourcePath, destinationPath);
  },
  async remove(filePath): Promise<void> {
    await rm(filePath, { force: true });
  },
};
