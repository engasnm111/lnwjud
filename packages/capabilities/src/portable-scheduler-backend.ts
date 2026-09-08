import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { appError, err, isApplicationAuthorized, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { sanitizedChildEnvironment } from './sanitized-child-environment.js';

const execFileAsync = promisify(execFile);
const TASK_NAME_PATTERN = /^[\w .-]{1,200}$/;
const COMMAND_PATTERN = /^[\s\S]{1,2048}$/;

interface SchedulerRequest {
  readonly action: 'list' | 'create' | 'delete' | 'run';
  readonly taskName: string;
  readonly command: string;
  readonly arguments: readonly string[];
  readonly schedule: 'DAILY' | 'WEEKLY' | 'HOURLY' | 'ONCE';
  readonly startTime: string;
  readonly startDate: string;
  /** Sunday=0 through Saturday=6, matching the public scheduler contract. */
  readonly weekday: number | null;
  readonly userConfirmed: boolean;
  readonly dryRun: boolean;
}

export interface PortableSchedulerRunResult { readonly stdout: string; readonly stderr: string; }
export interface PortableSchedulerBackendOptions {
  readonly platform: 'darwin' | 'linux';
  readonly homeDirectory?: string;
  readonly runImpl?: (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<PortableSchedulerRunResult>;
}

abstract class PortableSchedulerCapabilityBackend implements CapabilityBackend {
  private readonly homeDirectory: string;
  private readonly runImpl: (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<PortableSchedulerRunResult>;

  protected constructor(protected readonly platform: 'darwin' | 'linux', options: PortableSchedulerBackendOptions) {
    this.homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
    this.runImpl = options.runImpl ?? (async (executable: string, args: readonly string[], signal?: AbortSignal): Promise<PortableSchedulerRunResult> => {
      const result = await execFileAsync(executable, [...args], { encoding: 'utf8', shell: false, env: sanitizedChildEnvironment(), maxBuffer: 4 * 1024 * 1024, ...(signal === undefined ? {} : { signal }) });
      return { stdout: typeof result.stdout === 'string' ? result.stdout : '', stderr: typeof result.stderr === 'string' ? result.stderr : '' };
    });
  }

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const parsed = parseRequest(input);
    if (!parsed.ok) return parsed;
    const request = parsed.value;
    if (isAborted(signal)) return cancelled();
    if (request.dryRun === true) return ok({ dry_run: true, platform: this.platform, action: request.action, ...(request.taskName.length === 0 ? {} : { task_name: request.taskName }), ...(request.action === 'create' ? { command: request.command, arguments: request.arguments, schedule: request.schedule, start_time: request.startTime, ...(request.startDate.length === 0 ? {} : { start_date: request.startDate }), ...(request.weekday === null ? {} : { weekday: request.weekday }) } : {}) });
    if (request.action !== 'list' && !isApplicationAuthorized(authorization, request.userConfirmed)) return err(appError('PERMISSION_REQUIRED', `${this.platform} scheduler mutation requires explicit user confirmation`));
    try {
      switch (request.action) {
        case 'list': return ok({ available: true, ready: true, local: true, backend: this.platform === 'darwin' ? 'launchd' : 'systemd-user', tasks: await this.list(signal) });
        case 'create': return ok(await this.create(request, signal));
        case 'delete': return ok(await this.delete(request.taskName, signal));
        case 'run': return ok(await this.run(request.taskName, signal));
      }
    } catch (error: unknown) {
      if (isAborted(signal) || (error instanceof Error && error.name === 'AbortError')) return cancelled();
      if (error instanceof SchedulerConflictError) return err(appError('CONFLICT', error.message, true));
      if (request.action !== 'list') return uncertain(error instanceof Error ? error.message : `${this.platform} scheduler mutation failed`);
      return ok({ available: false, ready: false, local: true, backend: this.platform === 'darwin' ? 'launchd' : 'systemd-user', reason: 'scheduler_provider_unavailable' });
    }
  }

  protected get home(): string { return this.homeDirectory; }
  protected abstract list(signal?: AbortSignal): Promise<readonly Record<string, unknown>[]>;
  protected abstract create(request: SchedulerRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
  protected abstract delete(taskName: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  protected abstract run(taskName: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  protected command(executable: string, args: readonly string[], signal?: AbortSignal): Promise<PortableSchedulerRunResult> { return this.runImpl(executable, args, signal); }
}

export class MacosSchedulerCapabilityBackend extends PortableSchedulerCapabilityBackend {
  private get agentsDirectory(): string { return path.join(this.home, 'Library', 'LaunchAgents'); }

  public constructor(options: Omit<PortableSchedulerBackendOptions, 'platform'> = {}) { super('darwin', { ...options, platform: 'darwin' }); }

  protected async list(signal?: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    await this.command('launchctl', ['list'], signal);
    try {
      const names = (await readdir(this.agentsDirectory)).filter((name) => /^com\.lnwjud\.[\w.-]+\.plist$/u.test(name));
      const tasks = await Promise.all(names.map(async (name) => {
        const plistPath = path.join(this.agentsDirectory, name);
        const contents = await readSchedulerFile(plistPath).catch(() => null);
        return contents !== null && hasMacOwnershipMarker(contents)
          ? { name: name.slice('com.lnwjud.'.length, -'.plist'.length), path: plistPath, backend: 'launchd' }
          : null;
      }));
      return tasks.filter((task) => task !== null);
    } catch { return []; }
  }

  protected async create(request: SchedulerRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await mkdir(this.agentsDirectory, { recursive: true });
    const label = macLabel(request.taskName);
    const plistPath = path.join(this.agentsDirectory, `${label}.plist`);
    await assertMacTaskOwnership(plistPath, request.taskName);
    const temporary = `${plistPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, launchdPlist(label, request), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, plistPath);
    await this.command('launchctl', ['bootstrap', `gui/${currentUid()}`, plistPath], signal);
    return { created: true, task_name: request.taskName, label, schedule: request.schedule, start_time: request.startTime, ...(request.startDate.length === 0 ? {} : { start_date: request.startDate }), ...(request.weekday === null ? {} : { weekday: request.weekday }), backend: 'launchd' };
  }

  protected async delete(taskName: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const label = macLabel(taskName);
    const plistPath = path.join(this.agentsDirectory, `${label}.plist`);
    await assertMacTaskOwnership(plistPath, taskName);
    await this.command('launchctl', ['bootout', `gui/${currentUid()}/${label}`], signal);
    await rm(plistPath, { force: true });
    return { deleted: true, task_name: taskName, label, backend: 'launchd' };
  }

  protected async run(taskName: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const label = macLabel(taskName);
    await assertMacTaskOwnership(path.join(this.agentsDirectory, `${label}.plist`), taskName);
    await this.command('launchctl', ['kickstart', '-k', `gui/${currentUid()}/${label}`], signal);
    return { started: true, task_name: taskName, label, backend: 'launchd' };
  }
}

export class LinuxSchedulerCapabilityBackend extends PortableSchedulerCapabilityBackend {
  private get unitsDirectory(): string { return path.join(this.home, '.config', 'systemd', 'user'); }

  public constructor(options: Omit<PortableSchedulerBackendOptions, 'platform'> = {}) { super('linux', { ...options, platform: 'linux' }); }

  protected async list(signal?: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    await this.command('systemctl', ['--user', 'list-units', '--type=timer', '--all', '--no-pager', '--plain'], signal);
    try {
      const names = (await readdir(this.unitsDirectory)).filter((name) => /^lnwjud-[\w.-]+\.(service|timer)$/u.test(name));
      const tasks = await Promise.all(names.map(async (name) => {
        const unitPath = path.join(this.unitsDirectory, name);
        const contents = await readSchedulerFile(unitPath).catch(() => null);
        return contents !== null && hasLinuxOwnershipMarker(name, contents)
          ? { name, path: unitPath, backend: 'systemd-user' }
          : null;
      }));
      return tasks.filter((task) => task !== null);
    } catch { return []; }
  }

  protected async create(request: SchedulerRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await mkdir(this.unitsDirectory, { recursive: true });
    const slug = linuxSlug(request.taskName);
    const serviceName = `lnwjud-${slug}.service`;
    const timerName = `lnwjud-${slug}.timer`;
    await assertLinuxTaskOwnership(path.join(this.unitsDirectory, serviceName), path.join(this.unitsDirectory, timerName), request.taskName);
    await atomicWrite(path.join(this.unitsDirectory, serviceName), systemdService(request));
    await atomicWrite(path.join(this.unitsDirectory, timerName), systemdTimer(timerName, request));
    await this.command('systemctl', ['--user', 'daemon-reload'], signal);
    // Enabling alone only installs the login-time symlink; `--now` starts the
    // timer immediately so a newly-created schedule is active in this session.
    await this.command('systemctl', ['--user', 'enable', '--now', timerName], signal);
    return { created: true, task_name: request.taskName, service: serviceName, timer: timerName, schedule: request.schedule, start_time: request.startTime, ...(request.startDate.length === 0 ? {} : { start_date: request.startDate }), ...(request.weekday === null ? {} : { weekday: request.weekday }), backend: 'systemd-user' };
  }

  protected async delete(taskName: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const slug = linuxSlug(taskName);
    const serviceName = `lnwjud-${slug}.service`;
    const timerName = `lnwjud-${slug}.timer`;
    await assertLinuxTaskOwnership(path.join(this.unitsDirectory, serviceName), path.join(this.unitsDirectory, timerName), taskName);
    await this.command('systemctl', ['--user', 'disable', '--now', timerName], signal);
    await rm(path.join(this.unitsDirectory, serviceName), { force: true });
    await rm(path.join(this.unitsDirectory, timerName), { force: true });
    await this.command('systemctl', ['--user', 'daemon-reload'], signal);
    return { deleted: true, task_name: taskName, service: serviceName, timer: timerName, backend: 'systemd-user' };
  }

  protected async run(taskName: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const serviceName = `lnwjud-${linuxSlug(taskName)}.service`;
    const timerName = serviceName.replace(/\.service$/u, '.timer');
    await assertLinuxTaskOwnership(path.join(this.unitsDirectory, serviceName), path.join(this.unitsDirectory, timerName), taskName);
    // Starting a timer only arms future calendar events. The public `run`
    // action means execute the task now, so dispatch the oneshot service.
    await this.command('systemctl', ['--user', 'start', serviceName], signal);
    return { started: true, task_name: taskName, service: serviceName, timer: timerName, backend: 'systemd-user' };
  }
}

function parseRequest(value: unknown): Result<SchedulerRequest> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'scheduler input must be an object'));
  const action = value.action === undefined ? 'list' : value.action;
  if (action !== 'list' && action !== 'create' && action !== 'delete' && action !== 'run') return err(appError('INVALID_INPUT', 'scheduler action is invalid'));
  const taskName = value.task_name === undefined ? '' : value.task_name;
  if (action !== 'list' && (typeof taskName !== 'string' || !TASK_NAME_PATTERN.test(taskName.trim()))) return err(appError('INVALID_INPUT', 'task_name must contain only safe scheduler characters'));
  const command = value.command === undefined ? '' : value.command;
  if (action === 'create' && (typeof command !== 'string' || command.length > 2_048 || !COMMAND_PATTERN.test(command.trim()) || command.trim().length === 0 || hasUnsafeControlCharacter(command))) return err(appError('INVALID_INPUT', 'command is required and must not contain control characters (at most 2048 characters)'));
  const args = value.arguments === undefined ? [] : value.arguments;
  if (action === 'create' && (!Array.isArray(args) || args.length > 64 || !args.every((entry) => typeof entry === 'string' && entry.length <= 2_048 && !hasUnsafeControlCharacter(entry)))) return err(appError('INVALID_INPUT', 'arguments must be at most 64 strings without control characters'));
  if (action === 'create' && value.schedule !== undefined && typeof value.schedule !== 'string') return err(appError('INVALID_INPUT', 'schedule must be DAILY, WEEKLY, HOURLY, or ONCE'));
  const schedule = typeof value.schedule === 'string' ? value.schedule.toUpperCase() : 'DAILY';
  if (action === 'create' && !['DAILY', 'WEEKLY', 'HOURLY', 'ONCE'].includes(schedule)) return err(appError('INVALID_INPUT', 'schedule must be DAILY, WEEKLY, HOURLY, or ONCE'));
  const startTime = value.start_time === undefined ? '09:00' : value.start_time;
  if (action === 'create' && (typeof startTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(startTime))) return err(appError('INVALID_INPUT', 'start_time must be HH:MM'));
  const startDate = value.start_date === undefined ? '' : value.start_date;
  if (action === 'create' && startDate !== '' && (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(startDate))) return err(appError('INVALID_INPUT', 'start_date must be YYYY-MM-DD'));
  if (action === 'create' && schedule === 'ONCE' && (typeof startDate !== 'string' || startDate.length === 0)) return err(appError('INVALID_INPUT', 'ONCE schedules require start_date in YYYY-MM-DD format'));
  const weekday = value.weekday === undefined ? null : value.weekday;
  if (action === 'create' && weekday !== null && (!Number.isInteger(weekday) || (weekday as number) < 0 || (weekday as number) > 6)) return err(appError('INVALID_INPUT', 'weekday must be an integer from 0 (Sunday) to 6 (Saturday)'));
  if (action === 'create' && schedule === 'WEEKLY' && weekday === null) return err(appError('INVALID_INPUT', 'WEEKLY schedules require weekday 0 (Sunday) through 6 (Saturday)'));
  return ok({ action, taskName: typeof taskName === 'string' ? taskName.trim() : '', command: typeof command === 'string' ? command.trim() : '', arguments: Array.isArray(args) ? args.filter((entry): entry is string => typeof entry === 'string') : [], schedule: ['DAILY', 'WEEKLY', 'HOURLY', 'ONCE'].includes(schedule) ? schedule as SchedulerRequest['schedule'] : 'DAILY', startTime: typeof startTime === 'string' ? startTime : '09:00', startDate: typeof startDate === 'string' ? startDate : '', weekday: typeof weekday === 'number' ? weekday : null, userConfirmed: value.userConfirmed === true, dryRun: value.dry_run === true });
}

function launchdPlist(label: string, request: SchedulerRequest): string {
  const argumentsXml = [request.command, ...request.arguments].map((value) => `    <string>${xml(value)}</string>`).join('\n');
  const calendar = request.schedule === 'HOURLY'
    ? '      <key>Minute</key>\n      <integer>0</integer>'
    : request.schedule === 'ONCE'
      ? `      <key>Year</key>\n      <integer>${Number(request.startDate.slice(0, 4))}</integer>\n      <key>Month</key>\n      <integer>${Number(request.startDate.slice(5, 7))}</integer>\n      <key>Day</key>\n      <integer>${Number(request.startDate.slice(8, 10))}</integer>\n      <key>Hour</key>\n      <integer>${Number(request.startTime.slice(0, 2))}</integer>\n      <key>Minute</key>\n      <integer>${Number(request.startTime.slice(3))}</integer>`
      : `${request.schedule === 'WEEKLY' ? `      <key>Weekday</key>\n      <integer>${request.weekday ?? 0}</integer>\n` : ''}      <key>Hour</key>\n      <integer>${Number(request.startTime.slice(0, 2))}</integer>\n      <key>Minute</key>\n      <integer>${Number(request.startTime.slice(3))}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xml(label)}</string>\n  <key>lnwjudTaskName</key><string>${xml(request.taskName)}</string>\n  <key>ProgramArguments</key><array>\n${argumentsXml}\n  </array>\n  <key>RunAtLoad</key><false/>\n  <key>StartCalendarInterval</key><dict>\n${calendar}\n  </dict>\n</dict></plist>\n`;
}

function systemdService(request: SchedulerRequest): string {
  return `[Unit]\nDescription=lnwjud ${request.taskName}\n\n[Service]\nType=oneshot\nExecStart=${systemdArg(request.command)}${request.arguments.map((value) => ` ${systemdArg(value)}`).join('')}\n`;
}

function systemdTimer(timerName: string, request: SchedulerRequest): string {
  const onCalendar = request.schedule === 'HOURLY'
    ? '*-*-* *:00:00'
    : request.schedule === 'ONCE'
      ? `${request.startDate} ${request.startTime}:00`
      : request.schedule === 'WEEKLY'
        ? `${weekdayName(request.weekday ?? 0)} *-*-* ${request.startTime}:00`
        : `*-*-* ${request.startTime}:00`;
  return `[Unit]\nDescription=lnwjud timer ${request.taskName}\n\n[Timer]\nOnCalendar=${onCalendar}\nPersistent=true\nUnit=${timerName.replace(/\.timer$/u, '.service')}\n\n[Install]\nWantedBy=timers.target\n`;
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let committed = false;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filePath);
    committed = true;
  } finally {
    if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function macLabel(taskName: string): string { return `com.lnwjud.${linuxSlug(taskName)}`; }
function linuxSlug(taskName: string): string { return taskName.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'task'; }
function weekdayName(value: number): string { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][value] ?? 'Sun'; }
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function systemdArg(value: string): string {
  // systemd expands percent specifiers in ExecStart and OnCalendar values;
  // doubling the character is the documented way to pass a literal `%`.
  const escaped = value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return /[\s\\"'`%]/u.test(value) ? `"${escaped}"` : escaped;
}
function hasUnsafeControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1F || code === 0x7F) return true;
  }
  return false;
}
function currentUid(): number { return typeof process.getuid === 'function' ? process.getuid() : 0; }
function isAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Scheduler operation was cancelled', true)); }
function uncertain(reason: string): Result<never> { return err(appError('PROCESS_TIMEOUT', `${reason.slice(0, 500)} Scheduler mutation outcome may be unknown after dispatch; inspect state before retrying.`, true)); }

class SchedulerConflictError extends Error {}

async function assertMacTaskOwnership(plistPath: string, taskName: string): Promise<void> {
  const existing = await readSchedulerFile(plistPath);
  if (existing === null) return;
  const marker = `<key>lnwjudTaskName</key><string>${xml(taskName)}</string>`;
  if (!existing.includes(marker)) throw new SchedulerConflictError(`launchd label already belongs to a different or unmanaged task: ${path.basename(plistPath)}`);
}

async function assertLinuxTaskOwnership(servicePath: string, timerPath: string, taskName: string): Promise<void> {
  const [service, timer] = await Promise.all([
    readSchedulerFile(servicePath),
    readSchedulerFile(timerPath),
  ]);
  const expectedServiceDescription = `Description=lnwjud ${taskName}`;
  const expectedTimerDescription = `Description=lnwjud timer ${taskName}`;
  if (service !== null && !service.split(/\r?\n/u).includes(expectedServiceDescription)) {
    throw new SchedulerConflictError(`systemd unit already belongs to a different or unmanaged task: ${path.basename(servicePath)}`);
  }
  if (timer !== null && !timer.split(/\r?\n/u).includes(expectedTimerDescription)) {
    throw new SchedulerConflictError(`systemd timer already belongs to a different or unmanaged task: ${path.basename(timerPath)}`);
  }
}

async function readSchedulerFile(filePath: string): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error: unknown) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new SchedulerConflictError(`scheduler path is not a regular file owned by lnwjud: ${path.basename(filePath)}`);
  }
  return readFile(filePath, 'utf8');
}

function hasMacOwnershipMarker(contents: string): boolean {
  return /<key>lnwjudTaskName<\/key><string>[^<]{1,200}<\/string>/u.test(contents);
}

function hasLinuxOwnershipMarker(name: string, contents: string): boolean {
  const marker = name.endsWith('.timer') ? /^Description=lnwjud timer .+$/mu : /^Description=lnwjud .+$/mu;
  return marker.test(contents);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
