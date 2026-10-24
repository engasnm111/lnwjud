import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WindowsNativeAuthority, type NativeAttemptBinding } from '@lnwjud/process';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const helper = path.join(repo, 'native/windows-containment-helper/artifacts/win-x64/lnwjud-containment.exe');
const pinModule = path.join(path.dirname(helper), 'lnwjud-containment-pin.node');
let helperHash: string;
let pinHash: string;
let harnessRoot: string;
let harness: string;
const baseBinding: NativeAttemptBinding = {
  taskId: 'import-native-test', reservationId: 'import-native-test', attemptId: 'import-native-test', generation: 1,
  requestDigest: 'a'.repeat(64), ownerClientId: 'client', ownerSessionId: 'session', workspaceId: 'workspace',
};

type NativeImportRequest = { workspaceRoot: string; stagePath: string; destination: string; privateHome: string; commit: string };
type ImportControl = (command: 'prepare_import' | 'publish_import' | 'inspect_publication', overrides?: Partial<NativeImportRequest> & { expectedStageIdentity?: string }) => ReturnType<WindowsNativeAuthority['control']>;
async function fixture(): Promise<{ root: string; request: NativeImportRequest; authority: WindowsNativeAuthority; control: ImportControl }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-native-import-'));
  const workspaceRoot = path.join(root, 'workspace');
  const privateHome = path.join(root, 'home');
  await mkdir(workspaceRoot); await mkdir(privateHome);
  const authority = new WindowsNativeAuthority({ helper: { executable: helper, sha256: helperHash, buildId: 'lnwjud-containment-v2' }, pin: { modulePath: pinModule, sha256: pinHash }, profileDirectory: path.join(root, 'profile') });
  const request = { workspaceRoot, stagePath: path.join(root, '.lnwjud-import-stage-' + randomUUID()), destination: 'published', privateHome, commit: 'a'.repeat(40) };
  const control: ImportControl = async (command, overrides = {}): ReturnType<WindowsNativeAuthority['control']> => authority.control({
    directory: path.join(root, 'control-' + randomUUID()), binding: baseBinding, command, request: { ...request, ...overrides },
  });
  return { root, request, authority, control };
}
describe.skipIf(process.platform !== 'win32')('packaged native repository import controls', () => {
  beforeAll(async () => {
    helperHash = createHash('sha256').update(await readFile(helper)).digest('hex');
    pinHash = createHash('sha256').update(await readFile(pinModule)).digest('hex');
    harnessRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-anchor-harness-'));
    const source = path.join(repo, 'native/windows-containment-helper/RepositoryImportAnchor.cs');
    await writeFile(path.join(harnessRoot, 'AnchorHarness.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup><Compile Include="${source}" /></ItemGroup></Project>`);
    await writeFile(path.join(harnessRoot, 'Program.cs'), `using Lnwjud.Containment;
using System.Security.AccessControl;
using System.Security.Principal;
if (args[0] == "acl") {
  var acl = new DirectoryInfo(args[1]).GetAccessControl();
  var rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
  var owner = WindowsIdentity.GetCurrent().User!;
  if (!acl.AreAccessRulesProtected || !acl.GetOwner(typeof(SecurityIdentifier)).Equals(owner) || rules.Count != 1) throw new Exception("ACL_INVALID");
  var rule = (FileSystemAccessRule)rules[0];
  if (!rule.IdentityReference.Equals(owner) || rule.IsInherited || rule.AccessControlType != AccessControlType.Allow || rule.FileSystemRights != FileSystemRights.FullControl) throw new Exception("ACL_RULE_INVALID");
  Console.WriteLine("PRIVATE_STAGE_DACL_VERIFIED"); return;
}
using var anchor = new RepositoryImportAnchor(args[0], "absent");
Console.WriteLine("ANCHORED");
Thread.Sleep(120000);`);
    await execute('dotnet', ['build', path.join(harnessRoot, 'AnchorHarness.csproj'), '-o', path.join(harnessRoot, 'out'), '--nologo', '--disable-build-servers', '-p:UseSharedCompilation=false'], { timeout: 90000, env: { ...process.env, DOTNET_CLI_USE_MSBUILD_SERVER: '0', MSBUILDDISABLENODEREUSE: '1' } });
    harness = path.join(harnessRoot, 'out/AnchorHarness.exe');
  }, 100000);
  afterAll(async () => { if (harnessRoot) await rm(harnessRoot, { recursive: true, force: true }); });

  it('pins workspace and all ancestors until hard termination and removes its private guard', async () => {
    const f = await fixture();
    const child = spawn(harness, [f.request.workspaceRoot], { windowsHide: true });
    const closed = once(child, 'close');
    try {
      const ready = await new Promise<boolean>(resolve => {
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.includes('ANCHORED')) resolve(true); });
        child.once('close', () => resolve(false)); child.once('error', () => resolve(false));
      });
      expect(ready).toBe(true);
      await expect(rename(f.request.workspaceRoot, f.request.workspaceRoot + '-moved')).rejects.toThrow();
      await expect(rename(f.root, f.root + '-moved')).rejects.toThrow();
      const guards = (await readdir(f.request.workspaceRoot)).filter(name => name.startsWith('.lnwjud-import-guard-'));
      expect(guards).toHaveLength(1);
      await expect(rm(path.join(f.request.workspaceRoot, guards[0]!), { recursive: true })).rejects.toThrow();
      expect(child.kill()).toBe(true); await closed;
      expect(await readdir(f.request.workspaceRoot)).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed; await rm(f.root, { recursive: true, force: true });
    }
  }, 30000);

  it('refuses junction ancestry without touching its target', async () => {
    const f = await fixture();
    try {
      const outside = path.join(f.root, 'outside'); await mkdir(outside);
      const junction = path.join(f.request.workspaceRoot, 'redirect'); await symlink(outside, junction, 'junction');
      expect((await f.control('prepare_import', { destination: 'redirect/escape' })).state).toBe('termination_unknown');
      expect(await readdir(outside)).toEqual([]);
      await rm(junction);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 30000);

  // Caller-side controls cannot create an import transaction without an authenticated
  // outer attempt that has completed native dispatch. The installed SCM ledger owns
  // that admission; test-only stage publication is exercised against isolated native
  // service ledgers in the restricted native import suite below.
  it('refuses caller import control with no dispatched outer attempt and leaves the workspace unchanged', async () => {
    const f = await fixture();
    try {
      expect((await f.control('prepare_import')).state).toBe('termination_unknown');
      expect(await readdir(f.request.workspaceRoot)).toEqual([]);
      await expect(readFile(path.join(f.request.stagePath, 'proof.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const foreign = await f.authority.control({ directory: path.join(f.root, 'foreign'),
        binding: { ...baseBinding, ownerSessionId: 'foreign' }, command: 'prepare_import', request: f.request });
      expect(foreign.state).toBe('termination_unknown');
      expect(await readdir(f.request.workspaceRoot)).toEqual([]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 30_000);

  it('validates isolated native stage, publication, cancellation, and restart/replay safety under Restricted', async () => {
    const nativeSuite = path.join(repo, 'native/windows-containment-helper/tests/ContainmentNativeTests.csproj');
    const nativeExecutable = path.join(repo, 'native/windows-containment-helper/tests/bin/Release/net8.0/win-x64/ContainmentNativeTests.exe');
    // A .NET shared compiler/MSBuild server can survive the dotnet run parent.
    // Native containment must wait for *all* descendants, so disallow reusable
    // build servers, then execute the freshly built test binary directly.
    const isolatedEnvironment = {
      ...process.env,
      PSExecutionPolicyPreference: 'Restricted',
      DOTNET_CLI_USE_MSBUILD_SERVER: '0',
      MSBUILDDISABLENODEREUSE: '1',
    };
    // Hosted Windows workspace-test runners have no restored native test assets.
    // Restore the self-contained test project before isolated compilation.
    await execute('dotnet', ['build', nativeSuite, '-c', 'Release',
      '--disable-build-servers', '-p:UseSharedCompilation=false'], {
      timeout: 180_000, maxBuffer: 1024 * 1024, env: isolatedEnvironment,
    });
    const { stdout } = await execute(nativeExecutable, ['import-suite'], {
      timeout: 180_000, maxBuffer: 1024 * 1024, env: isolatedEnvironment,
    });
    for (const marker of [
      'PASS isolated import shared-writer promotion',
      'PASS isolated import stage, owner binding and restart persistence',
      'PASS isolated import publication, cancellation, collision and recovery',
      'PASS isolated authenticated service import RPC',
    ]) expect(stdout).toContain(marker);
  }, 200_000);

});
