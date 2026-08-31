import type { Result } from '@lnwjud/domain';

export type ExtensionsMode = 'enable_all' | 'allowlist';

export interface McpServerLaunchConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly type?: string;
}

export interface ExtensionsSettings {
  readonly mode: ExtensionsMode;
  readonly disabledServers: readonly string[];
  readonly enabledServers: readonly string[];
  readonly disabledSkillRoots: readonly string[];
  readonly extraSkillRoots: readonly string[];
  readonly extraMcpServers: Readonly<Record<string, McpServerLaunchConfig>>;
}

export interface SkillSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly rootPath: string;
  readonly skillPath: string;
}

export interface SkillContent {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly path: string;
  readonly content: string;
}

export interface DiscoveredMcpServer {
  readonly name: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly excluded: boolean;
  readonly exclusionReason?: string;
  readonly config: McpServerLaunchConfig;
}

export interface McpToolSummary {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
}

export interface McpResourceSummary {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface ExtensionsService {
  listSkills(input: { readonly query?: string; readonly source?: string }): Promise<Result<{ readonly skills: readonly SkillSummary[] }>>;
  readSkill(input: { readonly skillId: string; readonly relativePath?: string }): Promise<Result<SkillContent>>;
  listMcpServers(): Promise<Result<{ readonly servers: readonly McpServerListItem[] }>>;
  describeMcpServer(input: { readonly server: string }, signal?: AbortSignal): Promise<Result<{
    readonly server: string;
    readonly enabled: boolean;
    readonly connected: boolean;
    readonly tools: readonly McpToolSummary[];
  }>>;
  listMcpResources(input: { readonly server: string }, signal?: AbortSignal): Promise<Result<{
    readonly server: string;
    readonly enabled: boolean;
    readonly connected: boolean;
    readonly resources: readonly McpResourceSummary[];
  }>>;
  callMcpTool(input: {
    readonly server: string;
    readonly tool: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
  }, signal?: AbortSignal): Promise<Result<unknown>>;
  close(): Promise<void>;
}

export interface McpServerListItem {
  readonly name: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly excluded: boolean;
  readonly exclusionReason?: string;
  readonly command: string;
}

export const DEFAULT_EXTENSIONS_SETTINGS: ExtensionsSettings = Object.freeze({
  mode: 'enable_all',
  disabledServers: Object.freeze([]),
  enabledServers: Object.freeze([]),
  disabledSkillRoots: Object.freeze([]),
  extraSkillRoots: Object.freeze([]),
  extraMcpServers: Object.freeze({}),
});
