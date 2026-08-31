import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { skillsListSchema, skillsReadSchema } from './schemas.js';

const readOnlyInspection = {
  permission: 'READ' as const,
  annotations: { readOnlyHint: true, destructiveHint: false },
};

export function skillTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'skills_list',
      description: 'List the union of bundled skills and every discovered machine-global or active-workspace skill from Cursor, Claude, Agents, Codex, the Codex plugin cache, GitHub workspace roots, and lnwjud settings. Nested and symlinked skill collections are included. Filter with query or source.',
      ...readOnlyInspection,
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
      description: 'Read a local skill SKILL.md (or a relative file inside the skill folder). Prefer the source-qualified id returned by skills_list; an unambiguous bare name or $name is also accepted. Follow the skill instructions with lnwjud tools and mcp_call.',
      ...readOnlyInspection,
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
