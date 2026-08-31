import console from 'node:console';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetVersion = process.argv[2];

async function updatePackageJson(filePath, newVersion) {
  const content = await readFile(filePath, 'utf8');
  const pkg = JSON.parse(content);
  pkg.version = newVersion;
  await writeFile(filePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`Updated ${path.relative(rootDir, filePath)} -> ${newVersion}`);
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
      try {
        await updatePackageJson(pkgPath, version);
      } catch {
        // skip if no package.json
      }
    }
  }

  // 3. Packages package.json
  const packagesDir = path.join(rootDir, 'packages');
  const packageEntries = await readdir(packagesDir, { withFileTypes: true });
  for (const entry of packageEntries) {
    if (entry.isDirectory()) {
      const pkgPath = path.join(packagesDir, entry.name, 'package.json');
      try {
        await updatePackageJson(pkgPath, version);
      } catch {
        // skip if no package.json
      }
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
  try {
    let testContent = await readFile(testPackagingPath, 'utf8');
    testContent = testContent
      .replace(/pins the product release to v[0-9.]+/g, `pins the product release to v${version}`)
      .replace(/expect\(rootPackage\.version\)\.toBe\(['"][^'"]+['"]\);/g, `expect(rootPackage.version).toBe('${version}');`)
      .replace(/expect\(desktopPackage\.version\)\.toBe\(['"][^'"]+['"]\);/g, `expect(desktopPackage.version).toBe('${version}');`);
    await writeFile(testPackagingPath, testContent, 'utf8');
    console.log(`Updated tests/packaging/desktop-packaging.test.ts -> v${version}`);
  } catch {
    // skip if missing
  }

  // 7. Update Desktop UI version assertion.
  const mutationSafetyUiTestPath = path.join(rootDir, 'apps', 'desktop', 'tests', 'mutation-safety-ui.test.ts');
  try {
    let testContent = await readFile(mutationSafetyUiTestPath, 'utf8');
    testContent = testContent
      .replace(/renders the actual [0-9.]+ application version/g, `renders the actual ${version} application version`)
      .replace(/expect\(APP_VERSION\)\.toBe\(['"][^'"]+['"]\);/g, `expect(APP_VERSION).toBe('${version}');`)
      .replace(/expect\(markup\)\.toContain\(['"]v[0-9.]+['"]\);/g, `expect(markup).toContain('v${version}');`);
    await writeFile(mutationSafetyUiTestPath, testContent, 'utf8');
    console.log(`Updated apps/desktop/tests/mutation-safety-ui.test.ts -> v${version}`);
  } catch {
    // skip if missing
  }

  // 8. Update README.md current-version references without rewriting release history.
  const readmePath = path.join(rootDir, 'README.md');
  try {
    let readmeContent = await readFile(readmePath, 'utf8');
    readmeContent = readmeContent
      .replace(/## Current (?:version|source \/ release candidate|release): v[0-9.]+/g, `## Current version: v${version}`)
      .replace(/The v[0-9.]+ release target and runtime contract/g, 'The v' + version + ' release target and runtime contract')
      .replace(/current source\/release candidate is `v[0-9.]+`/g, 'current version is `v' + version + '`')
      .replace(/The Windows installer for the current version is `lnwjud-Setup-[0-9.]+\.exe`/g, 'The Windows installer for the current version is `lnwjud-Setup-' + version + '.exe`')
      .replace(/Current Windows 10\/11 x64 artifacts are `lnwjud-Setup-[0-9.]+\.exe` \(recommended installer\) and `lnwjud-Portable-[0-9.]+\.exe`/g, 'Current Windows 10/11 x64 artifacts are `lnwjud-Setup-' + version + '.exe` (recommended installer) and `lnwjud-Portable-' + version + '.exe`')
      .replace(/If you prefer not to install the app, run `lnwjud-Portable-[0-9.]+\.exe` directly\./g, 'If you prefer not to install the app, run `lnwjud-Portable-' + version + '.exe` directly.')
      .replace(/1\. แบบแนะนำ: ดาวน์โหลด `lnwjud-Setup-[0-9.]+\.exe` แล้วติดตั้งตามปกติ/g, '1. แบบแนะนำ: ดาวน์โหลด `lnwjud-Setup-' + version + '.exe` แล้วติดตั้งตามปกติ')
      .replace(/2\. ถ้าไม่ต้องการติดตั้ง: ดาวน์โหลด `lnwjud-Portable-[0-9.]+\.exe` แล้วเปิดได้ทันที/g, '2. ถ้าไม่ต้องการติดตั้ง: ดาวน์โหลด `lnwjud-Portable-' + version + '.exe` แล้วเปิดได้ทันที')
      .replace(/ถ้าใช้ `lnwjud-Setup-[0-9.]+\.exe` หรือ `lnwjud-Portable-[0-9.]+\.exe` บน Windows x64/g, 'ถ้าใช้ `lnwjud-Setup-' + version + '.exe` หรือ `lnwjud-Portable-' + version + '.exe` บน Windows x64')
      .replace(/single-file \*\*`lnwjud-Portable-[0-9.]+\.exe`\*\*/g, 'single-file **`lnwjud-Portable-' + version + '.exe`**')
      .replace(/validated local test installer `lnwjud-Setup-[0-9.]+\.exe`/g, 'validated local test installer `lnwjud-Setup-' + version + '.exe`')
      .replace(/apps\/desktop\/dist\/installers\/lnwjud-Setup-[0-9.]+\.exe/g, 'apps/desktop/dist/installers/lnwjud-Setup-' + version + '.exe')
      .replace(/apps\/desktop\/dist\/installers\/lnwjud-Portable-[0-9.]+\.exe/g, 'apps/desktop/dist/installers/lnwjud-Portable-' + version + '.exe')
      .replace(/current v[0-9.]+ `ToolRegistry`/g, 'current v' + version + ' `ToolRegistry`')
      .replace(/## v[0-9.]+ release status/g, `## v${version} release status`)
      .replace(/Release `v[0-9.]+`/g, `Release \`v${version}\``);
    await writeFile(readmePath, readmeContent, 'utf8');
    console.log(`Updated README.md -> v${version}`);
  } catch {
    // skip if missing
  }

  // 9. Update current-version Markdown references without rewriting release history.
  const markdownTargets = [
    ['.github/RELEASE_CHECKLIST.md', (content) => content
      .replace(/\*\*Current (?:version|release candidate):\*\* `v[0-9.]+`/g, `**Current version:** ` + '`v' + version + '`')
      .replace(/(\*\*Current (?:version|release candidate):\*\*[^\r\n]*Windows installer `lnwjud-Setup-)[0-9.]+(\.exe`)/g, (_match, prefix, suffix) => prefix + version + suffix)
      .replace(/(portable executable `lnwjud-Portable-)[0-9.]+(\.exe`)/g, (_match, prefix, suffix) => prefix + version + suffix)],
    ['docs/USAGE_TH.md', (content) => content
      .replace(/lnwjud v[0-9.]+/g, `lnwjud v${version}`)
      .replace(/lnwjud-Setup-[0-9.]+\.exe/g, `lnwjud-Setup-${version}.exe`)
      .replace(/lnwjud-Portable-[0-9.]+\.exe/g, `lnwjud-Portable-${version}.exe`)],
    ['docs/development/PACKAGING_WINDOWS.md', (content) => content
      .replace(/For v[0-9.]+:/g, `For v${version}:`)
      .replace(/current v[0-9.]+ packaging contract/g, `current v${version} packaging contract`)
      .replace(/lnwjud-Setup-[0-9.]+\.exe/g, `lnwjud-Setup-${version}.exe`)
      .replace(/lnwjud-Portable-[0-9.]+\.exe/g, `lnwjud-Portable-${version}.exe`)],
    ['docs/LNWJUD_CAPABILITIES.md', (content) => content.replace(/lnwjud v[0-9.]+/g, `lnwjud v${version}`)],
  ];
  for (const [relativePath, update] of markdownTargets) {
    const targetPath = path.join(rootDir, relativePath);
    try {
      const content = await readFile(targetPath, 'utf8');
      await writeFile(targetPath, update(content), 'utf8');
      console.log(`Updated ${relativePath} -> v${version}`);
    } catch {
      // optional/local documentation may be absent in a public checkout
    }
  }

  console.log(`\nAll versions successfully synchronized to ${name} v${version}!`);
}

void syncAllVersions();
