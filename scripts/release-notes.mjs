import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

const FULL_CHANGELOG_PATTERN = /^\*\*Full Changelog(?::)?\*\*:?\s*(\S+)\s*$/i;
const BULLET_PATTERN = /^\s*[-*]\s+(.+?)\s*$/;
const HEADING_PATTERN = /^#{2,6}\s+(.+?)\s*$/;

const featureHeadingHints = [
  'feature',
  'features',
  'highlight',
  'highlights',
  'durable goal continuation',
  'multi-workspace and desktop ux',
  'secure mcp tunnel',
];
const fixHeadingHints = ['bug fix', 'bug fixes', 'reliability hardening', 'release reliability'];
const otherHeadingHints = [
  'other changes',
  'release assets',
  'windows release assets',
  'windows 10 / 11 and packaging',
  'new contributors',
];

function parseArgs(argv) {
  const options = {
    apply: false,
    backfill: false,
    output: undefined,
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME,
    commit: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--backfill') options.backfill = true;
    else if (argument === '--repository' || argument === '--repo') options.repository = argv[++index];
    else if (argument === '--tag') options.tag = argv[++index];
    else if (argument === '--previous-tag') options.previousTag = argv[++index];
    else if (argument === '--commit') options.commit = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function runGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (${result.status}): ${result.stderr?.trim() || 'unknown error'}`);
  }
  return result.stdout;
}

function runGhJson(args) {
  const text = runGh(args).trim();
  return text ? JSON.parse(text) : null;
}

function localCommitEntries(repository, tag, previousTag) {
  if (!previousTag) return ['Initial public release.'];
  const result = spawnSync('git', ['log', '--no-merges', '--format=%H%x00%s', `${previousTag}..${tag}`], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return commitLinesToEntries(repository, result.stdout.split(/\r?\n/));
}

function taggedReadmeHighlights(repository, tag) {
  const result = spawnSync('git', ['show', `${tag}:README.md`], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0 ? extractCuratedHighlights(result.stdout, tag, repository) : [];
}

function stripHeadingDecoration(value) {
  return value
    .replace(/(?:🚀|🐛|🐞|🪲|🧹|📝|🔧|⚙️?)/gu, '')
    .trim()
    .toLowerCase();
}

function classifyHeading(heading) {
  const normalized = stripHeadingDecoration(heading);
  if (normalized === "what's changed" || normalized === 'whats changed') return 'auto';
  if (featureHeadingHints.some((hint) => normalized === hint || normalized.includes(hint))) return 'features';
  if (fixHeadingHints.some((hint) => normalized === hint || normalized.includes(hint))) return 'fixes';
  if (otherHeadingHints.some((hint) => normalized === hint || normalized.includes(hint))) return 'other';
  return 'auto';
}

export function classifyReleaseEntry(entry) {
  const text = entry
    .replace(/^\s*[`*_]+/, '')
    .replace(/[`*_]+\s*$/, '')
    .trim();

  if (/^(?:feat|feature)(?:\([^)]*\))?!?:/i.test(text)) return 'features';
  if (/^(?:fix|bugfix|hotfix)(?:\([^)]*\))?!?:/i.test(text)) return 'fixes';
  if (/^fix\b/i.test(text) || /\b(?:bugfix|hotfix|fixes|fixed)\b/i.test(text)) return 'fixes';
  return 'other';
}

function dedupeEntries(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const normalized = entry.trim();
    if (!normalized || /^none\.?$/i.test(normalized)) continue;
    const key = normalized
      .replace(/\s+by\s+@[\w-]+\s+in\s+https:\/\/github\.com\/\S+$/i, '')
      .replace(/\s+\(\[`[0-9a-f]+`\]\(https:\/\/github\.com\/\S+\/commit\/[0-9a-f]+\)\)$/i, '')
      .toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function extractReleaseEntries(body = '') {
  const categories = { features: [], fixes: [], other: [] };
  let section = 'auto';
  let sawHeading = false;
  let paragraph = [];

  const flushParagraph = () => {
    const text = paragraph.join(' ').trim();
    paragraph = [];
    if (!text || FULL_CHANGELOG_PATTERN.test(text)) return;
    categories.other.push(text);
  };

  for (const rawLine of body.replaceAll('\r\n', '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    if (FULL_CHANGELOG_PATTERN.test(line)) {
      flushParagraph();
      continue;
    }

    const heading = line.match(HEADING_PATTERN);
    if (heading) {
      flushParagraph();
      section = classifyHeading(heading[1] ?? '');
      sawHeading = true;
      continue;
    }

    const bullet = line.match(BULLET_PATTERN);
    if (bullet) {
      flushParagraph();
      const entry = bullet[1]?.trim();
      if (!entry || /^none\.?$/i.test(entry) || FULL_CHANGELOG_PATTERN.test(entry)) continue;
      const target = section === 'auto' ? classifyReleaseEntry(entry) : section;
      categories[target].push(entry);
      continue;
    }

    if (sawHeading) {
      const target = section === 'auto' ? classifyReleaseEntry(line) : section;
      if (!/^none\.?$/i.test(line)) categories[target].push(line);
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();

  return {
    features: dedupeEntries(categories.features),
    fixes: dedupeEntries(categories.fixes),
    other: dedupeEntries(categories.other),
  };
}

export function extractFullChangelog(body = '') {
  for (const rawLine of body.replaceAll('\r\n', '\n').split('\n')) {
    const match = rawLine.trim().match(FULL_CHANGELOG_PATTERN);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function mergeCategories(primary, fallback) {
  return {
    features: dedupeEntries([...primary.features, ...fallback.features]),
    fixes: dedupeEntries([...primary.fixes, ...fallback.fixes]),
    other: dedupeEntries([...primary.other, ...fallback.other]),
  };
}

export function extractPreviousTag(body, tag) {
  const url = extractFullChangelog(body);
  const match = url?.match(/\/compare\/([^/]+)\.\.\.([^/?#]+)/);
  return match?.[2] === tag ? match[1] : undefined;
}

function buildFullChangelogUrl(repository, previousTag, tag) {
  if (!repository || !tag) return undefined;
  if (previousTag) return `https://github.com/${repository}/compare/${previousTag}...${tag}`;
  return `https://github.com/${repository}/commits/${tag}`;
}

function renderCategory(title, entries) {
  return [`## ${title}`, '', ...entries.map((entry) => `- ${entry}`)].join('\n');
}

export function extractCuratedHighlights(markdown, tag, repository) {
  const version = tag.replace(/^v/, '');
  const heading = new RegExp(`^###\\s+(?:(?:Historical:\\s*)?What's new|Current source changes) in v${version.replaceAll('.', '\\.')}\\s*(?:\\(development preview; not yet published\\))?\\s*$`, 'i');
  const entries = [];
  let inSection = false;
  let continuingBullet = false;
  for (const rawLine of markdown.replaceAll('\r\n', '\n').split('\n')) {
    const line = rawLine.trim();
    if (/^#{2,3}\s+/.test(line)) {
      if (inSection) break;
      inSection = heading.test(line);
      continuingBullet = false;
      continue;
    }
    if (!inSection) continue;
    if (rawLine.startsWith('- ')) {
      entries.push(line.slice(2));
      continuingBullet = true;
    } else if (continuingBullet && /^\s{2,}\S/.test(rawLine) && !line.startsWith('- ')) {
      entries[entries.length - 1] += ` ${line}`;
    } else if (!line) {
      continuingBullet = false;
    }
  }
  return dedupeEntries(entries.map((entry) => entry.replace(/\]\((?!https?:\/\/|#)([^)]+)\)/g, (_, path) =>
    `](https://github.com/${repository}/blob/${tag}/${path})`)));
}

export function renderReleaseNotes({ categories, highlights = [], fullChangelogUrl }) {
  const sections = [
    highlights.length > 0 && renderCategory('Highlights', highlights),
    categories.features.length > 0 && renderCategory('Features', categories.features),
    categories.fixes.length > 0 && renderCategory('Bug Fixes', categories.fixes),
    categories.other.length > 0 && renderCategory('Other Changes', categories.other),
  ].filter(Boolean);
  if (sections.length === 0) throw new Error('Release notes contain no changes to publish.');
  if (fullChangelogUrl) sections.push(`**Full Changelog**: ${fullChangelogUrl}`);
  return `${sections.join('\n\n')}\n`;
}

export function normalizeReleaseNotesBody({
  sourceBody = '',
  fallbackBody = '',
  repository,
  tag,
  previousTag,
  additionalOtherEntries = [],
  additionalEntries = [],
  highlightEntries = [],
}) {
  const sourceCategories = extractReleaseEntries(sourceBody);
  const fallbackCategories = extractReleaseEntries(fallbackBody);
  const categories = mergeCategories(sourceCategories, fallbackCategories);
  for (const entry of additionalEntries) categories[classifyReleaseEntry(entry)].push(entry);
  categories.features = dedupeEntries(categories.features);
  categories.fixes = dedupeEntries(categories.fixes);
  categories.other = dedupeEntries([...additionalOtherEntries, ...categories.other]);

  const changes = [...categories.features, ...categories.fixes, ...categories.other];
  if (highlightEntries.length === 0 && !changes.some((entry) => !isReleaseAdministrativeEntry(entry))) {
    throw new Error(`Release ${tag ?? ''} has no substantive change notes.`);
  }

  const fullChangelogUrl =
    extractFullChangelog(sourceBody) ??
    extractFullChangelog(fallbackBody) ??
    buildFullChangelogUrl(repository, previousTag, tag);

  return renderReleaseNotes({ categories, highlights: dedupeEntries(highlightEntries), fullChangelogUrl });
}

function generatedNotes(repository, tag, previousTag) {
  const args = ['api', '--method', 'POST', `repos/${repository}/releases/generate-notes`, '-f', `tag_name=${tag}`];
  if (previousTag) args.push('-f', `previous_tag_name=${previousTag}`);
  const response = runGhJson(args);
  return typeof response?.body === 'string' ? response.body : '';
}

function compareCommitEntries(repository, tag, previousTag, commit) {
  const comparisonTarget = commit || tag;
  const local = localCommitEntries(repository, comparisonTarget, previousTag);
  if (local !== null) return local;
  if (!previousTag) return ['Initial public release.'];
  const comparison = runGhJson(['api', `repos/${repository}/compare/${previousTag}...${comparisonTarget}`]);
  const commits = Array.isArray(comparison?.commits) ? comparison.commits : [];
  return commitLinesToEntries(repository, commits.map((commit) => {
    const message = commit?.commit?.message?.split(/\r?\n/, 1)?.[0]?.trim();
    return commit?.sha && message ? `${commit.sha}\0${message}` : '';
  }));
}

function commitLinesToEntries(repository, lines) {
  const entries = [];
  for (const line of lines) {
    const [sha, message] = line.split('\0');
    if (!sha || !message || /^Merge\b/i.test(message) || isReleaseAdministrativeEntry(message)) continue;
    entries.push(`${message} ([\`${sha.slice(0, 7)}\`](https://github.com/${repository}/commit/${sha}))`);
  }
  return dedupeEntries(entries);
}

function isReleaseAdministrativeEntry(entry) {
  if (/^(?:Published from the exact successful CI commit|Release artifacts include|The release contains target-native|chore\(release\):\s*(?:bump|release)\b)/i.test(entry)) return true;
  const title = entry
    .replace(/\s+by\s+@[\w-]+\s+in\s+https:\/\/github\.com\/\S+$/i, '')
    .replace(/\s+\(\[`[0-9a-f]+`\]\(https:\/\/github\.com\/\S+\/commit\/[0-9a-f]+\)\)$/i, '')
    .trim();
  return /^release(?::|\s)\s*(?:lnwjud\s+)?v\d+\.\d+\.\d+$/i.test(title);
}

function listPublishedReleases(repository) {
  const releases = runGhJson(['api', `repos/${repository}/releases?per_page=100`]);
  if (!Array.isArray(releases)) throw new Error('GitHub releases API returned an unexpected response.');
  return releases
    .filter((release) => release && !release.draft && typeof release.tag_name === 'string')
    .sort((left, right) => new Date(right.published_at ?? right.created_at ?? 0) - new Date(left.published_at ?? left.created_at ?? 0));
}

function latestPublishedTag(repository, currentTag) {
  const releases = listPublishedReleases(repository);
  return releases.find((release) => release.tag_name !== currentTag)?.tag_name;
}

export function futureReleaseMetadata(commit, tag, releaseScope) {
  if (!commit) return [];
  const currentScope = releaseScope?.version === tag?.replace(/^v/, '') ? releaseScope : null;
  const platforms = currentScope?.targets?.map((target) => {
    const labels = { 'win32-x64': 'Windows x64', 'darwin-arm64': 'macOS arm64', 'darwin-x64': 'macOS x64', 'linux-x64': 'Linux x64', 'linux-arm64': 'Linux arm64' };
    if (!Object.hasOwn(labels, target)) throw new Error(`Unknown release target ${target}`);
    return labels[target];
  });
  const artifactSummary = platforms
    ? `Release artifacts include target-native ${platforms.join(', ')} packages with \`RELEASE_MANIFEST.json\`, per-target provenance and aggregate SHA-256 evidence. ${currentScope.automaticUpdaterEnabled === false ? 'Automatic installation is disabled; packages require manual installation. ' : ''}${currentScope.deferredTargets?.length ? `Targets held from this release: ${currentScope.deferredTargets.join(', ')}. ` : ''}No package or build step runs in the tag workflow.`
    : 'Release artifacts include target-native Windows, macOS (arm64/x64), and Linux (x64/arm64) packages with `RELEASE_MANIFEST.json`, per-target provenance, and aggregate SHA-256 evidence. No package or build step runs in the tag workflow.';
  return [`Published from the exact successful CI commit \`${commit}\`.`, artifactSummary];
}

async function generateOne(options) {
  if (!options.repository) throw new Error('Missing repository. Pass --repository owner/repo or set GITHUB_REPOSITORY.');
  if (!options.tag) throw new Error('Missing tag. Pass --tag vX.Y.Z or set GITHUB_REF_NAME.');

  const previousTag = options.previousTag ?? latestPublishedTag(options.repository, options.tag);
  const releaseHistory = await readFile(new URL('../RELEASE_NOTES.md', import.meta.url), 'utf8');
  const highlightEntries = extractCuratedHighlights(releaseHistory, options.tag, options.repository);
  if (highlightEntries.length === 0) {
    throw new Error(`RELEASE_NOTES.md needs a "What's new in ${options.tag}" section with real bullet points before release publication.`);
  }
  let sourceBody = '';
  try {
    sourceBody = generatedNotes(options.repository, options.tag, previousTag);
  } catch (error) {
    console.warn(`GitHub generated notes unavailable for ${options.tag}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const releaseScope = JSON.parse(await readFile(new URL('../config/release-scope.json', import.meta.url), 'utf8'));
  const body = normalizeReleaseNotesBody({
    sourceBody,
    repository: options.repository,
    tag: options.tag,
    previousTag,
    additionalOtherEntries: futureReleaseMetadata(options.commit, options.tag, releaseScope),
    additionalEntries: compareCommitEntries(options.repository, options.tag, previousTag, options.commit),
    highlightEntries,
  });

  if (options.output) {
    await writeFile(options.output, body, 'utf8');
    console.log(`Wrote standardized release notes for ${options.tag} to ${options.output}`);
  } else {
    process.stdout.write(body);
  }
}

async function backfill(options) {
  if (!options.repository) throw new Error('Missing repository. Pass --repository owner/repo or set GITHUB_REPOSITORY.');
  const releases = listPublishedReleases(options.repository);
  const releaseHistory = await readFile(new URL('../RELEASE_NOTES.md', import.meta.url), 'utf8');
  const historicalHighlights = await readFile(new URL('../docs/development/HISTORICAL_RELEASE_HIGHLIGHTS.md', import.meta.url), 'utf8');
  let changed = 0;
  const preview = [];

  for (let index = 0; index < releases.length; index += 1) {
    const release = releases[index];
    const tag = release.tag_name;
    const sourceBody = typeof release.body === 'string' ? release.body : '';
    const previousTag = extractPreviousTag(sourceBody, tag) ?? releases[index + 1]?.tag_name;
    if (!/^\s*[-*]\s+None\.?\s*$/im.test(sourceBody)) {
      console.log(`unchanged ${tag}`);
      continue;
    }
    let highlightEntries = extractCuratedHighlights(releaseHistory, tag, options.repository);
    if (highlightEntries.length === 0) highlightEntries = taggedReadmeHighlights(options.repository, tag);
    if (highlightEntries.length === 0) {
      highlightEntries = extractCuratedHighlights(historicalHighlights, tag, options.repository);
    }
    const normalized = normalizeReleaseNotesBody({
      sourceBody,
      repository: options.repository,
      tag,
      previousTag,
      additionalEntries: compareCommitEntries(options.repository, tag, previousTag),
      highlightEntries,
    });

    if (normalized.trim() === sourceBody.trim()) {
      console.log(`unchanged ${tag}`);
      continue;
    }

    changed += 1;
    preview.push({ tag, before: sourceBody, after: normalized });
    if (!options.apply) {
      console.log(`would update ${tag}`);
      continue;
    }

    runGh(['release', 'edit', tag, '--repo', options.repository, '--notes', normalized]);
    console.log(`updated ${tag}`);
  }

  if (options.output) {
    await writeFile(options.output, JSON.stringify(preview, null, 2), 'utf8');
    console.log(`Wrote release-note review data to ${options.output}`);
  }
  console.log(`${options.apply ? 'Updated' : 'Would update'} ${changed} of ${releases.length} published releases.`);
}

function printHelp() {
  console.log(`Usage:
  node scripts/release-notes.mjs --tag vX.Y.Z --repository owner/repo [--commit SHA] [--output release-notes.md]
  node scripts/release-notes.mjs --backfill --repository owner/repo [--output review.json] [--apply]

The generated body contains only nonempty headings in this order:
  ## Features
  ## Bug Fixes
  ## Other Changes

Backfill mode is dry-run unless --apply is supplied.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.backfill) await backfill(options);
  else await generateOne(options);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
