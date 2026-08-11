import {
  startMcpHttp,
  type McpHttpServerHandle,
  type McpHttpServerOptions,
} from '@lnwjud/mcp-server';

export interface DesktopMcpStatus {
  readonly running: boolean;
  readonly url: string | null;
  readonly workspaceId: string | null;
}

export interface McpHttpServerStarter {
  start(options: McpHttpServerOptions): Promise<McpHttpServerHandle>;
}

export interface DesktopMcpLifecycleOptions {
  readonly createServerOptions: (workspaceId: string) => McpHttpServerOptions;
  readonly workspaceExists: (workspaceId: string) => Promise<boolean>;
  readonly starter?: McpHttpServerStarter;
}

const defaultStarter: McpHttpServerStarter = { start: startMcpHttp };

export class DesktopMcpLifecycle {
  private readonly starter: McpHttpServerStarter;
  private readonly handleOptions: Pick<DesktopMcpLifecycleOptions, 'createServerOptions' | 'workspaceExists'>;
  private handle: McpHttpServerHandle | null = null;
  private workspaceId: string | null = null;
  private startOperation: Promise<DesktopMcpStatus> | null = null;
  private stopOperation: Promise<DesktopMcpStatus> | null = null;

  public constructor(options: DesktopMcpLifecycleOptions) {
    this.starter = options.starter ?? defaultStarter;
    this.handleOptions = {
      createServerOptions: options.createServerOptions,
      workspaceExists: options.workspaceExists,
    };
  }

  public status(): DesktopMcpStatus {
    return this.handle === null || this.workspaceId === null
      ? { running: false, url: null, workspaceId: null }
      : { running: true, url: this.handle.endpoint.toString(), workspaceId: this.workspaceId };
  }

  public start(workspaceId: string): Promise<DesktopMcpStatus> {
    if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
      return Promise.reject(new Error('A workspace is required to start MCP'));
    }
    if (this.stopOperation !== null) return this.stopOperation.then(() => this.start(workspaceId));
    if (this.handle !== null) return Promise.resolve(this.status());
    if (this.startOperation !== null) return this.startOperation;

    const operation = this.startInternal(workspaceId).then(
      (result) => {
        if (this.startOperation === operation) this.startOperation = null;
        return result;
      },
      (error: unknown) => {
        if (this.startOperation === operation) this.startOperation = null;
        throw error;
      },
    );
    this.startOperation = operation;
    return operation;
  }

  public stop(): Promise<DesktopMcpStatus> {
    if (this.stopOperation !== null) return this.stopOperation;
    const operation = this.stopInternal().then(
      (result) => {
        if (this.stopOperation === operation) this.stopOperation = null;
        return result;
      },
      (error: unknown) => {
        if (this.stopOperation === operation) this.stopOperation = null;
        throw error;
      },
    );
    this.stopOperation = operation;
    return operation;
  }

  public close(): Promise<DesktopMcpStatus> {
    return this.stop();
  }

  private async startInternal(workspaceId: string): Promise<DesktopMcpStatus> {
    if (!(await this.handleOptions.workspaceExists(workspaceId))) throw new Error('Workspace was not found');
    const handle = await this.starter.start(this.handleOptions.createServerOptions(workspaceId));
    this.handle = handle;
    this.workspaceId = workspaceId;
    return this.status();
  }

  private async stopInternal(): Promise<DesktopMcpStatus> {
    if (this.startOperation !== null) {
      try {
        await this.startOperation;
      } catch {
        return this.status();
      }
    }
    if (this.handle === null) return this.status();
    await this.handle.close();
    this.handle = null;
    this.workspaceId = null;
    return this.status();
  }
}
