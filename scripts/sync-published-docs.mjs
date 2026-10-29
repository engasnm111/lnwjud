import console from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const versionArg = args.find((argument) => /^v?\d+\.\d+\.\d+$/.test(argument));
if (!versionArg || args.some((argument) => argument !== '--apply' && argument !== versionArg)) {
  console.error('Usage: node scripts/sync-published-docs.mjs vX.Y.Z [--apply]');
  process.exit(2);
}
const version = versionArg.replace(/^v/, '');
const tag = `v${version}`;
const repoUrl = 'https://github.com/engasnm111/lnwjud';
const packages = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (packages.version !== version) {
  throw new Error(`Package version ${packages.version} differs from published release ${tag}`);
}

const releaseScope = JSON.parse(await readFile(path.join(root, 'config/release-scope.json'), 'utf8'));
if (releaseScope.version !== version || !Array.isArray(releaseScope.targets)) throw new Error(`Invalid published release scope for ${tag}`);
const macIncluded = releaseScope.targets.includes('darwin-arm64') && releaseScope.targets.includes('darwin-x64');
const filenamePattern = /lnwjud-(Setup-|Portable-)?\d+\.\d+\.\d+((?:-arm64|-x64)?\.(?:exe|dmg|deb|AppImage))/g;
const assetFiles = [
  `lnwjud-Setup-${version}.exe`,
  `lnwjud-Portable-${version}.exe`,
  ...(macIncluded ? [`lnwjud-${version}-arm64.dmg`, `lnwjud-${version}-x64.dmg`] : []),
  `lnwjud-${version}-x64.deb`,
  `lnwjud-${version}-x64.AppImage`,
];
function updateFileNames(contents) {
  return contents.replace(filenamePattern, (full, prefix = '', suffix) => !macIncluded && suffix.endsWith('.dmg')
    ? full : `lnwjud-${prefix}${version}${suffix}`);
}
function pinHeldMacDownloads(contents) {
  if (macIncluded) return contents;
  return contents.replace(
    /https:\/\/github\.com\/engasnm111\/lnwjud\/releases\/latest\/download\/(lnwjud-(\d+\.\d+\.\d+)-(?:arm64|x64)\.dmg)/g,
    (_url, filename, macVersion) => `${repoUrl}/releases/download/v${macVersion}/${filename}`,
  );
}
function replaceRequired(contents, pattern, replacement, label) {
  if (!pattern.test(contents)) throw new Error(`Missing required published-release marker: ${label}`);
  return contents.replace(pattern, replacement);
}
const tasks = [
  {
    file: 'README.md',
    transform(original) {
      const macBaseline = /lnwjud-(\d+\.\d+\.\d+)-arm64\.dmg/.exec(original)?.[1];
      if (!macIncluded && !macBaseline) throw new Error('README missing prior macOS asset version to pin');
      let result = replaceRequired(original, /^## Current published version: v\d+\.\d+\.\d+$/m, `## Current published version: ${tag}`, 'README published heading');
      result = replaceRequired(result,
        /<p align="center">(?:Choose your platform and download the current v\d+\.\d+\.\d+ release directly\.|Download Windows and Linux v\d+\.\d+\.\d+ directly; macOS remains on v\d+\.\d+\.\d+ pending containment verification\.)<\/p>/,
        `<p align="center">${macIncluded ? `Choose your platform and download the current ${tag} release directly.` : `Download Windows and Linux ${tag} directly; macOS remains on v${macBaseline} pending containment verification.`}</p>`,
        'README download copy');
      result = replaceRequired(result, /^Latest published release: \*\*v\d+\.\d+\.\d+\*\*\.[^\r\n]*$/m,
        `Latest published release: **${tag}**. ${macIncluded ? 'The download buttons above point directly to the verified release assets.' : `Windows/Linux assets are published for ${tag}; macOS downloads remain pinned to v${macBaseline} pending Issue #216.`} The release was published after the exact tagged main commit passed the target-native release gates.`,
        'README latest version');
      result = pinHeldMacDownloads(updateFileNames(result));
      for (const file of assetFiles) {
        if (!result.includes(`${repoUrl}/releases/latest/download/${file}`)) {
          throw new Error(`README download URL missing: ${file}`);
        }
      }
      return result;
    },
  },
  {
    file: 'FULL_README.md',
    transform(original) {
      let result = replaceRequired(original, /^## Current published version: v\d+\.\d+\.\d+$/m, `## Current published version: ${tag}`, 'Full README published heading');
      result = replaceRequired(result, /^Latest published release: \*\*v\d+\.\d+\.\d+\*\*\.[^\r\n]*$/m,
        `Latest published release: **${tag}**. ${macIncluded ? 'Windows, macOS, and Linux artifacts were published' : 'Windows and Linux artifacts were published; macOS v5.9.0 is withheld pending Issue #216'} after the exact tagged main commit passed the target-native release gates described below.`,
        'Full README latest version');
      result = replaceRequired(result, /Current published Windows 10\/11 x64 v\d+\.\d+\.\d+ artifacts/, `Current published Windows 10/11 x64 ${tag} artifacts`, 'Full README install chapter');
      result = replaceRequired(result, /สำหรับ v\d+\.\d+\.\d+ คือ Remote MCP/, `สำหรับ ${tag} คือ Remote MCP`, 'Full README Thai install chapter');
      result = pinHeldMacDownloads(updateFileNames(result));
      for (const file of assetFiles.slice(0, 2)) {
        if (!result.includes(file)) throw new Error(`Full README missing published artifact: ${file}`);
      }
      return result;
    },
  },
  {
    file: 'docs/USAGE_TH.md',
    transform(original) {
      let result = replaceRequired(original,
        /public release `v\d+\.\d+\.\d+` คือรุ่นที่เผยแพร่แล้วบน \[GitHub Releases\]\(https:\/\/github\.com\/engasnm111\/lnwjud\/releases\/tag\/v\d+\.\d+\.\d+\)/,
        `public release \`${tag}\` คือรุ่นที่เผยแพร่แล้วบน [GitHub Releases](${repoUrl}/releases/tag/${tag})`,
        'Thai guide published release');
      result = pinHeldMacDownloads(updateFileNames(result));
      for (const file of assetFiles.slice(0, 2)) {
        if (!result.includes(file)) throw new Error(`Thai guide missing published artifact: ${file}`);
      }
      return result;
    },
  },
];
const pending = [];
for (const { file, transform } of tasks) {
  const location = path.join(root, file);
  const original = await readFile(location, 'utf8');
  const next = transform(original);
  if (next !== original) pending.push({ file, location, next });
}
if (pending.length && !apply) {
  console.error(`Published docs stale for ${tag}: ${pending.map((item) => item.file).join(', ')}. Run with --apply after publishing the release.`);
  process.exitCode = 1;
} else {
  for (const { location, next } of pending) await writeFile(location, next, 'utf8');
  console.log(`${apply ? 'Synchronized' : 'Verified'} published documentation ${tag}: ${tasks.map((task) => task.file).join(', ')}; ${pending.length} file(s) changed.`);
}
