import { randomUUID } from 'node:crypto';
import {
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import type { AppError } from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import {
  DEFAULT_MCP_POLL_WAIT_SECONDS,
  MAX_CONFIGURABLE_WAIT_SECONDS,
  MIN_CONFIGURABLE_WAIT_SECONDS,
} from '@lnwjud/shared';
import type { McpApplicationServices } from './tool-registry.js';
import type { McpToolResponse } from './result-mapper.js';
import { withCapabilityOwnerMetadata } from './request-scope.js';

export const MODERN_TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';

const TASK_ID_PREFIX = 'lnwjud-task-v1.';
const TASK_DESCRIPTOR_VERSION = 1;
const MAX_TASK_ID_BYTES = 4096;

type ModernTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
type TaskProvider = 'shell' | 'process';

interface ModernTaskDescriptor {
  readonly v: 1;
  readonly nonce: string;
  readonly provider: TaskProvider;
  readonly backingId: string;
  readonly toolName: string;
  readonly workspaceId?: string;
}

interface ModernTaskBase {
  readonly taskId: string;
  readonly status: ModernTaskStatus;
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number | null;
  readonly pollIntervalMs: number;
}

export type ModernTaskCreateResult = Record<string, unknown> & ModernTaskBase & {
  readonly resultType: 'task';
};

export type ModernTaskGetResult = Record<string, unknown> & ModernTaskBase & {
  readonly resultType: 'complete';
  readonly result?: McpToolResponse;
};

export type ModernTaskCompleteResult = Record<string, unknown> & {
  readonly resultType: 'complete';
};

interface ProviderObservation {
  readonly value: Record<string, unknown>;
  readonly status: ModernTaskStatus;
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number | null;
  readonly resultIsError: boolean;
}

export interface ModernTasksProtocolOptions {
  readonly actor: FileActor;
}

export class ModernTasksProtocol {
  private readonly actor: FileActor;

  public constructor(
    private readonly services: McpApplicationServices,
    options: ModernTasksProtocolOptions,
  ) {
    this.actor = options.actor;
  }

  public async maybeCreateTask(
    toolName: string,
    input: unknown,
    response: McpToolResponse,
  ): Promise<ModernTaskCreateResult | undefined> {
    if (response.isError === true) return undefined;
    const descriptor = this.descriptorFor(toolName, input, response);
    if (descriptor === undefined) return undefined;
    const taskId = encodeTaskId(descriptor);

    // Strong-consistency boundary: never return a CreateTaskResult unless the
    // authoritative backing handle is already resolvable by tasks/get.
    const observation = await this.observe(descriptor);
    return {
      resultType: 'task',
      ...toTaskBase(taskId, observation, this.currentPollIntervalMs()),
    };
  }

  public async getTask(params: { readonly taskId: string }): Promise<ModernTaskGetResult> {
    const descriptor = decodeTaskId(params.taskId);
    const observation = await this.observe(descriptor);
    const base = toTaskBase(params.taskId, observation, this.currentPollIntervalMs());
    if (observation.status !== 'completed') return { resultType: 'complete', ...base };
    return {
      resultType: 'complete',
      ...base,
      result: resultForDescriptor(descriptor, observation.value, observation.resultIsError),
    };
  }

  public async updateTask(params: { readonly taskId: string; readonly inputResponses: Record<string, unknown> }): Promise<ModernTaskCompleteResult> {
    // lnwjud-managed shell/process tasks never enter input_required today. We
    // still validate task ownership/existence and intentionally ignore unknown
    // response keys, matching the extension's forward-compatible update rule.
    void params.inputResponses;
    await this.getTask({ taskId: params.taskId });
    return { resultType: 'complete' };
  }

  public async cancelTask(params: { readonly taskId: string }): Promise<ModernTaskCompleteResult> {
    const descriptor = decodeTaskId(params.taskId);
    const current = await this.observe(descriptor);
    if (current.status === 'completed' || current.status === 'cancelled') return { resultType: 'complete' };

    if (descriptor.provider === 'shell') {
      const capabilities = this.services.capabilities;
      if (capabilities === undefined) throw internalError('Capability service is unavailable');
      const cancelled = await capabilities.execute('shell', withCapabilityOwnerMetadata({
        operation: 'cancel',
        task_id: descriptor.backingId,
        include_stdout: true,
        include_stderr: true,
        userConfirmed: true,
        ...(descriptor.workspaceId === undefined ? {} : { workspaceId: descriptor.workspaceId }),
      }, this.actor));
      if (!cancelled.ok) throw providerError(cancelled.error);
      return { resultType: 'complete' };
    }

    const processService = this.services.process;
    if (processService === undefined || descriptor.workspaceId === undefined) {
      throw internalError('Managed process service is unavailable');
    }
    const stopped = await processService.stop(this.actor, descriptor.workspaceId, descriptor.backingId, true);
    if (!stopped.ok) throw providerError(stopped.error);
    return { resultType: 'complete' };
  }

  private descriptorFor(toolName: string, input: unknown, response: McpToolResponse): ModernTaskDescriptor | undefined {
    const structured = asRecord(response.structuredContent);
    if (structured === undefined) return undefined;
    const request = asRecord(input);
    const workspaceId = boundedString(request?.workspaceId, 128);

    const shellTaskId = boundedString(structured.task_id, 256);
    const shellRequest = toolName === 'shell' && (request?.operation === undefined || request.operation === 'run');
    if (shellTaskId !== undefined && (shellRequest || toolName === 'task_create')) {
      return taskDescriptor('shell', shellTaskId, toolName, workspaceId);
    }

    const directProcessId = boundedString(structured.processId, 256);
    if (directProcessId !== undefined && workspaceId !== undefined && isDirectProcessTool(toolName)) {
      return taskDescriptor('process', directProcessId, toolName, workspaceId);
    }

    const nestedProcess = asRecord(structured.process);
    const nestedProcessId = boundedString(nestedProcess?.processId, 256);
    if (nestedProcessId !== undefined && workspaceId !== undefined && isWrappedProcessTool(toolName)) {
      return taskDescriptor('process', nestedProcessId, toolName, workspaceId);
    }
    return undefined;
  }

  private async observe(descriptor: ModernTaskDescriptor): Promise<ProviderObservation> {
    if (descriptor.provider === 'shell') return this.observeShell(descriptor);
    return this.observeProcess(descriptor);
  }

  private async observeShell(descriptor: ModernTaskDescriptor): Promise<ProviderObservation> {
    const capabilities = this.services.capabilities;
    if (capabilities === undefined) throw internalError('Capability service is unavailable');
    const result = await capabilities.execute('shell', withCapabilityOwnerMetadata({
      operation: 'status',
      task_id: descriptor.backingId,
      include_stdout: true,
      include_stderr: true,
      ...(descriptor.workspaceId === undefined ? {} : { workspaceId: descriptor.workspaceId }),
    }, this.actor));
    if (!result.ok) throw providerError(result.error);
    const value = asRecord(result.value);
    if (value === undefined) throw internalError('Shell task returned an invalid status payload');

    const state = boundedString(value.state, 64) ?? 'failed';
    const createdAt = isoString(value.started_at) ?? new Date(0).toISOString();
    const finishedAt = isoString(value.finished_at);
    const status: ModernTaskStatus = state === 'running' || state === 'termination_unverified'
      ? 'working'
      : state === 'cancelled'
        ? 'cancelled'
        : state === 'completed'
          ? 'completed'
          : 'failed';
    const error = boundedString(value.error, 2048);
    return {
      value,
      status,
      ...((state === 'termination_unverified' || status === 'failed') && error !== undefined
        ? { statusMessage: error }
        : {}),
      createdAt,
      lastUpdatedAt: finishedAt ?? createdAt,
      ttlMs: taskTtlMs(createdAt, isoString(value.deadline_at)),
      resultIsError: status === 'failed',
    };
  }

  private async observeProcess(descriptor: ModernTaskDescriptor): Promise<ProviderObservation> {
    const processService = this.services.process;
    if (processService === undefined || descriptor.workspaceId === undefined) {
      throw internalError('Managed process service is unavailable');
    }
    const result = await processService.status(this.actor, descriptor.workspaceId, descriptor.backingId);
    if (!result.ok) throw providerError(result.error);
    const value = asRecord(result.value);
    if (value === undefined) throw internalError('Managed process returned an invalid status payload');

    const state = boundedString(value.state, 64) ?? 'failed';
    const createdAt = isoString(value.startedAt) ?? new Date(0).toISOString();
    const finishedAt = isoString(value.finishedAt);
    const error = boundedString(value.error, 2048);
    const exitCode = typeof value.exitCode === 'number' ? value.exitCode : undefined;
    const status: ModernTaskStatus = state === 'starting' || state === 'running' || state === 'termination_unverified'
      ? 'working'
      : state === 'stopped'
        ? 'cancelled'
        : state === 'exited' && (exitCode === undefined || exitCode === 0)
          ? 'completed'
          : 'failed';
    const resultIsError = status === 'failed';
    return {
      value,
      status,
      ...((state === 'termination_unverified' || resultIsError) && error !== undefined ? { statusMessage: error } : {}),
      createdAt,
      lastUpdatedAt: finishedAt ?? createdAt,
      ttlMs: null,
      resultIsError,
    };
  }

  private currentPollIntervalMs(): number {
    const configured = this.services.runtimeTiming?.().mcpPollWaitSeconds ?? DEFAULT_MCP_POLL_WAIT_SECONDS;
    const seconds = Number.isFinite(configured)
      ? Math.max(MIN_CONFIGURABLE_WAIT_SECONDS, Math.min(MAX_CONFIGURABLE_WAIT_SECONDS, configured))
      : DEFAULT_MCP_POLL_WAIT_SECONDS;
    return Math.round(seconds * 1_000);
  }
}

function taskDescriptor(provider: TaskProvider, backingId: string, toolName: string, workspaceId?: string): ModernTaskDescriptor {
  return {
    v: TASK_DESCRIPTOR_VERSION,
    nonce: randomUUID(),
    provider,
    backingId,
    toolName,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
}

function encodeTaskId(descriptor: ModernTaskDescriptor): string {
  return `${TASK_ID_PREFIX}${Buffer.from(JSON.stringify(descriptor), 'utf8').toString('base64url')}`;
}

function decodeTaskId(taskId: string): ModernTaskDescriptor {
  if (Buffer.byteLength(taskId, 'utf8') > MAX_TASK_ID_BYTES || !taskId.startsWith(TASK_ID_PREFIX)) {
    throw invalidParams('Task not found or inaccessible');
  }
  try {
    const decoded = JSON.parse(Buffer.from(taskId.slice(TASK_ID_PREFIX.length), 'base64url').toString('utf8')) as unknown;
    const record = asRecord(decoded);
    const provider = record?.provider;
    const nonce = boundedString(record?.nonce, 128);
    const backingId = boundedString(record?.backingId, 256);
    const toolName = boundedString(record?.toolName, 128);
    const workspaceId = boundedString(record?.workspaceId, 128);
    if (record?.v !== TASK_DESCRIPTOR_VERSION || (provider !== 'shell' && provider !== 'process') || nonce === undefined || backingId === undefined || toolName === undefined) {
      throw new Error('invalid descriptor');
    }
    return {
      v: TASK_DESCRIPTOR_VERSION,
      nonce,
      provider,
      backingId,
      toolName,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    };
  } catch {
    throw invalidParams('Task not found or inaccessible');
  }
}

function toTaskBase(taskId: string, observation: ProviderObservation, pollIntervalMs: number): ModernTaskBase {
  return {
    taskId,
    status: observation.status,
    ...(observation.statusMessage === undefined ? {} : { statusMessage: observation.statusMessage }),
    createdAt: observation.createdAt,
    lastUpdatedAt: observation.lastUpdatedAt,
    ttlMs: observation.ttlMs,
    pollIntervalMs,
  };
}

function resultForDescriptor(descriptor: ModernTaskDescriptor, value: Record<string, unknown>, isError: boolean): McpToolResponse {
  const structuredContent = isWrappedProcessTool(descriptor.toolName)
    ? {
        tool: descriptor.toolName,
        status: 'ready',
        available: true,
        ready: true,
        executed: true,
        started: true,
        process: value,
      }
    : value;
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function isDirectProcessTool(toolName: string): boolean {
  return toolName === 'process_start'
    || toolName === 'project_dev'
    || toolName === 'project_test'
    || toolName === 'project_lint'
    || toolName === 'project_typecheck'
    || toolName === 'project_build';
}

function isWrappedProcessTool(toolName: string): boolean {
  return toolName === 'benchmark_run' || toolName === 'run_affected_tests';
}

function taskTtlMs(createdAt: string, deadlineAt: string | undefined): number | null {
  if (deadlineAt === undefined) return null;
  const ttl = Date.parse(deadlineAt) - Date.parse(createdAt);
  return Number.isFinite(ttl) && ttl > 0 ? Math.round(ttl) : null;
}

function providerError(error: AppError): ProtocolError {
  if (error.code === 'PROCESS_NOT_FOUND' || error.code === 'PERMISSION_DENIED') {
    return invalidParams('Task not found or inaccessible');
  }
  return internalError(error.message);
}

function invalidParams(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

function internalError(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InternalError, message);
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

function isoString(value: unknown): string | undefined {
  const text = boundedString(value, 64);
  if (text === undefined || !Number.isFinite(Date.parse(text))) return undefined;
  return new Date(Date.parse(text)).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
