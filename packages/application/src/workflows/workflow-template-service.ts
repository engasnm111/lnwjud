import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result, type WorkflowDraft, type WorkflowPrepareRequest, type WorkflowReadiness, type WorkflowTemplate } from '@lnwjud/domain';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from '../file-service.js';
import { WORKFLOW_TEMPLATES } from './workflow-templates.js';

type CapabilityProbe = (capability: string, workspaceId: string) => Promise<WorkflowReadiness>;
const limits = { field: 1024, inputBytes: 16 * 1024, objective: 2048 } as const;

export class WorkflowTemplateService {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly probe?: CapabilityProbe,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async list(_actor: FileActor, workspaceId: string): Promise<Result<readonly WorkflowTemplate[]>> {
    if (!await this.workspaces.get(workspaceId)) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
    return ok(WORKFLOW_TEMPLATES);
  }

  public async prepare(_actor: FileActor, request: WorkflowPrepareRequest): Promise<Result<WorkflowDraft>> {
    try {
      const workspace = await this.workspaces.get(request.workspaceId);
      if (!workspace) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
      const template = WORKFLOW_TEMPLATES.find((candidate) => candidate.id === request.templateId);
      if (!template) return err(appError('INVALID_INPUT', 'Unknown workflow template'));
      if (!request.inputs || Array.isArray(request.inputs) || typeof request.inputs !== 'object') {
        return err(appError('INVALID_INPUT', 'Workflow inputs must be an object'));
      }
      const allowed = new Set(template.inputFields.map((field) => field.key));
      if (Object.keys(request.inputs).length > 16 || Object.keys(request.inputs).some((key) => !allowed.has(key))) {
        return err(appError('INVALID_INPUT', 'Unknown or excessive workflow inputs'));
      }
      const normalized: Record<string, string> = {};
      for (const field of template.inputFields) {
        const raw = request.inputs[field.key];
        if (raw === undefined || raw === '') {
          if (field.required) return err(appError('INVALID_INPUT', `Missing ${field.key}`));
          continue;
        }
        if (typeof raw !== 'string' || raw.length > limits.field || raw.includes('\0')) {
          return err(appError('INVALID_INPUT', `Invalid ${field.key}`));
        }
        let value = raw.trim();
        if (field.required && value.length === 0) return err(appError('INVALID_INPUT', `Missing ${field.key}`));
        if (field.type === 'enum' && !field.options?.includes(value)) {
          return err(appError('INVALID_INPUT', `Unsupported ${field.key}`));
        }
        if (field.type === 'path' || field.type === 'mapping_file') {
          value = path.resolve(workspace.realRootPath, value);
          if (!inside(workspace.realRootPath, value)) return err(appError('INVALID_INPUT', `Path outside workspace: ${field.key}`));
          if (field.key !== 'outputPath') {
            let resolved: string;
            try { resolved = await realpath(value); }
            catch { return err(appError('INVALID_INPUT', `Input file unavailable: ${field.key}`)); }
            if (!inside(workspace.realRootPath, resolved)) return err(appError('INVALID_INPUT', `Path escapes workspace: ${field.key}`));
            value = resolved;
          }
        }
        normalized[field.key] = value;
      }
      const inputs = Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
      if (Buffer.byteLength(JSON.stringify(inputs)) > limits.inputBytes) return err(appError('INVALID_INPUT', 'Workflow inputs exceed 16 KiB'));
      const blockers: string[] = [];
      let readiness: WorkflowReadiness = 'ready';
      for (const capability of template.requiredCapabilities) {
        const state = this.probe ? await this.probe(capability, workspace.id) : 'unknown';
        if (state !== 'ready') {
          blockers.push(`${capability}: ${state}`);
          if (state === 'unsupported' || readiness === 'ready' || (state === 'needs_setup' && readiness === 'unknown')) readiness = state;
        }
      }
      const digest = createHash('sha256').update(JSON.stringify({ workspaceId: workspace.id, templateId: template.id, revision: template.revision, inputs })).digest('hex');
      const objective = `[${template.id}] ${template.descriptionEn} Inputs: ${JSON.stringify(inputs)}. ${template.readOnly ? 'Review only; do not change files.' : 'Guard originals and verify all new artifacts.'} Do not schedule, commit, push, merge or publish without separate authorization.`;
      if (objective.length > limits.objective) return err(appError('INVALID_INPUT', 'Workflow objective exceeds limit'));
      return ok({
        schemaVersion: 1, workspaceId: workspace.id, templateId: template.id,
        templateRevision: template.revision, inputs, digest, objective,
        steps: [{ id: 'inspect', title: `Inspect ${template.titleEn} inputs and existing evidence` },
          { id: 'execute', title: template.readOnly ? 'Perform read-only verification' : 'Produce guarded output and verify readback' },
          { id: 'report', title: 'Publish bounded observed evidence in Goal checkpoint' }],
        acceptance: [{ id: 'verified', title: 'Observed outputs and checks match selected workflow; no unapproved side effects' }],
        readiness, blockers, preparedAt: this.now().toISOString(),
      });
    } catch {
      return err(appError('INVALID_INPUT', 'Workflow request could not be prepared'));
    }
  }
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
