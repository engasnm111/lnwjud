import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(repositoryRoot, 'docs', 'architecture', 'TOOL_CONTRACT.md');
const readmePath = path.join(repositoryRoot, 'README.md');
const registryModulePath = path.join(repositoryRoot, 'packages', 'mcp-server', 'dist', 'tool-registry.js');
const contractStartMarker = '<!-- BEGIN GENERATED TOOL REGISTRY -->';
const contractEndMarker = '<!-- END GENERATED TOOL REGISTRY -->';
const readmeStartMarker = '<!-- BEGIN GENERATED README TOOL REGISTRY -->';
const readmeEndMarker = '<!-- END GENERATED README TOOL REGISTRY -->';
const checkOnly = process.argv.includes('--check');

const { ToolRegistry } = await import(pathToFileURL(registryModulePath).href);
const registry = new ToolRegistry({}, { clientId: 'catalog-generator', clientName: 'catalog-generator' }, { codexToolsEnabled: true });
const tools = registry.list();
const defaultToolCount = new ToolRegistry({}, { clientId: 'catalog-generator', clientName: 'catalog-generator' }).list().length;
const current = await readFile(contractPath, 'utf8');
const currentReadme = await readFile(readmePath, 'utf8');
const newline = current.includes('\r\n') ? '\r\n' : '\n';
const readmeNewline = currentReadme.includes('\r\n') ? '\r\n' : '\n';
const rows = tools.map((tool, index) => {
  const readOnly = tool.annotations.readOnlyHint === true ? 'yes' : 'no';
  const destructive = tool.annotations.destructiveHint === true ? 'yes' : 'no';
  return `| ${index + 1} | \`${tool.name}\` | ${tool.permission} | ${readOnly} | ${destructive} |`;
});
const block = [
  contractStartMarker,
  '## Generated live ToolRegistry index',
  '',
  `This block is generated from the built \`ToolRegistry\`. Current count: **${tools.length} tools**.`,
  'Run `pnpm docs:tools` after intentionally changing the registry; CI runs `pnpm docs:tools:check` and fails on drift.',
  '',
  '| # | Tool | Permission | Read-only | Destructive |',
  '| ---: | --- | --- | :---: | :---: |',
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
  return `| ${index + 1} | \`${tool.name}\` | ${tool.permission} | ${description} |`;
});
const readmeBlock = [
  readmeStartMarker,
  `## Complete MCP tool catalog (${tools.length} configurable tools; ${defaultToolCount} advertised by default)`,
  '',
  'This index is generated from the current `ToolRegistry`, not copied from an older release document. Optional/planned tools still appear in the advertised contract and report their availability/requirements at runtime where applicable.',
  '',
  '| # | Tool | Permission | Runtime description |',
  '| ---: | --- | --- | --- |',
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

const normalizeLineEndings = (value) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

if (checkOnly) {
  if (normalizeLineEndings(current) !== normalizeLineEndings(expected)
    || normalizeLineEndings(currentReadme) !== normalizeLineEndings(expectedReadme)) {
    process.stderr.write(`Tool catalog drift detected: configurable=${tools.length}, default=${defaultToolCount}. Run: corepack pnpm@10.15.0 docs:tools\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Tool catalogs are synchronized: configurable=${tools.length}, default=${defaultToolCount}.\n`);
  }
} else {
  await writeFile(contractPath, expected, 'utf8');
  await writeFile(readmePath, expectedReadme, 'utf8');
  process.stdout.write(`Generated ToolRegistry catalogs: configurable=${tools.length}, default=${defaultToolCount}.\n`);
}
