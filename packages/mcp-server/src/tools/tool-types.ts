import { err, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { CapabilityService } from '@lnwjud/capabilities';
import type { ExtensionsService } from '@lnwjud/extensions';
import type {
  AgentSwarmService,
  ApplyPatchRequest,
  CheckpointService,
  CodexService,
  DeleteFileRequest,
  EditFileRequest,
  FileActor,
  FileService,
  GitService,
  GoalRequestCancellationPort,
  GoalContinuationService,
  GoalMutationFenceService,
  MoveFileRequest,
  ProcessService,
  ProjectService,
  ReadFileRequest,
  ReadFilesRequest,
  SearchService,
  ScheduledContinuationService,
  WorkspaceIndexService,
  WorkspaceQueryService,
  WriteFileRequest,
} from '@lnwjud/application';
import { z } from 'zod';
import type { ContextEconomyRuntime } from '../context-economy.js';

export interface WorkspaceInfoPort {
  info(actor: FileActor, workspaceId: string): Promise<Result<unknown>>;
  list?(actor: FileActor): Promise<Result<unknown>>;
  register?(actor: FileActor, request: {
    readonly parentWorkspaceId?: string;
    readonly path: string;
    readonly displayName?: string;
  }): Promise<Result<unknown>>;
}

export interface ProjectSnapshotPort {
  snapshot(actor: FileActor, workspaceId: string): Promise<Result<unknown>>;
}

export interface McpRuntimeTiming {
  readonly mcpPollWaitSeconds: number;
}

export interface McpApplicationServices {
  /** Host platform selected by the composition root; tests may inject a deterministic profile. */
  readonly platform?: NodeJS.Platform;
  readonly runtimeStatePath?: string;
  readonly runtimeTiming?: () => McpRuntimeTiming;
  /** Test-only deterministic override for Windows Sandbox discovery; production runtimes leave this undefined. */
  readonly sandboxRuntimeOptions?: { readonly platform?: NodeJS.Platform; readonly sandboxExecutable?: string };
  readonly localProviders?: () => { readonly pdfProvider?: string; readonly lspCommands?: Readonly<Record<string, string>> };
  readonly capabilities?: CapabilityService;
  readonly extensions?: ExtensionsService;
  readonly workspaceInfo?: WorkspaceInfoPort;
  readonly workspaceQuery?: Pick<WorkspaceQueryService, 'tree'>;
  readonly projectSnapshot?: ProjectSnapshotPort;
  readonly project?: Pick<ProjectService, 'detect'>;
  readonly file?: Pick<FileService, 'readFile' | 'readFiles' | 'writeFile' | 'applyPatch' | 'editFile' | 'moveFile' | 'copyFile' | 'deleteFile' | 'listRecoveryItems' | 'restoreDeletedFile' | 'prepareExternalFileMutation'>;
  readonly checkpoint?: Pick<CheckpointService, 'list' | 'restore'>;
  readonly goals?: Pick<GoalContinuationService, 'runGoal' | 'getGoal' | 'checkpointGoal' | 'finishGoal' | 'cancelGoal' | 'reconcileGoals' | 'listGoals'>;
  /** Runtime-shared cancellation registry for in-flight fenced MCP requests. */
  readonly goalRequestCancellation?: GoalRequestCancellationPort;
  readonly scheduledContinuations?: Pick<ScheduledContinuationService, 'prepareScheduledContinuation' | 'recordScheduledContinuationReceipt' | 'cancelScheduledContinuation' | 'claimScheduledContinuation' | 'getScheduledContinuation' | 'expediteScheduledContinuation'>;
  readonly goalMutationFence?: Pick<GoalMutationFenceService, 'inspectWorkspaceFence' | 'begin' | 'heartbeat' | 'end' | 'observe'>;
  readonly search?: Pick<SearchService, 'searchFiles' | 'searchText'>;
  readonly workspaceIndex?: Pick<WorkspaceIndexService, 'indexWorkspace' | 'status' | 'startWatch' | 'stopWatch'>;
  readonly git?: Pick<GitService, 'status' | 'diff' | 'log' | 'run'>;
  readonly process?: Pick<ProcessService, 'start' | 'list' | 'status' | 'logs' | 'stop' | 'previewProjectCommand' | 'startProjectCommand'>;
  readonly codex?: Pick<CodexService, 'status' | 'run' | 'list' | 'taskStatus' | 'taskLogs' | 'stop'>;
  readonly agentSwarm?: Pick<AgentSwarmService, 'start' | 'status' | 'result' | 'cancel' | 'list'>;
}

export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface McpToolAnnotationInput {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpToolExecution {
  readonly taskSupport: 'required' | 'optional' | 'forbidden';
}

export type McpPermissionLevel = 'READ' | 'WRITE' | 'EXECUTE' | 'DANGEROUS';

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly permission: McpPermissionLevel;
  readonly annotations: McpToolAnnotations;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly execution: McpToolExecution;
  parse(input: unknown): Result<unknown>;
  execute(input: unknown, signal: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>>;
}

export interface McpToolContext {
  readonly actor: FileActor;
  readonly services: McpApplicationServices;
  readonly contextEconomy: ContextEconomyRuntime;
  /** Dynamic registry exposure predicate used by discovery/ranking helpers. */
  readonly isToolExposed?: (name: string) => boolean;
}

export interface ToolConfig<T extends z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly permission: McpPermissionLevel;
  readonly annotations: McpToolAnnotationInput;
  readonly inputSchema: T;
  readonly outputSchema?: z.ZodType;
  readonly execution?: Partial<McpToolExecution>;
  handler(input: z.infer<T>, signal: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>>;
}

const defaultStructuredOutputSchema = z.object({}).catchall(z.unknown());

export function defineTool<T extends z.ZodType>(config: ToolConfig<T>): McpToolDefinition {
  return {
    name: config.name,
    description: config.description,
    permission: config.permission,
    annotations: {
      readOnlyHint: config.annotations.readOnlyHint,
      destructiveHint: config.annotations.destructiveHint,
      idempotentHint: config.annotations.idempotentHint ?? config.permission === 'READ',
      openWorldHint: config.annotations.openWorldHint ?? false,
    },
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema ?? defaultStructuredOutputSchema,
    execution: { taskSupport: config.execution?.taskSupport ?? 'forbidden' },
    parse(input: unknown): Result<unknown> {
      const parsed = config.inputSchema.safeParse(input);
      return parsed.success ? ok(parsed.data) : err({ code: 'INVALID_INPUT', message: 'Tool input is invalid', recoverable: false });
    },
    execute(input: unknown, signal: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
      return config.handler(input as z.infer<T>, signal, authorization);
    },
  };
}

export function missingService<T>(): Result<T> {
  return err({ code: 'INTERNAL_ERROR', message: 'MCP application service is unavailable', recoverable: true });
}

export type { ApplyPatchRequest, DeleteFileRequest, EditFileRequest, MoveFileRequest, ReadFileRequest, ReadFilesRequest, WriteFileRequest };
