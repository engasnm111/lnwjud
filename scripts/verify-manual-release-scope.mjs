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
const expected = ['win32-x64', 'linux-x64', 'linux-arm64'];
if (scope.schemaVersion !== 1
  || scope.version !== packageJson.version
  || scope.version !== '5.9.0'
  || scope.installationMode !== 'manual'
  || scope.automaticUpdaterEnabled !== false
  || JSON.stringify(scope.targets) !== JSON.stringify(expected)
  || JSON.stringify(scope.deferredTargets) !== JSON.stringify(['darwin-arm64', 'darwin-x64'])) {
  throw new Error('RELEASE_SCOPE_INVALID: only explicit manual-only Windows/Linux v5.9.0 is accepted');
}
if (updateTrust.protocol !== 1
  || !Array.isArray(updateTrust.roots) || updateTrust.roots.length !== 0
  || !Array.isArray(updateTrust.authorities) || updateTrust.authorities.length !== 0
  || updateTrust.verifier !== null) {
  throw new Error('RELEASE_SCOPE_INVALID: untrusted automatic update enrollment is not permitted');
}
const main = await readFile(path.join(root, 'apps/desktop/src/main/main.ts'), 'utf8');
if (!main.includes('const MANUAL_RELEASE_ONLY = true;')
  || !main.includes("if (MANUAL_RELEASE_ONLY) {")
  || !main.includes("phase: 'unavailable', message: nativeMessages(desktopLocale).updaterUnavailableTransactionAuthority, canInstall: false")) {
  throw new Error('RELEASE_SCOPE_INVALID: Desktop must refuse unattended installation');
}
const workflow = await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8');
if (!workflow.includes("LNWJUD_REQUIRE_UPDATE_ACCEPTANCE='0'")
  || workflow.includes('signed-update-e2e-')
  || workflow.includes('native-darwin-arm64-$sha')
  || workflow.includes('native-darwin-x64-$sha')) {
  throw new Error('RELEASE_SCOPE_INVALID: release workflow contradicts the manual-only target policy');
}
process.stdout.write('MANUAL_RELEASE_SCOPE_VERIFIED v5.9.0 Windows x64 + Linux x64/arm64, unattended updater fail-closed, macOS held\n');
