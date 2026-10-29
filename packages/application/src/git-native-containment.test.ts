import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitService } from './git-service.js';
import type { ManagedWriterAdmissionPort } from './writer-admission.js';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { SharedManagedWriterAdmission } from '../../capabilities/src/shared-managed-writer-admission.js';
import { nativeFixture } from '../../process/test/native-fixture.js';
import type { NativeAttemptBinding } from '@lnwjud/process';

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((x) => rm(x, { force:true, recursive:true, maxRetries:8, retryDelay:100 }))); });

describe.skipIf(process.platform !== 'win32')('Windows native GitService writer admission', () => {
  it('runs a real Git init in a native contained Job and releases only after native zero-active proof', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-git-native-')));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, 'project');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspaceRoot);
    const workspace: Workspace = { id:'git-native',displayName:'Native',rootPath:workspaceRoot,realRootPath:workspaceRoot,createdAt:new Date(0).toISOString() };
    const repository: WorkspaceRepository = {
      async list() { return [workspace]; },
      async get(id) { return id === workspace.id ? workspace : null; },
      async insert() {}, async delete() {},
    };
    const nativeRoot = path.join(root, 'contained');
    const { authority } = await nativeFixture(root);
    const admission = new SharedManagedWriterAdmission(path.join(root, 'tasks'), authority);
    const nativeReservations: string[] = [];
    const nativeBindings: NativeAttemptBinding[] = [];
    const gate: ManagedWriterAdmissionPort = { async enter(input) {
      if (input.nativeReceiptPath !== undefined) nativeReservations.push(input.nativeReceiptPath);
      const admitted = await admission.enter(input);
      if (admitted.ok && admitted.value.nativeBinding !== undefined) nativeBindings.push(admitted.value.nativeBinding);
      return admitted;
    } };
    const service = new GitService(repository, undefined, undefined, { writerAdmission:gate, nativeContainmentRoot:nativeRoot, nativeAuthority:authority });
    const result = await service.run({ clientId:'test-git-native',sessionId:'actual-git-session',clientName:'test' }, {
      args:['init','--initial-branch=dev'], workspaceId:workspace.id, timeoutMs:30_000,
    },undefined,{ mode:'standard',applicationApproved:true,bypassApplicationAuthorization:false,source:'host_approval' });
    expect(result).toMatchObject({ ok:true,value:{exitCode:0} });
    await expect(stat(path.join(workspaceRoot,'.git'))).resolves.toMatchObject({});
    expect(nativeReservations).toHaveLength(1);
    expect(path.dirname(path.dirname(nativeReservations[0]!))).toBe(nativeRoot);
    expect(path.basename(nativeReservations[0]!)).toBe('containment.receipt.json');
    expect(nativeBindings).toHaveLength(1);
    // Protocol 3 service ledger is the native authority; no local receipt file is required.
    expect(await authority.inspect({ directory: path.dirname(nativeReservations[0]!), binding: nativeBindings[0]! }))
      .toMatchObject({ state: 'terminal_verified', outcome: 'completed', exitCode: 0, activeProcesses: 0 });
    expect(await (await import('node:fs/promises')).readdir(path.join(root, 'tasks', '.index', 'v1', 'active'))).toEqual([]);
    const probe = await new SharedManagedWriterAdmission(path.join(root, 'tasks'), authority).holdExclusiveProbe(workspace.id);
    expect(probe.ok).toBe(true); if (probe.ok) await probe.value.releaseAfterVerifiedTermination();
  },45000);
});
