import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(repositoryRoot, 'docs', 'architecture', 'TOOL_CONTRACT.md');
const readmePath = path.join(repositoryRoot, 'FULL_README.md');
const conciseReadmePath = path.join(repositoryRoot, 'README.md');
const capabilityPath = path.join(repositoryRoot, 'docs', 'LNWJUD_CAPABILITIES.md');
const releaseChecklistPath = path.join(repositoryRoot, '.github', 'RELEASE_CHECKLIST.md');
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
// The real desktop/CLI runtimes wire AgentSwarmService whenever Codex delegation is
// enabled. Supply a non-invoked placeholder here so generated advertised counts model
// the production service surface instead of accidentally hiding agent_swarm_run.
const codexEnabledRegistry = new ToolRegistry({ agentSwarm: {} }, actor, { codexToolsEnabled: true });
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
const currentConciseReadme = await readFile(conciseReadmePath, 'utf8');
const currentCapabilities = await readFile(capabilityPath, 'utf8');
const currentReleaseChecklist = await readFile(releaseChecklistPath, 'utf8');
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
  `This complete inventory is generated from \`ToolRegistry.listAll()\`: **${tools.length} total tool definitions**. The runtime advertises **${defaultAdvertisedCount} tools by default** and **${codexEnabledAdvertisedCount} tools when Codex delegation plus Agent Swarm is enabled** through \`tools/list\`.`,
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
  `## Complete MCP tool catalog (${tools.length} total definitions; ${defaultAdvertisedCount} advertised by default; ${codexEnabledAdvertisedCount} with Codex delegation plus Agent Swarm enabled)`,
  '',
  `This complete index is generated from \`ToolRegistry.listAll()\`, not copied from an older release document. The default \`tools/list\` surface advertises only operational or dependency-gated definitions; planned and feature-disabled definitions remain visible here without being advertised. Enabling Codex delegation plus Agent Swarm adds ${codexEnabledAdvertisedCount - defaultAdvertisedCount} opt-in definitions to the advertised surface.`,
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

const quickStartCountPattern = /7\. Confirm the connection discovers \*\*\d+ tools by default\*\* \(or \*\*\d+\*\* when Codex delegation plus Agent Swarm is explicitly enabled\), then run a read-only smoke test before writes\./;
const quickStartCountText = `7. Confirm the connection discovers **${defaultAdvertisedCount} tools by default** (or **${codexEnabledAdvertisedCount}** when Codex delegation plus Agent Swarm is explicitly enabled), then run a read-only smoke test before writes.`;
if (!quickStartCountPattern.test(expectedReadme)) throw new Error('README quick-start advertised-tool count sentence was not found');
expectedReadme = expectedReadme.replace(quickStartCountPattern, quickStartCountText);

const missingEvidence = tools.filter((tool) => evidenceLabel(tool.name) === 'missing').map((tool) => tool.name);
if (missingEvidence.length > 0) throw new Error(`Runtime evidence is missing for: ${missingEvidence.join(', ')}`);

// Current inventories and counts are generated from the same runtime registry.
// Historical release summaries are intentionally left unchanged.
function replaceRequired(text, pattern, replacement, surface) {
  if (!pattern.test(text)) throw new Error('Missing current tool-count surface: ' + surface);
  return text.replace(pattern, replacement);
}

const capabilityListPattern = /(## รายชื่อ MCP tools ใน runtime snapshot[\s\S]*?~~~text\r?\n)([\s\S]*?)(\r?\n~~~)/;
let expectedCapabilities = replaceRequired(
  currentCapabilities,
  capabilityListPattern,
  (_match, prefix, _oldNames, suffix) => prefix + tools.map((tool) => tool.name).join('\n') + suffix,
  'Thai full ToolRegistry list',
);
const countSurfaces = [
  [/(มีทั้งหมด )\d+( definitions; advertise )\d+( tools โดยปริยายก่อนใช้ per-tool override และครบ )\d+( tools)/,
    (_m, a, b, c, d) => a + tools.length + b + defaultAdvertisedCount + c + codexEnabledAdvertisedCount + d],
  [/(full registry มี )\d+( tool definitions; ค่า default โฆษณา )\d+( tools และครบ )\d+( tools)/,
    (_m, a, b, c, d) => a + tools.length + b + defaultAdvertisedCount + c + codexEnabledAdvertisedCount + d],
  [/(runtime contract ปัจจุบันมีทั้งหมด )\d+( tool definitions; ค่า default ส่งกลับ )\d+( tools และส่งกลับครบ )\d+( tools)/,
    (_m, a, b, c, d) => a + tools.length + b + defaultAdvertisedCount + c + codexEnabledAdvertisedCount + d],
];
for (const [pattern, replacement] of countSurfaces) {
  expectedCapabilities = replaceRequired(expectedCapabilities, pattern, replacement, 'Thai capability totals');
}
let expectedReleaseChecklist = replaceRequired(
  currentReleaseChecklist,
  /(\*\*)\d+( total definitions \/ )\d+( advertised by default \/ all )\d+( with Codex delegation plus Agent Swarm enabled\*\*)/,
  (_m, a, b, c, d) => a + tools.length + b + defaultAdvertisedCount + c + codexEnabledAdvertisedCount + d,
  'Release checklist headline counts',
);
expectedReleaseChecklist = replaceRequired(
  expectedReleaseChecklist,
  /(Tool catalog synchronization passes with )\d+( total definitions, )\d+( advertised by default, and all )\d+( advertised)/,
  (_m, a, b, c) => a + tools.length + b + defaultAdvertisedCount + c + codexEnabledAdvertisedCount + ' advertised',
  'Release checklist runtime counts',
);
let expectedConciseReadme = replaceRequired(
  currentConciseReadme,
  /\d+( total tool definitions for local files,[^\r\n]*?; )\d+( are advertised by default and all )\d+( when Codex delegation plus Agent Swarm is enabled\.)/,
  (_m, a, b, c) => tools.length + a + defaultAdvertisedCount + b + codexEnabledAdvertisedCount + c,
  'README tool-count introduction',
);
expectedConciseReadme = replaceRequired(
  expectedConciseReadme,
  /(MCP-)\d+(%20tools-6f42c1)/,
  (_m, a, b) => a + tools.length + b,
  'README MCP tool-count badge',
);
expectedConciseReadme = replaceRequired(
  expectedConciseReadme,
  /(lnwjud exposes \*\*)\d+( tool definitions\*\* through one local runtime and MCP gateway\. The default advertised set is )\d+(; all )\d+( are available when Codex delegation plus Agent Swarm is enabled\.)/,
  (_m, a, b, c, d) => a + tools.length + b + defaultAdvertisedCount + c + codexEnabledAdvertisedCount + d,
  'README capability summary',
);

const normalizeLineEndings = (value) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

if (checkOnly) {
  if (normalizeLineEndings(current) !== normalizeLineEndings(expected)
    || normalizeLineEndings(currentReadme) !== normalizeLineEndings(expectedReadme)
    || normalizeLineEndings(currentConciseReadme) !== normalizeLineEndings(expectedConciseReadme)
    || normalizeLineEndings(currentCapabilities) !== normalizeLineEndings(expectedCapabilities)
    || normalizeLineEndings(currentReleaseChecklist) !== normalizeLineEndings(expectedReleaseChecklist)) {
    process.stderr.write(`Tool catalog drift detected: total=${tools.length}, defaultAdvertised=${defaultAdvertisedCount}, codexAdvertised=${codexEnabledAdvertisedCount}. Run: corepack pnpm@10.15.0 docs:tools\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Tool catalogs are synchronized: total=${tools.length}, defaultAdvertised=${defaultAdvertisedCount}, codexAdvertised=${codexEnabledAdvertisedCount}.\n`);
  }
} else {
  await writeFile(contractPath, expected, 'utf8');
  await writeFile(readmePath, expectedReadme, 'utf8');
  await writeFile(conciseReadmePath, expectedConciseReadme, 'utf8');
  await writeFile(capabilityPath, expectedCapabilities, 'utf8');
  await writeFile(releaseChecklistPath, expectedReleaseChecklist, 'utf8');
  process.stdout.write(`Generated ToolRegistry catalogs: total=${tools.length}, defaultAdvertised=${defaultAdvertisedCount}, codexAdvertised=${codexEnabledAdvertisedCount}.\n`);
}
