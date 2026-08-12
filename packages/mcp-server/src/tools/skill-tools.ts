import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { skillsListSchema, skillsReadSchema } from './schemas.js';

const fullAccess = {
  permission: 'DANGEROUS' as const,
  annotations: { readOnlyHint: false, destructiveHint: true },
};

export function skillTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'skills_list',
      description: 'List local agent skills discovered from Cursor, Claude, Agents, workspace skill roots, and lnwjud settings. Filter with query or source.',
      ...fullAccess,
      inputSchema: skillsListSchema,
      handler: async (input) => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.listSkills({
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.source === undefined ? {} : { source: input.source }),
        }),
    }),
    defineTool({
      name: 'skills_read',
      description: 'Read a local skill SKILL.md (or a relative file inside the skill folder). Follow the skill instructions with lnwjud tools and mcp_call.',
      ...fullAccess,
      inputSchema: skillsReadSchema,
      handler: async (input) => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.readSkill({
          skillId: input.skillId,
          ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }),
        }),
    }),
  ];
}
