import console from 'node:console';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetVersion = process.argv[2];
const semanticVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (targetVersion !== undefined && !semanticVersionPattern.test(targetVersion)) {
  throw new Error(`Invalid semantic version: ${targetVersion}`);
}

async function updatePackageJson(filePath, newVersion) {
  const content = await readFile(filePath, 'utf8');
  const pkg = JSON.parse(content);
  pkg.version = newVersion;
  await writeFile(filePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`Updated ${path.relative(rootDir, filePath)} -> ${newVersion}`);
}

async function updatePackageJsonIfPresent(filePath, newVersion) {
  try {
    await updatePackageJson(filePath, newVersion);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
}

function isMissingPath(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function syncAllVersions() {
  const rootPkgPath = path.join(rootDir, 'package.json');
  const rootPkg = JSON.parse(await readFile(rootPkgPath, 'utf8'));
  const version = targetVersion || rootPkg.version;
  const name = rootPkg.name || 'lnwjud';

  console.log(`Synchronizing single source of truth for name "${name}" and version "${version}"...`);

  // 1. Root package.json
  await updatePackageJson(rootPkgPath, version);

  // 2. Apps package.json
  const appsDir = path.join(rootDir, 'apps');
  const appEntries = await readdir(appsDir, { withFileTypes: true });
  for (const entry of appEntries) {
    if (entry.isDirectory()) {
      const pkgPath = path.join(appsDir, entry.name, 'package.json');
      await updatePackageJsonIfPresent(pkgPath, version);
    }
  }

  // 3. Packages package.json
  const packagesDir = path.join(rootDir, 'packages');
  const packageEntries = await readdir(packagesDir, { withFileTypes: true });
  for (const entry of packageEntries) {
    if (entry.isDirectory()) {
      const pkgPath = path.join(packagesDir, entry.name, 'package.json');
      await updatePackageJsonIfPresent(pkgPath, version);
    }
  }

  // 4. Update packages/ipc-contracts/src/index.ts
  const ipcContractsPath = path.join(rootDir, 'packages', 'ipc-contracts', 'src', 'index.ts');
  let ipcContractsContent = await readFile(ipcContractsPath, 'utf8');
  ipcContractsContent = ipcContractsContent
    .replace(/export const APP_NAME = ['"][^'"]+['"];/, `export const APP_NAME = '${name}';`)
    .replace(/export const APP_VERSION = ['"][^'"]+['"];/, `export const APP_VERSION = '${version}';`);
  await writeFile(ipcContractsPath, ipcContractsContent, 'utf8');
  console.log(`Updated packages/ipc-contracts/src/index.ts -> ${name} v${version}`);

  // 5. Update packages/shared/src/index.ts
  const sharedPath = path.join(rootDir, 'packages', 'shared', 'src', 'index.ts');
  let sharedContent = await readFile(sharedPath, 'utf8');
  sharedContent = sharedContent
    .replace(/export const APP_NAME = ['"][^'"]+['"];/, `export const APP_NAME = '${name}';`)
    .replace(/export const APP_VERSION = ['"][^'"]+['"];/, `export const APP_VERSION = '${version}';`);
  await writeFile(sharedPath, sharedContent, 'utf8');
  console.log(`Updated packages/shared/src/index.ts -> ${name} v${version}`);

  // 6. Update tests/packaging/desktop-packaging.test.ts
  const testPackagingPath = path.join(rootDir, 'tests', 'packaging', 'desktop-packaging.test.ts');
  let testContent = await readFile(testPackagingPath, 'utf8');
  testContent = testContent
    .replace(/pins the product release to v[0-9.]+/g, `pins the product release to v${version}`)
    .replace(/expect\(rootPackage\.version\)\.toBe\(['"][^'"]+['"]\);/g, `expect(rootPackage.version).toBe('${version}');`)
    .replace(/expect\(desktopPackage\.version\)\.toBe\(['"][^'"]+['"]\);/g, `expect(desktopPackage.version).toBe('${version}');`)
    .replace(/expect\(packageJson\.version, packagePath\)\.toBe\(['"][^'"]+['"]\);/g, `expect(packageJson.version, packagePath).toBe('${version}');`)
    .replace(/expect\(ipcContracts\)\.toContain\(["']APP_VERSION = ['"][^'"]+['"]["']\);/g, `expect(ipcContracts).toContain("APP_VERSION = '${version}'");`)
    .replace(/expect\(shared\)\.toContain\(["']APP_VERSION = ['"][^'"]+['"]["']\);/g, `expect(shared).toContain("APP_VERSION = '${version}'");`);
  await writeFile(testPackagingPath, testContent, 'utf8');
  console.log(`Updated tests/packaging/desktop-packaging.test.ts -> v${version}`);

  // 7. Update Desktop UI version assertion.
  const mutationSafetyUiTestPath = path.join(rootDir, 'apps', 'desktop', 'tests', 'mutation-safety-ui.test.ts');
  let mutationSafetyUiTestContent = await readFile(mutationSafetyUiTestPath, 'utf8');
  mutationSafetyUiTestContent = mutationSafetyUiTestContent
    .replace(/renders the actual [0-9.]+ application version/g, `renders the actual ${version} application version`)
    .replace(/expect\(APP_VERSION\)\.toBe\(['"][^'"]+['"]\);/g, `expect(APP_VERSION).toBe('${version}');`)
    .replace(/expect\(markup\)\.toContain\(['"]v[0-9.]+['"]\);/g, `expect(markup).toContain('v${version}');`);
  await writeFile(mutationSafetyUiTestPath, mutationSafetyUiTestContent, 'utf8');
  console.log(`Updated apps/desktop/tests/mutation-safety-ui.test.ts -> v${version}`);

  // 8. Update concise and expanded README current-version references without rewriting release history.
  const readmePaths = [path.join(rootDir, 'README.md'), path.join(rootDir, 'FULL_README.md')];
  for (const readmePath of readmePaths) {
    let readmeContent = await readFile(readmePath, 'utf8');
    readmeContent = readmeContent
      .replace(/## Current source version: v[0-9.]+/g, `## Current source version: v${version}`)
      .replace(/## Current (?:version|source \/ release candidate|release): v[0-9.]+/g, `## Current version: v${version}`)
      .replace(/(`dev` (?:branch is )?preparing )v[0-9.]+/g, `$1v${version}`)
      .replace(/The v[0-9.]+ development runtime contract/g, `The v${version} development runtime contract`)
      .replace(/revalidated in the v[0-9.]+ verification pass/g, `revalidated in the v${version} verification pass`)
      .replace(/v[0-9.]+ keeps that fix while/g, `v${version} keeps that fix while`)
      .replace(/The v[0-9.]+ release target and runtime contract/g, 'The v' + version + ' release target and runtime contract')
      .replace(/current source\/release candidate is `v[0-9.]+`/g, 'current version is `v' + version + '`')
      .replace(/apps\/desktop\/dist\/installers\/lnwjud-Setup-[0-9.]+\.exe/g, `apps/desktop/dist/installers/lnwjud-Setup-${version}.exe`)
      .replace(/apps\/desktop\/dist\/installers\/lnwjud-Portable-[0-9.]+\.exe/g, `apps/desktop/dist/installers/lnwjud-Portable-${version}.exe`)
      .replace(/current v[0-9.]+ `ToolRegistry`/g, 'current v' + version + ' `ToolRegistry`');
    await writeFile(readmePath, readmeContent, 'utf8');
    console.log(`Updated ${path.basename(readmePath)} -> v${version}`);
  }

  const releaseReadme = await readFile(path.join(rootDir, 'README.md'), 'utf8');
  const publishedVersion = releaseReadme.match(/Latest published release: \*\*v([0-9.]+)\*\*/)?.[1] ?? version;

  // 9. Update current-version Markdown references without rewriting release history.
  const markdownTargets = [
    ['.github/RELEASE_CHECKLIST.md', (content) => content
      .replace(/\*\*Current (?:version|release candidate):\*\* `v[0-9.]+`/g, `**Current version:** ` + '`v' + version + '`')
      .replace(/(\*\*Current (?:version|release candidate):\*\*[^\r\n]*Windows installer `lnwjud-Setup-)[0-9.]+(\.exe`)/g, (_match, prefix, suffix) => prefix + version + suffix)
      .replace(/(portable executable `lnwjud-Portable-)[0-9.]+(\.exe`)/g, (_match, prefix, suffix) => prefix + version + suffix)],
    ['docs/development/PACKAGING_WINDOWS.md', (content) => content
      .replace(/For v[0-9.]+:/g, `For v${version}:`)
      .replace(/current v[0-9.]+ packaging contract/g, `current v${version} packaging contract`)
      .replace(/lnwjud-Setup-[0-9.]+\.exe/g, `lnwjud-Setup-${version}.exe`)
      .replace(/lnwjud-Portable-[0-9.]+\.exe/g, `lnwjud-Portable-${version}.exe`)],
    ['docs/INSTALL_MACOS.md', (content) => content.replace(/This guide covers the v[0-9.]+ native macOS release target/g, `This guide covers the v${version} native macOS release target`)],
    ['docs/USAGE_TH.md', (content) => content
      .replace(/^# คู่มือใช้งาน lnwjud v[0-9.]+ \(ภาษาไทย\)/m, `# คู่มือใช้งาน lnwjud v${version} (ภาษาไทย)`)
      .replace(/^คู่มือนี้อัปเดตตาม source[^\r\n]*$/m, `คู่มือนี้อัปเดตตาม source ` + '`v' + version + '`; public release `v' + publishedVersion + '` คือรุ่นที่เผยแพร่แล้วบน [GitHub Releases](https://github.com/engasnm111/lnwjud/releases/tag/v' + publishedVersion + ')')
      .replace(/apps\/desktop\/dist\/installers\/lnwjud-Setup-[0-9.]+\.exe/g, `apps/desktop/dist/installers/lnwjud-Setup-${version}.exe`)
      .replace(/apps\/desktop\/dist\/installers\/lnwjud-Portable-[0-9.]+\.exe/g, `apps/desktop/dist/installers/lnwjud-Portable-${version}.exe`)],
    ['docs/LNWJUD_CAPABILITIES.md', (content) => content.replace(/lnwjud v[0-9.]+/g, `lnwjud v${version}`).replace(/ความสามารถหลักใน v[0-9.]+ คือ:/g, `ความสามารถหลักใน v${version} คือ:`)],
    ['docs/architecture/MULTI_WORKSPACE_CONCURRENCY.md', (content) => content.replace(/current v[0-9.]+ runtime contract/g, `current v${version} runtime contract`)],
    ['docs/architecture/TOOL_CONTRACT.md', (content) => content.replace(/snapshot synchronized for `v[0-9.]+`/g, `snapshot synchronized for ` + '`v' + version + '`')],
    ['docs/architecture/UPGRADE_ARCHITECTURE.md', (content) => content.replace(/checkpoint synchronized for `v[0-9.]+`/g, `checkpoint synchronized for ` + '`v' + version + '`')],
  ];
  for (const [relativePath, update] of markdownTargets) {
    const targetPath = path.join(rootDir, relativePath);
    try {
      const content = await readFile(targetPath, 'utf8');
      await writeFile(targetPath, update(content), 'utf8');
      console.log(`Updated ${relativePath} -> v${version}`);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      // Optional/local documentation may be absent in a public checkout.
    }
  }

  // 10. Update current runtime/user-facing version strings without touching dated plans/evidence.
  const sourceTargets = [
    ['packages/application/src/agent-swarm-service.ts', (content) => content.replace(/Agent swarm v[0-9.]+ supports read_only access only/g, `Agent swarm v${version} supports read_only access only`)],
    ['packages/mcp-server/src/tool-registry.ts', (content) => content.replace(/v[0-9.]+ enforces read-only child sandboxes/g, `v${version} enforces read-only child sandboxes`)],
  ];
  for (const [relativePath, update] of sourceTargets) {
    const targetPath = path.join(rootDir, relativePath);
    const content = await readFile(targetPath, 'utf8');
    await writeFile(targetPath, update(content), 'utf8');
    console.log(`Updated ${relativePath} -> v${version}`);
  }

  console.log(`\nAll versions successfully synchronized to ${name} v${version}!`);
}

void syncAllVersions();
