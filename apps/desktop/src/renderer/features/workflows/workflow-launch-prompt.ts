import type { WorkflowDraft, WorkflowTemplate } from '@lnwjud/ipc-contracts';

/** A copyable message, not an executable command or a promise of model execution. */
export function workflowLaunchPrompt(draft: WorkflowDraft, template: WorkflowTemplate): string {
  if (draft.schemaVersion !== 1 || draft.templateId !== template.id || draft.templateRevision !== template.revision
    || draft.readiness !== 'ready') throw new Error('Workflow is not ready for launch');
  return [
    `Use the lnwjud MCP workflow_start tool for the built-in workflow "${template.id}".`,
    `Workspace ID: ${draft.workspaceId}`,
    `Prepared template revision: ${draft.templateRevision}`,
    `Prepared input digest: ${draft.digest}`,
    `Validated inputs: ${JSON.stringify(draft.inputs)}`,
    `Read-only: ${template.readOnly ? 'yes' : 'no'}.`,
    'First use workflow_prepare with exactly these inputs, then workflow_start with the fresh returned draft and a new stable idempotency key.',
    'Do not rewrite the draft objective, steps or acceptance criteria.',
    'After acquiring a real Goal lease, proceed through existing Goal, Harness, Audit, Office and Checkpoint tools.',
    'Do not create any Scheduled Task, cron, scheduled continuation, commit, push, merge, tag, deploy or publish.',
    'Do not claim completion without observed test evidence. If capability readiness is unknown, report it before executing.',
  ].join('\n');
}
