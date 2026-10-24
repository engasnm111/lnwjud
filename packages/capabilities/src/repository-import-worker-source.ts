export const repositoryImportWorkerSource = String.raw`'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const cp = require('node:child_process');
const { TextDecoder } = require('node:util');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const decoder = new TextDecoder('utf-8', { fatal: true });
const gitOptions = [
  '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
  '-c', 'credential.helper=', '-c', 'core.hooksPath=NUL',
  '-c', 'core.fsmonitor=false', '-c', 'http.followRedirects=false',
  '-c', 'submodule.recurse=false', '-c', 'core.protectNTFS=true',
  '-c', 'core.protectHFS=true', '-c', 'filter.lfs.required=false',
];
const device = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const component = /^[A-Za-z0-9._-]+$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function assertTree(input) {
  if (input.length === 0 || input.length > 16 * 1024 * 1024 || input[input.length-1] !== 0) throw Error('INVALID_TREE');
  const files = new Set();
  const directories = new Map();
  let count = 0, position = 0;
  while (position < input.length) {
    const end = input.indexOf(0, position);
    if (end <= position || end === -1 || ++count > 80000) throw Error('INVALID_TREE');
    let row;
    try { row = decoder.decode(input.subarray(position, end)); } catch { throw Error('INVALID_TREE'); }
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/i.exec(row);
    if (!match || match[3].length > 4096) throw Error('INVALID_TREE');
    const segments = match[3].split('/');
    if (segments.length > 128) throw Error('INVALID_TREE');
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i];
      if (!component.test(name) || name === '.' || name === '..' || name.endsWith('.')
        || device.test(name) || name.toLowerCase() === '.git'
        || name.toLowerCase() === '.gitmodules' || name.toLowerCase().startsWith('.lnwjud')) throw Error('INVALID_TREE');
      const prefix = segments.slice(0, i+1).join('/');
      const folded = prefix.toLowerCase();
      if (i === segments.length-1) {
        if (files.has(folded) || directories.has(folded)) throw Error('INVALID_TREE');
        files.add(folded);
      } else {
        if (files.has(folded)) throw Error('INVALID_TREE');
        if (directories.has(folded) && directories.get(folded) !== prefix) throw Error('INVALID_TREE');
        directories.set(folded, prefix);
      }
    }
    position = end+1;
  }
  return count;
}

async function run(executable, args, options = {}) {
  const maxBytes = options.maxBytes || 65536;
  const deadline = options.timeoutMs || 300000;
  return await new Promise((resolve, reject) => {
    const child = cp.spawn(executable, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let chunks = [], size = 0, total = 0, killed = false;
    const watchdog = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, deadline);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { killed = true; child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { total += chunk.length; if (total > 65536) { killed = true; child.kill('SIGKILL'); } });
    child.once('error', () => { killed = true; });
    child.once('close', code => {
      clearTimeout(watchdog);
      if (killed || code !== 0) return reject(Error('IMPORT_CHILD_FAILED'));
      resolve(Buffer.concat(chunks));
    });
  });
}

function privateGitEnvironment(spec) {
  const env = {};
  for (const name of ['SystemRoot','windir','PATH','PATHEXT','ComSpec','TEMP','TMP','SystemDrive','PROCESSOR_ARCHITECTURE']) {
    if (name !== 'PATH' && process.env[name]) env[name] = process.env[name];
  }
  // Do not execute attacker-shadowed Git or helper binaries from the ambient PATH.
  // Restrict both search path and Git installation to system-controlled locations.
  const windowsRoot = process.env.SystemRoot;
  const drive = process.env.SystemDrive;
  if (!windowsRoot || !drive || !/^[A-Za-z]:$/.test(drive) || !path.win32.isAbsolute(windowsRoot)) throw Error('IMPORT_TRUSTED_OS_PATH_UNAVAILABLE');
  const gitBin = path.win32.join(drive + '\\\\', 'Program Files', 'Git', 'cmd');
  env.PATH = [path.win32.join(windowsRoot,'System32'), windowsRoot, gitBin].join(';');
  Object.assign(env, {
    HOME: spec.privateHome, XDG_CONFIG_HOME: spec.privateHome,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_COUNT: '0',
    GIT_TRACE: '0', GIT_TRACE_SETUP: '0',
    GIT_OPTIONAL_LOCKS: '0',
  });
  return env;
}

async function main() {
  const spec = JSON.parse(await fsp.readFile(process.argv[2], 'utf8'));
  const { binding: ignoredBinding, manifestDigest: ignoredManifestDigest, ...manifestCore } = spec;
  if (spec.version !== 2 || spec.requestDigest !== process.argv[3]
    || spec.manifestDigest !== process.argv[4]
    || createHash('sha256').update(JSON.stringify(manifestCore)).digest('hex') !== spec.manifestDigest
    || createHash('sha256').update(JSON.stringify({ input: spec.originalInput })).digest('hex') !== spec.requestDigest
    || spec.commit !== spec.originalInput.request.commit.toLowerCase()
    || spec.url !== spec.originalInput.request.url || spec.destination !== spec.originalInput.request.destination
    || !SHA.test(spec.commit) || !/^[a-zA-Z0-9_-]{1,64}$/.test(spec.requestId)
    || !path.win32.isAbsolute(spec.workspaceRoot) || !path.win32.isAbsolute(spec.stagePath)
    || !path.win32.isAbsolute(spec.privateHome)) throw Error('INVALID_INTERNAL_SPEC');
  const { WindowsNativeAuthority } = await import(pathToFileURL(spec.processModule).href);
  const authority = new WindowsNativeAuthority(spec.authorityConfig);
  const control = async (command, request) => {
    const directory = path.join(path.dirname(process.argv[2]), command);
    const result = await authority.control({ directory, binding: spec.binding, command, request });
    if (result.state !== 'control_verified') throw Error('IMPORT_NATIVE_CONTROL_UNVERIFIED');
    const readback = await authority.inspectControl({ directory, binding: spec.binding, command });
    if (readback.state !== 'control_verified' || JSON.stringify(readback.result) !== JSON.stringify(result.result)) throw Error('IMPORT_NATIVE_READBACK_UNVERIFIED');
    return readback.result;
  };
  const env = privateGitEnvironment(spec);
  await fsp.mkdir(spec.privateHome, { recursive: true, mode: 0o700 });
  const gitExecutable = path.win32.join(process.env.SystemDrive + '\\\\', 'Program Files', 'Git', 'cmd', 'git.exe');
  if (!fs.existsSync(gitExecutable)) throw Error('IMPORT_TRUSTED_GIT_UNAVAILABLE');
  const operation = { workspaceRoot: spec.workspaceRoot, destination: spec.destination, stagePath: spec.stagePath, commit: spec.commit, privateHome: spec.privateHome };
  const prepared = await control('prepare_import', operation);
  const stageIdentity = prepared.nativeIdentity;
  if (!/^[0-9A-F]{16}-[0-9A-F]{32}$/.test(stageIdentity)) throw Error('IMPORT_STAGE_IDENTITY_UNAVAILABLE');
  let published = false;
  try {
    const git = (args, maxBytes = 65536) =>
      run(gitExecutable, [...gitOptions, ...args], { cwd: spec.privateHome, env, maxBytes, timeoutMs: 300000 });
    await git(['clone','--no-checkout','--no-recurse-submodules','--origin','origin','--',spec.url,spec.stagePath]);
    const commit = (await git(['-C',spec.stagePath,'rev-parse','--verify',spec.commit+'^{commit}'])).toString('utf8').trim().toLowerCase();
    if (commit !== spec.commit) throw Error('COMMIT_MISMATCH');
    const entries = await git(['-C',spec.stagePath,'ls-tree','-r','-z','--full-tree',commit],16*1024*1024);
    const fileCount = assertTree(entries);
    await git(['-C',spec.stagePath,'checkout','--detach','--force',commit]);
    const head = (await git(['-C',spec.stagePath,'rev-parse','HEAD'])).toString('utf8').trim().toLowerCase();
    if (head !== spec.commit) throw Error('CHECKOUT_MISMATCH');
    const evidence = await control('publish_import', { ...operation, expectedStageIdentity: stageIdentity });
    if (evidence.state !== 'published' || evidence.commit !== spec.commit
      || typeof evidence.nativeIdentity !== 'string') throw Error('IDENTITY_UNVERIFIED');
    published = true;
    process.stdout.write(JSON.stringify({ state: 'published', commit: spec.commit, files: fileCount }));
  } finally {
    // Never recursively delete a staging *path* after a failed or ambiguous
    // publication: a racing replacement could redirect removal to another tree.
    // Leave orphaned private staging for later identity-verified reconciliation.
    // Job Object containment still governs the lifetime of spawned descendants.
    if (!published) process.stderr.write('IMPORT_STAGE_RETAINED_FOR_NATIVE_RECONCILIATION');
  }
}

main().catch(() => { process.stderr.write('REPOSITORY_IMPORT_FAILED'); process.exitCode = 1; });
`;
