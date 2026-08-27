import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';

export interface SandboxExecutionPlanInput {
  readonly workspaceId: string;
  readonly allowedRoots: readonly string[];
  readonly inputPath: string;
  readonly outputPath: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly timeoutSeconds?: number;
  readonly jobId?: string;
}

export function buildSandboxExecutionPlan(input: SandboxExecutionPlanInput): Result<{
  readonly workspaceId: string;
  readonly jobId: string;
  readonly networking: 'disabled';
  readonly processIo: 'artifact-only';
  readonly inputReadOnly: true;
  readonly outputArtifact: { readonly path: string; readonly readOnly: false; readonly files: readonly string[] };
  readonly jobManifest: { readonly jobId: string; readonly workspaceId: string; readonly executable: string; readonly arguments: readonly string[]; readonly timeoutSeconds: number; readonly stdout: string; readonly stderr: string; readonly exitCode: string };
  readonly wsbXml: string;
}> {
  if (input.workspaceId.trim().length === 0) return err(appError('INVALID_INPUT', 'Sandbox workspaceId is required'));
  if (input.allowedRoots.length === 0) return err(appError('FILE_NOT_FOUND', 'No sandbox workspace root is configured'));
  if (input.executable.trim().length === 0 || input.executable.includes('\0') || input.arguments.some((argument) => argument.includes('\0'))) return err(appError('INVALID_INPUT', 'Sandbox executable or arguments are invalid'));
  if (containsShellString(input.executable, input.arguments)) return err(appError('INVALID_INPUT', 'Sandbox accepts argv only; shell command strings are not allowed'));
  const roots = input.allowedRoots.map((root) => path.win32.resolve(root));
  const hostInput = path.win32.resolve(input.inputPath);
  const hostOutput = path.win32.resolve(input.outputPath);
  if (!path.win32.isAbsolute(input.inputPath) || !path.win32.isAbsolute(input.outputPath) || !roots.some((root) => isWithin(root, hostInput)) || !roots.some((root) => isWithin(root, hostOutput))) {
    return err(appError('PATH_OUTSIDE_WORKSPACE', 'Sandbox mapped paths must remain inside registered workspace roots'));
  }
  const timeoutSeconds = input.timeoutSeconds ?? 300;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3_600) return err(appError('INVALID_INPUT', 'Sandbox timeout is invalid'));
  const jobId = input.jobId?.trim() || randomUUID();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(jobId)) return err(appError('INVALID_INPUT', 'Sandbox job ID is invalid'));

  const sandboxInput = 'C:\\lnwjud\\input';
  const sandboxOutput = 'C:\\lnwjud\\output';
  const stdout = `${sandboxOutput}\\stdout.log`;
  const stderr = `${sandboxOutput}\\stderr.log`;
  const exitCode = `${sandboxOutput}\\exit-code.txt`;
  const jobManifest = { jobId, workspaceId: input.workspaceId, executable: input.executable, arguments: [...input.arguments], timeoutSeconds, stdout, stderr, exitCode };
  const wsbXml = `<Configuration>\n  <VGpu>Disable</VGpu>\n  <Networking>Disable</Networking>\n  <ProtectedClient>Enable</ProtectedClient>\n  <MappedFolders>\n    <MappedFolder>\n      <HostFolder>${escapeXml(hostInput)}</HostFolder>\n      <SandboxFolder>${sandboxInput}</SandboxFolder>\n      <ReadOnly>true</ReadOnly>\n    </MappedFolder>\n    <MappedFolder>\n      <HostFolder>${escapeXml(hostOutput)}</HostFolder>\n      <SandboxFolder>${sandboxOutput}</SandboxFolder>\n      <ReadOnly>false</ReadOnly>\n    </MappedFolder>\n  </MappedFolders>\n  <LogonCommand>\n    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${sandboxInput}\\sandbox-runner.ps1</Command>\n  </LogonCommand>\n</Configuration>`;
  return ok({
    workspaceId: input.workspaceId,
    jobId,
    networking: 'disabled',
    processIo: 'artifact-only',
    inputReadOnly: true,
    outputArtifact: { path: hostOutput, readOnly: false, files: [path.win32.join(hostOutput, 'job-manifest.json'), path.win32.join(hostOutput, 'stdout.log'), path.win32.join(hostOutput, 'stderr.log'), path.win32.join(hostOutput, 'exit-code.txt')] },
    jobManifest,
    wsbXml,
  });
}

function containsShellString(executable: string, args: readonly string[]): boolean {
  const basename = path.posix.basename(executable.replaceAll('\\', '/')).toLowerCase();
  const interpreters = new Set(['sh', 'dash', 'bash', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd', 'node', 'python', 'python3']);
  const flags = new Set(['-c', '-lc', '-cl', '--command', '-command', '-encodedcommand', '-e', '--eval']);
  return interpreters.has(basename) && args.some((argument) => flags.has(argument.toLowerCase()));
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.win32.relative(root.toLowerCase(), candidate.toLowerCase());
  if (relative === '') return true;
  if (path.win32.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(path.win32.sep);
  return firstSegment !== '..';
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
