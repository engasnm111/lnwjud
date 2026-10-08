import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type GoalRepository, type Result, type TaskResultSummary } from '@lnwjud/domain';
import type { AuditEventRepository, AuditMutationReceiptRow } from '@lnwjud/audit';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from '../file-service.js';
import type { GoalContinuationService } from '../goal-continuation-service.js';

export class TaskResultService {
  public constructor(
    private readonly goals: Pick<GoalContinuationService, 'getGoal'>,
    private readonly audit?: Pick<AuditEventRepository, 'listGoalMutationReceipts'>,
    private readonly workspaces?: WorkspaceRepository,
    /** Desktop local host only: avoids pretending its UI actor owns MCP-created Goals. */
    private readonly hostGoalReader?: Pick<GoalRepository,'getById'>,
  ) {}

  public async get(actor: FileActor, workspaceId: string, goalId: string): Promise<Result<TaskResultSummary>> {
    if (!workspaceId || !goalId) return err(appError('INVALID_INPUT', 'workspaceId and goalId are required'));
    let goal;
    if (this.hostGoalReader) {
      goal = await this.hostGoalReader.getById(goalId);
    } else {
      const result = await this.goals.getGoal(actor, { goalId });
      if (!result.ok) return result;
      goal = result.value;
    }
    if (!goal || goal.workspaceId !== workspaceId) return err(appError('WORKSPACE_NOT_FOUND', 'Goal is not in requested workspace'));
    const receipts = this.audit?.listGoalMutationReceipts
      ? await this.audit.listGoalMutationReceipts(workspaceId,goalId,200) : [];
    const observedChanges = receipts.map((entry)=>({
      operationId:entry.operationId,path:entry.path,action:entry.action,observedAt:entry.observedAt,
    }));
    const artifacts: TaskResultSummary['artifacts'][number][] = [];
    const recentPaths = new Set<string>();
    for (const receipt of receipts) {
      if (receipt.afterSha256===undefined || recentPaths.has(receipt.path)) continue;
      recentPaths.add(receipt.path);
      const verification = await this.verifyReceipt(workspaceId,receipt);
      artifacts.push({
        path:receipt.path,kind:receipt.action==='office_excel'?'xlsx-report':'file',
        sha256:receipt.afterSha256,
        ...(receipt.sizeBytes===undefined?{}:{sizeBytes:receipt.sizeBytes}),
        verification,
      });
    }
    const checkpoint = 'lastCheckpoint' in goal ? goal.lastCheckpoint : goal.checkpoints.at(-1);
    const checks = goal.engineering?.gates.map((gate) => ({
      name:gate.title,status:gate.status==='not_applicable'?'unknown' as const:gate.status,
    }))??[];
    // Historical Goals and external MCP writes lack verifiable per-mutation receipts.
    // A model-completed Goal does not imply host-observed checks or artifacts passed.
    return ok({
      workspaceId,goalId,goalRevision:goal.revision,status:goal.status,
      progress: {
        currentPhase: goal.currentPhase ?? '', nextAction: goal.nextAction ?? '',
        updatedAt: goal.updatedAt ?? '', lastCheckpointSummary: checkpoint?.summary ?? null,
        ...(goal.terminalSummary === undefined ? {} : { terminalSummary: goal.terminalSummary }),
        steps: (goal.plan?.steps ?? []).slice(0, 50).map((step) => ({
          id: step.id, title: step.title, status: step.status,
          ...(step.summary === undefined ? {} : { summary: step.summary }),
        })),
      },
      observedChanges,artifacts,checks,
      blockers:goal.blockers,lastCheckpointId:checkpoint?.id??null,
      evidenceCoverage:'partial',
    });
  }

  private async verifyReceipt(workspaceId:string,receipt:AuditMutationReceiptRow):Promise<'verified'|'unverified'|'failed'>{
    if(receipt.verification!=='verified' || !receipt.afterSha256 || !this.workspaces)return 'unverified';
    const workspace=await this.workspaces.get(workspaceId);
    if(!workspace)return 'unverified';
    try {
      const root=await realpath(workspace.realRootPath);
      const target=await realpath(path.resolve(root,receipt.path));
      const relative=path.relative(root,target);
      if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))return 'unverified';
      const meta=await stat(target);
      if(!meta.isFile()||meta.size>25*1024*1024)return 'unverified';
      if(receipt.sizeBytes!==undefined&&meta.size!==receipt.sizeBytes)return 'failed';
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(target, { highWaterMark: 64 * 1024 })) digest.update(chunk);
      const hash = digest.digest('hex');
      return hash===receipt.afterSha256?'verified':'failed';
    }catch{return 'failed'}
  }
}
