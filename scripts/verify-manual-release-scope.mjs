/* global process */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
const [scope, packageJson, updateTrust] = await Promise.all([
  readJson('config/release-scope.json'),
  readJson('package.json'),
  readJson('config/update-release-policy.json'),
]);
const expected = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
if (scope.schemaVersion !== 1
  || scope.version !== packageJson.version
  || scope.installationMode !== 'in-app'
  || scope.automaticUpdaterEnabled !== false
  || JSON.stringify(scope.targets) !== JSON.stringify(expected)
  || JSON.stringify(scope.deferredTargets) !== '[]') {
  throw new Error('RELEASE_SCOPE_INVALID: current-version release must include every supported native target');
}
if (updateTrust.protocol !== 1
  || !Array.isArray(updateTrust.roots) || updateTrust.roots.length === 0
  || !Array.isArray(updateTrust.authorities)
  || updateTrust.authorities.some((authority) => authority?.repository !== 'https://github.com/engasnm111/lnwjud'
    || authority?.ref !== 'refs/heads/main')) {
  throw new Error('RELEASE_SCOPE_INVALID: update trust roots must stay pinned to this repository and main');
}
const main = await readFile(path.join(root, 'apps/desktop/src/main/main.ts'), 'utf8');
if (!main.includes('function operatorUpdateInstallAvailable(): boolean {')
  || !main.includes('autoUpdater.autoDownload = operatorUpdateInstallAvailable() &&')
  || !main.includes("if (!operatorUpdateInstallAvailable() || currentUpdateStatus.phase !== 'ready'")
  || !main.includes("if (!operatorUpdateInstallAvailable() || currentUpdateStatus.phase !== 'installing'")
  || !main.includes('autoUpdater.autoInstallOnAppQuit = false;')) {
  throw new Error('RELEASE_SCOPE_INVALID: Desktop must gate installation on a packaged operator confirmation and keep zero-click installation off');
}
const workflow = await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8');
if (workflow.includes('signed-update-e2e-') || expected.some((target) => {
  const [platform, arch] = target.split('-');
  const artifact = platform === 'win32' ? 'windows-release' : `native-${target}`;
  return !workflow.includes(`${target}|${artifact}-$sha`) || !workflow.includes(`${target}|${platform}|${arch}`);
})) {
  throw new Error('RELEASE_SCOPE_INVALID: release workflow contradicts the supported target policy');
}
process.stdout.write(`RELEASE_SCOPE_VERIFIED v${packageJson.version} Windows x64 + macOS and Linux x64/arm64, operator-confirmed platform updates\n`);
