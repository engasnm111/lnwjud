import {
  startMcpHttp,
  type McpHttpServerHandle,
  type McpHttpServerOptions,
} from '@lnwjud/mcp-server';

export interface DesktopMcpStatus {
  readonly running: boolean;
  readonly url: string | null;
  readonly lastStartError: string | null;
  /** Compatibility field: the desktop MCP listener is now application-global. */
  readonly workspaceId: null;
}

export interface McpHttpServerStarter {
  start(options: McpHttpServerOptions): Promise<McpHttpServerHandle>;
}

export interface DesktopMcpLifecycleOptions {
  readonly createServerOptions: () => McpHttpServerOptions | Promise<McpHttpServerOptions>;
  readonly starter?: McpHttpServerStarter;
}

const defaultStarter: McpHttpServerStarter = { start: startMcpHttp };

export class DesktopMcpLifecycle {
  private readonly starter: McpHttpServerStarter;
  private readonly createServerOptions: DesktopMcpLifecycleOptions['createServerOptions'];
  private handle: McpHttpServerHandle | null = null;
  private startOperation: Promise<DesktopMcpStatus> | null = null;
  private stopOperation: Promise<DesktopMcpStatus> | null = null;
  private lastStartError: string | null = null;

  public constructor(options: DesktopMcpLifecycleOptions) {
    this.starter = options.starter ?? defaultStarter;
    this.createServerOptions = options.createServerOptions;
  }

  public status(): DesktopMcpStatus {
    return this.handle === null
      ? { running: false, url: null, lastStartError: this.lastStartError, workspaceId: null }
      : { running: true, url: this.handle.endpoint.toString(), lastStartError: null, workspaceId: null };
  }

  public start(): Promise<DesktopMcpStatus> {
    if (this.stopOperation !== null) return this.stopOperation.then(() => this.start());
    if (this.handle !== null) return Promise.resolve(this.status());
    if (this.startOperation !== null) return this.startOperation;

    const operation = this.startInternal().then(
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

  public async restart(): Promise<DesktopMcpStatus> {
    await this.stop();
    return this.start();
  }

  public close(): Promise<DesktopMcpStatus> {
    return this.stop();
  }

  private async startInternal(): Promise<DesktopMcpStatus> {
    try {
      const handle = await this.starter.start(await this.createServerOptions());
      this.handle = handle;
      this.lastStartError = null;
      return this.status();
    } catch (error: unknown) {
      this.lastStartError = error instanceof Error ? error.message : String(error);
      throw error;
    }
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
    return this.status();
  }
}
