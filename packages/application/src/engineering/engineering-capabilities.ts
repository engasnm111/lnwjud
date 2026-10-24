import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { EngineeringArtifactRole, EngineeringCapabilityFacts, EngineeringFact } from '@lnwjud/domain';

const MAX_FILES = 4096;
const MAX_BYTES = 64 * 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set(['.git', '.codegraph', '.audit', '.worktrees', 'node_modules', '.next', '.turbo', '.parcel-cache', 'dist', 'build', 'coverage']);
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
function failure(error: unknown): EngineeringFact<never> {
  return { state: 'unreadable', reasonCode: error instanceof Error && error.message === 'SOURCE_UNSTABLE' ? 'SOURCE_UNSTABLE' : 'BOUNDED_READ_FAILED' };
}
async function git(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args], { timeout: 3000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
async function boundedFile(root: string, relative: string, limit = 256 * 1024): Promise<EngineeringFact<string>> {
  try {
    const file = path.resolve(root, relative);
    const canonical = await realpath(file);
    if (!inside(root, canonical)) return { state: 'unreadable', reasonCode: 'PATH_OUTSIDE_WORKSPACE' };
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return { state: 'unsupported', reasonCode: 'FILE_TYPE_OR_SIZE' };
    return { state: 'present', value: await readFile(file, 'utf8') };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return { state: 'absent', reasonCode: 'NOT_FOUND' };
    return failure(error);
  }
}
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** No project commands are executed. The only process is a bounded, read-only Git query. */
export async function observeEngineeringCapabilities(rootPath: string): Promise<EngineeringCapabilityFacts> {
  const root = await realpath(rootPath);
  const gitMarker = await lstat(path.join(root, '.git')).then(() => true, (error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  });
  let gitFact: EngineeringCapabilityFacts['git'] = { state: 'absent', reasonCode: 'NO_GIT' };
  let remote: EngineeringCapabilityFacts['remote'] = { state: 'absent', reasonCode: 'NO_GIT' };
  if (gitMarker) {
    try {
      const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
      gitFact = /^[0-9a-f]{40,64}$/i.test(head) ? { state: 'present', value: { head } } : { state: 'unknown', reasonCode: 'INVALID_HEAD' };
    } catch (error) { gitFact = failure(error); }
    try {
      const names = (await git(root, ['remote'])).trim().split(/\r?\n/).filter(Boolean);
      if (names.length === 0) remote = { state: 'absent', reasonCode: 'NO_REMOTE' };
      else {
        const urls = await Promise.all(names.slice(0, 16).map((name) => git(root, ['remote', 'get-url', name])));
        remote = { state: 'present', value: { provider: urls.every((url) => /(?:@|\/\/)github\.com[:/]/i.test(url)) ? 'github' : 'other' } };
      }
    } catch (error) { remote = failure(error); }
  }
  let ci: EngineeringCapabilityFacts['ci'];
  try {
    const entries = await readdir(path.join(root, '.github', 'workflows'), { withFileTypes: true });
    const yaml = entries.filter((entry) => /\.ya?ml$/i.test(entry.name));
    if (yaml.length > 64) ci = { state: 'unknown', reasonCode: 'CI_CONFIG_LIMIT' };
    else {
      const reads = await Promise.all(yaml.map((entry) => boundedFile(root, `.github/workflows/${entry.name}`)));
      ci = reads.some((entry) => entry.state !== 'present') ? { state: 'unreadable', reasonCode: 'CI_CONFIG_UNREADABLE' }
        : yaml.length > 0 ? { state: 'present', value: { provider: 'github' } } : { state: 'absent', reasonCode: 'NO_HOSTED_CI_CONFIG' };
    }
  } catch (error) {
    ci = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
      ? { state: 'absent', reasonCode: 'NO_HOSTED_CI_CONFIG' } : failure(error);
  }
  for (const config of ['.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile', '.circleci/config.yml']) {
    const observed = await boundedFile(root, config);
    if (observed.state === 'present') ci = { state: 'present', value: { provider: 'other' } };
    else if (observed.state !== 'absent') ci = { state: observed.state, reasonCode: 'CI_CONFIG_UNREADABLE' };
  }
  const workerConfigs = await Promise.all(['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'].map((file) => boundedFile(root, file)));
  const worker = workerConfigs.some((entry) => entry.state === 'present');
  const unknownWorker = workerConfigs.some((entry) => entry.state !== 'present' && entry.state !== 'absent');
  const packageJson = await boundedFile(root, 'package.json');
  let artifact: EngineeringCapabilityFacts['artifact'] = { state: 'absent', reasonCode: 'NO_ARTIFACT_DECLARATION' };
  let role: EngineeringArtifactRole | undefined;
  if (worker) role = 'worker_bundle';
  else if (unknownWorker) artifact = { state: 'unreadable', reasonCode: 'WORKER_CONFIG_UNREADABLE' };
  else if (packageJson.state === 'present') {
    try {
      const pkg: unknown = JSON.parse(packageJson.value);
      if (typeof pkg === 'object' && pkg !== null) {
        const text = JSON.stringify(pkg);
        if (/"electron(?:-builder)?"/.test(text)) role = 'desktop_installer';
        else if (/"(?:next|vite|astro)"/.test(text)) role = 'static_manifest';
        else if ('exports' in pkg || 'bin' in pkg || 'main' in pkg) role = 'library_archive';
      }
    } catch { artifact = { state: 'unreadable', reasonCode: 'INVALID_PACKAGE_MANIFEST' }; }
  } else if (packageJson.state !== 'absent') artifact = { state: packageJson.state, reasonCode: 'PACKAGE_MANIFEST_UNREADABLE' };
  const docker = await boundedFile(root, 'Dockerfile');
  if (!worker && docker.state === 'present') role = 'container_digest';
  if (role !== undefined) artifact = { state: 'present', value: role };
  const deployment: EngineeringCapabilityFacts['deployment'] = worker ? { state: 'present', value: 'cloudflare_worker' }
    : unknownWorker ? { state: 'unreadable', reasonCode: 'WORKER_CONFIG_UNREADABLE' } : { state: 'unknown', reasonCode: 'DEPLOYMENT_PROVIDER_NOT_DETECTED' };
  const source = await observeSourceSnapshot(root, gitMarker);
  let workerTarget: EngineeringCapabilityFacts['workerTarget'];
  for (let index = 0; index < workerConfigs.length; index += 1) {
    const config = workerConfigs[index];
    if (config?.state !== 'present') continue;
    try {
      const parsed: unknown = index === 0
        ? Object.fromEntries([...config.value.split(/^\[/m)[0]!.matchAll(/^(account_id|name)\s*=\s*["']([a-zA-Z0-9_-]+)["']\s*$/gm)].map((match) => [match[1], match[2]]))
        : JSON.parse(config.value);
      if (typeof parsed === 'object' && parsed !== null && 'account_id' in parsed && 'name' in parsed
        && typeof parsed.account_id === 'string' && /^[a-f0-9]{32}$/i.test(parsed.account_id)
        && typeof parsed.name === 'string' && /^[a-zA-Z0-9_-]{1,63}$/.test(parsed.name)) {
        workerTarget = { accountId: parsed.account_id, worker: parsed.name, environment: 'production', trafficPercent: 100 };
      }
    } catch { continue; }
  }
  const facts = { git: gitFact, remote, ci, artifact, deployment, source, ...(workerTarget === undefined ? {} : { workerTarget }) };
  return { ...facts, digest: hash(JSON.stringify(facts)) };
}

export async function observeSourceSnapshot(rootPath: string, gitProject?: boolean): Promise<EngineeringCapabilityFacts['source']> {
  try {
    const root = await realpath(rootPath);
    const useGit = gitProject ?? await lstat(path.join(root, '.git')).then(() => true, () => false);
    const deadline = Date.now() + 10_000;
    const capture = async (): Promise<{ digest: string; fileCount: number }> => {
      const files: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (Date.now() > deadline || files.length > MAX_FILES) throw new Error('SOURCE_LIMIT');
          if (entry.isSymbolicLink()) throw new Error('SOURCE_REPARSE');
          if (entry.isDirectory()) { if (!EXCLUDED_DIRECTORIES.has(entry.name)) await walk(path.join(dir, entry.name)); }
          else files.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
        }
      };
      if (useGit) {
        const [visible, ignored] = await Promise.all([
          git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
          git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']),
        ]);
        files.push(...visible.split('\0').filter(Boolean));
        for (const entry of ignored.split('\0').filter(Boolean)) {
          const relative = entry.replace(/[\\/]+$/, '');
          if (relative.length === 0 || relative.split(/[\\/]/).some((part) => EXCLUDED_DIRECTORIES.has(part))) continue;
          const absolute = path.resolve(root, relative);
          if (!inside(root, absolute)) throw new Error('SOURCE_OUTSIDE');
          const metadata = await lstat(absolute);
          if (metadata.isSymbolicLink()) throw new Error('SOURCE_REPARSE');
          if (metadata.isDirectory()) await walk(absolute);
          else if (metadata.isFile()) files.push(relative);
          else throw new Error('SOURCE_TYPE');
        }
      } else await walk(root);
      const unique = [...new Set(files)].sort();
      if (unique.length > MAX_FILES) throw new Error('SOURCE_LIMIT');
      let bytes = 0;
      const digest = createHash('sha256').update('lnwjud-source-manifest-v2\0');
      for (const relative of unique) {
        if (Date.now() > deadline) throw new Error('SOURCE_LIMIT');
        const file = path.resolve(root, relative);
        if (!inside(root, file) || !inside(root, await realpath(file))) throw new Error('SOURCE_OUTSIDE');
        const before = await lstat(file);
        if (!before.isFile() || before.isSymbolicLink()) throw new Error('SOURCE_REPARSE');
        bytes += before.size;
        if (bytes > MAX_BYTES) throw new Error('SOURCE_LIMIT');
        const content = await readFile(file);
        const after = await lstat(file);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('SOURCE_UNSTABLE');
        digest.update(JSON.stringify([relative, content.length, hash(content)]));
      }
      return { digest: digest.digest('hex'), fileCount: unique.length };
    };
    const first = await capture();
    const second = await capture();
    if (first.digest !== second.digest) throw new Error('SOURCE_UNSTABLE');
    return { state: 'present', value: first };
  } catch (error) { return failure(error); }
}
