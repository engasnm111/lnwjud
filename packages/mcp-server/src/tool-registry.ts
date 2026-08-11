import { appError } from '@lnwjud/domain';
import { sanitizeException, type DiagnosticLogger, type FileActor } from '@lnwjud/application';
import { mapError, mapResult, type McpToolResponse } from './result-mapper.js';
import { codexTools } from './tools/codex-tools.js';
import { capabilityTools } from './tools/capability-tools.js';
import { fileTools } from './tools/file-tools.js';
import { gitTools } from './tools/git-tools.js';
import { processTools } from './tools/process-tools.js';
import { searchTools } from './tools/search-tools.js';
import { workspaceTools } from './tools/workspace-tools.js';
import type { McpApplicationServices, McpToolContext, McpToolDefinition } from './tools/tool-types.js';

export type { McpApplicationServices } from './tools/tool-types.js';

export interface ToolRegistryOptions {
  readonly diagnostic?: DiagnosticLogger;
}

export class ToolRegistry {
  private readonly tools: readonly McpToolDefinition[];
  private readonly diagnostic: DiagnosticLogger | undefined;

  public constructor(services: McpApplicationServices, actor: FileActor, options: ToolRegistryOptions = {}) {
    this.diagnostic = options.diagnostic;
    const context: McpToolContext = { services, actor };
    const workspace = workspaceTools(context);
    const files = fileTools(context);
    this.tools = [
      ...workspace,
      ...files.slice(0, 2),
      ...searchTools(context),
      ...gitTools(context),
      ...files.slice(2),
      ...processTools(context),
      ...codexTools(context),
      ...capabilityTools(context),
    ];
  }

  public list(): readonly McpToolDefinition[] {
    return this.tools;
  }

  public async invoke(name: string, input: unknown): Promise<McpToolResponse> {
    try {
      const tool = this.tools.find((candidate) => candidate.name === name);
      if (tool === undefined) return mapError(appError('INVALID_INPUT', 'Unknown MCP tool'));
      const parsed = tool.parse(input);
      if (!parsed.ok) return mapError(parsed.error);
      return mapResult(await tool.execute(parsed.value));
    } catch (error: unknown) {
      return mapError(sanitizeException(error, this.diagnostic));
    }
  }
}
