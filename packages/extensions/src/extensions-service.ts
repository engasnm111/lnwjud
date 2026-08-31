import { appError, err, ok, type Result } from '@lnwjud/domain';
import { McpConfigLoader } from './mcp-config-loader.js';
import { McpSessionManager, type McpClientFactory } from './mcp-session-manager.js';
import { SkillCatalog } from './skill-catalog.js';
import type {
  ExtensionsService,
  ExtensionsSettings,
  McpServerListItem,
  SkillContent,
  SkillSummary,
} from './types.js';

export interface LocalExtensionsServiceOptions {
  readonly settings: ExtensionsSettings;
  readonly homeDir?: string;
  readonly appDataDir?: string;
  readonly workspaceRootProvider?: () => Promise<string | undefined>;
  readonly bundledSkillRoots?: readonly string[];
  readonly clientFactory?: McpClientFactory;
  readonly callTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

export class LocalExtensionsService implements ExtensionsService {
  private readonly settings: ExtensionsSettings;
  private readonly homeDir: string | undefined;
  private readonly appDataDir: string | undefined;
  private readonly workspaceRootProvider: () => Promise<string | undefined>;
  private readonly bundledSkillRoots: readonly string[];
  private readonly sessions: McpSessionManager;

  public constructor(options: LocalExtensionsServiceOptions) {
    this.settings = options.settings;
    this.homeDir = options.homeDir;
    this.appDataDir = options.appDataDir;
    this.workspaceRootProvider = options.workspaceRootProvider ?? (async (): Promise<undefined> => undefined);
    this.bundledSkillRoots = options.bundledSkillRoots ?? [];
    this.sessions = new McpSessionManager({
      ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
      ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    });
  }

  public async listSkills(input: { readonly query?: string; readonly source?: string }): Promise<Result<{ readonly skills: readonly SkillSummary[] }>> {
    const catalog = await this.skillCatalog();
    return catalog.list(input);
  }

  public async readSkill(input: { readonly skillId: string; readonly relativePath?: string }): Promise<Result<SkillContent>> {
    const catalog = await this.skillCatalog();
    return catalog.read(input);
  }

  public async listMcpServers(): Promise<Result<{ readonly servers: readonly McpServerListItem[] }>> {
    const discovered = await this.loader().then((loader) => loader.discover());
    return ok({
      servers: discovered.map((server) => ({
        name: server.name,
        source: server.source,
        enabled: server.enabled,
        connected: this.sessions.isConnected(server.name),
        excluded: server.excluded,
        ...(server.exclusionReason === undefined ? {} : { exclusionReason: server.exclusionReason }),
        command: server.config.command,
      })),
    });
  }

  public async describeMcpServer(input: { readonly server: string }, signal?: AbortSignal): Promise<Result<{
    readonly server: string;
    readonly enabled: boolean;
    readonly connected: boolean;
    readonly tools: readonly { readonly name: string; readonly description: string; readonly inputSchema?: unknown }[];
  }>> {
    if (isAborted(signal)) return cancelledMcpCall();
    const server = await this.findServer(input.server);
    if (isAborted(signal)) return cancelledMcpCall();
    if (!server.ok) return server;
    if (!server.value.enabled) {
      return err(appError('PERMISSION_DENIED', `MCP server is disabled: ${input.server}`));
    }
    if (server.value.excluded) {
      return err(appError('PERMISSION_DENIED', server.value.exclusionReason ?? `MCP server is excluded: ${input.server}`));
    }
    const described = await this.sessions.describe(server.value.name, server.value.config, signal);
    if (!described.ok) return described;
    return ok({
      server: server.value.name,
      enabled: true,
      connected: described.value.connected,
      tools: described.value.tools,
    });
  }

  public async listMcpResources(input: { readonly server: string }, signal?: AbortSignal): Promise<Result<{
    readonly server: string;
    readonly enabled: boolean;
    readonly connected: boolean;
    readonly resources: readonly import('./types.js').McpResourceSummary[];
  }>> {
    if (isAborted(signal)) return cancelledMcpCall();
    const server = await this.findServer(input.server);
    if (isAborted(signal)) return cancelledMcpCall();
    if (!server.ok) return server;
    if (!server.value.enabled) return err(appError('PERMISSION_DENIED', `MCP server is disabled: ${input.server}`));
    if (server.value.excluded) return err(appError('PERMISSION_DENIED', server.value.exclusionReason ?? `MCP server is excluded: ${input.server}`));
    const listed = await this.sessions.listResources(server.value.name, server.value.config, signal);
    if (!listed.ok) return listed;
    return ok({ server: server.value.name, enabled: true, connected: listed.value.connected, resources: listed.value.resources });
  }

  public async callMcpTool(input: {
    readonly server: string;
    readonly tool: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
  }, signal?: AbortSignal): Promise<Result<unknown>> {
    if (isAborted(signal)) return cancelledMcpCall();
    const server = await this.findServer(input.server);
    if (isAborted(signal)) return cancelledMcpCall();
    if (!server.ok) return server;
    if (!server.value.enabled) {
      return err(appError('PERMISSION_DENIED', `MCP server is disabled: ${input.server}`));
    }
    if (server.value.excluded) {
      return err(appError('PERMISSION_DENIED', server.value.exclusionReason ?? `MCP server is excluded: ${input.server}`));
    }
    return this.sessions.call(
      server.value.name,
      server.value.config,
      input.tool,
      input.arguments ?? {},
      signal,
    );
  }

  public close(): Promise<void> {
    return this.sessions.close();
  }

  private async skillCatalog(): Promise<SkillCatalog> {
    const workspaceRoot = await this.workspaceRootProvider();
    return new SkillCatalog({
      settings: this.settings,
      ...(this.homeDir === undefined ? {} : { homeDir: this.homeDir }),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      extraRoots: this.bundledSkillRoots,
    });
  }

  private async loader(): Promise<McpConfigLoader> {
    const workspaceRoot = await this.workspaceRootProvider();
    return new McpConfigLoader({
      settings: this.settings,
      ...(this.homeDir === undefined ? {} : { homeDir: this.homeDir }),
      ...(this.appDataDir === undefined ? {} : { appDataDir: this.appDataDir }),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    });
  }

  private async findServer(name: string): Promise<Result<Awaited<ReturnType<McpConfigLoader['discover']>>[number]>> {
    const discovered = await this.loader().then((loader) => loader.discover());
    const server = discovered.find((entry) => entry.name === name);
    if (server === undefined) return err(appError('INVALID_INPUT', `Unknown MCP server: ${name}`));
    return ok(server);
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelledMcpCall(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Child MCP operation was cancelled before dispatch', true));
}
