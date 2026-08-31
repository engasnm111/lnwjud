import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(repositoryRoot, 'docs', 'architecture', 'TOOL_CONTRACT.md');
const readmePath = path.join(repositoryRoot, 'README.md');
const registryModulePath = path.join(repositoryRoot, 'packages', 'mcp-server', 'dist', 'tool-registry.js');
const upgradeCatalogModulePath = path.join(repositoryRoot, 'packages', 'mcp-server', 'dist', 'upgrade-catalog.js');
const runtimeFixturesModulePath = path.join(repositoryRoot, 'packages', 'mcp-server', 'dist', 'tool-runtime-fixtures.js');
const contractStartMarker = '<!-- BEGIN GENERATED TOOL REGISTRY -->';
const contractEndMarker = '<!-- END GENERATED TOOL REGISTRY -->';
const readmeStartMarker = '<!-- BEGIN GENERATED README TOOL REGISTRY -->';
const readmeEndMarker = '<!-- END GENERATED README TOOL REGISTRY -->';
const checkOnly = process.argv.includes('--check');

const { ToolRegistry } = await import(pathToFileURL(registryModulePath).href);
const { upgradeCatalogEntry } = await import(pathToFileURL(upgradeCatalogModulePath).href);
const { TOOL_RUNTIME_FIXTURES } = await import(pathToFileURL(runtimeFixturesModulePath).href);
const actor = { clientId: 'catalog-generator', clientName: 'catalog-generator' };
const codexEnabledRegistry = new ToolRegistry({}, actor, { codexToolsEnabled: true });
const tools = codexEnabledRegistry.listAll();
const defaultAdvertisedTools = new ToolRegistry({}, actor).list();
const codexAdvertisedTools = codexEnabledRegistry.list();
const defaultAdvertisedNames = new Set(defaultAdvertisedTools.map((tool) => tool.name));
const codexAdvertisedNames = new Set(codexAdvertisedTools.map((tool) => tool.name));
const defaultAdvertisedCount = defaultAdvertisedTools.length;
const codexEnabledAdvertisedCount = codexAdvertisedTools.length;
const advertisedLabel = (name) => defaultAdvertisedNames.has(name) ? 'default' : codexAdvertisedNames.has(name) ? 'Codex opt-in' : 'no';
const deliveryLabel = (name) => upgradeCatalogEntry(name)?.deliveryState ?? 'operational';
const evidenceLabel = (name) => TOOL_RUNTIME_FIXTURES[name]?.evidence?.kind ?? 'missing';
const current = await readFile(contractPath, 'utf8');
const currentReadme = await readFile(readmePath, 'utf8');
const newline = current.includes('\r\n') ? '\r\n' : '\n';
const readmeNewline = currentReadme.includes('\r\n') ? '\r\n' : '\n';
const rows = tools.map((tool, index) => {
  const readOnly = tool.annotations.readOnlyHint === true ? 'yes' : 'no';
  const destructive = tool.annotations.destructiveHint === true ? 'yes' : 'no';
  return `| ${index + 1} | \`${tool.name}\` | ${tool.permission} | ${advertisedLabel(tool.name)} | ${deliveryLabel(tool.name)} | ${evidenceLabel(tool.name)} | ${readOnly} | ${destructive} |`;
});
const block = [
  contractStartMarker,
  '## Generated live ToolRegistry index',
  '',
  `This complete inventory is generated from \`ToolRegistry.listAll()\`: **${tools.length} total tool definitions**. The runtime advertises **${defaultAdvertisedCount} tools by default** and **${codexEnabledAdvertisedCount} tools when Codex delegation is enabled** through \`tools/list\`.`,
  'Run `pnpm docs:tools` after intentionally changing the registry; CI runs `pnpm docs:tools:check` and fails on drift.',
  '',
  '| # | Tool | Permission | Advertised | Delivery | Runtime evidence | Read-only | Destructive |',
  '| ---: | --- | --- | --- | --- | --- | :---: | :---: |',
  ...rows,
  contractEndMarker,
].join(newline);
const start = current.indexOf(contractStartMarker);
const end = current.indexOf(contractEndMarker);
let expected;
if (start >= 0 && end >= start) {
  expected = current.slice(0, start) + block + current.slice(end + contractEndMarker.length);
} else {
  const insertionPoint = current.indexOf('## Protocol and result rules');
  if (insertionPoint < 0) throw new Error('Tool contract insertion point was not found');
  expected = current.slice(0, insertionPoint) + block + newline + newline + current.slice(insertionPoint);
}

const readmeRows = tools.map((tool, index) => {
  const description = tool.description.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return `| ${index + 1} | \`${tool.name}\` | ${tool.permission} | ${advertisedLabel(tool.name)} | ${deliveryLabel(tool.name)} | ${evidenceLabel(tool.name)} | ${description} |`;
});
const readmeBlock = [
  readmeStartMarker,
  `## Complete MCP tool catalog (${tools.length} total definitions; ${defaultAdvertisedCount} advertised by default; ${codexEnabledAdvertisedCount} with Codex enabled)`,
  '',
  'This complete index is generated from `ToolRegistry.listAll()`, not copied from an older release document. The default `tools/list` surface advertises only operational or dependency-gated definitions; planned and feature-disabled definitions remain visible here without being advertised. Enabling Codex delegation adds its six operational definitions to the advertised surface.',
  '',
  '| # | Tool | Permission | Advertised | Delivery | Runtime evidence | Runtime description |',
  '| ---: | --- | --- | --- | --- | --- | --- |',
  ...readmeRows,
  readmeEndMarker,
].join(readmeNewline);
const readmeStart = currentReadme.indexOf(readmeStartMarker);
const readmeEnd = currentReadme.indexOf(readmeEndMarker);
let expectedReadme;
if (readmeStart >= 0 && readmeEnd >= readmeStart) {
  expectedReadme = currentReadme.slice(0, readmeStart) + readmeBlock + currentReadme.slice(readmeEnd + readmeEndMarker.length);
} else {
  const catalogStart = currentReadme.indexOf('## Complete MCP tool catalog');
  const catalogEnd = currentReadme.indexOf('## Detailed capability guide', catalogStart);
  if (catalogStart < 0 || catalogEnd < 0) throw new Error('README tool catalog boundaries were not found');
  expectedReadme = currentReadme.slice(0, catalogStart) + readmeBlock + readmeNewline + readmeNewline + currentReadme.slice(catalogEnd);
}

const quickStartCountPattern = /5\. Confirm that the default runtime exposes \*\*\d+ tools\*\* \(or \*\*\d+\*\* when Codex delegation is explicitly enabled\) and run a read-only\s+smoke test before trying writes\./;
const quickStartCountText = `5. Confirm that the default runtime exposes **${defaultAdvertisedCount} tools** (or **${codexEnabledAdvertisedCount}** when Codex delegation is explicitly enabled) and run a read-only${readmeNewline}   smoke test before trying writes.`;
if (!quickStartCountPattern.test(expectedReadme)) throw new Error('README quick-start advertised-tool count sentence was not found');
expectedReadme = expectedReadme.replace(quickStartCountPattern, quickStartCountText);

const missingEvidence = tools.filter((tool) => evidenceLabel(tool.name) === 'missing').map((tool) => tool.name);
if (missingEvidence.length > 0) throw new Error(`Runtime evidence is missing for: ${missingEvidence.join(', ')}`);

const normalizeLineEndings = (value) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

if (checkOnly) {
  if (normalizeLineEndings(current) !== normalizeLineEndings(expected)
    || normalizeLineEndings(currentReadme) !== normalizeLineEndings(expectedReadme)) {
    process.stderr.write(`Tool catalog drift detected: total=${tools.length}, defaultAdvertised=${defaultAdvertisedCount}, codexAdvertised=${codexEnabledAdvertisedCount}. Run: corepack pnpm@10.15.0 docs:tools\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Tool catalogs are synchronized: total=${tools.length}, defaultAdvertised=${defaultAdvertisedCount}, codexAdvertised=${codexEnabledAdvertisedCount}.\n`);
  }
} else {
  await writeFile(contractPath, expected, 'utf8');
  await writeFile(readmePath, expectedReadme, 'utf8');
  process.stdout.write(`Generated ToolRegistry catalogs: total=${tools.length}, defaultAdvertised=${defaultAdvertisedCount}, codexAdvertised=${codexEnabledAdvertisedCount}.\n`);
}
