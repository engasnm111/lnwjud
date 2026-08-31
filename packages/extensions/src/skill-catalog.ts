import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { isSkillRootEnabled } from './allowlist.js';
import type { ExtensionsSettings, SkillContent, SkillSummary } from './types.js';

export interface SkillCatalogOptions {
  readonly homeDir?: string;
  readonly workspaceRoot?: string;
  readonly settings: ExtensionsSettings;
  readonly extraRoots?: readonly string[];
}

export class SkillCatalog {
  public constructor(private readonly options: SkillCatalogOptions) {}

  public async list(input: { readonly query?: string; readonly source?: string } = {}): Promise<Result<{ readonly skills: readonly SkillSummary[] }>> {
    const skills = await this.discover();
    const query = input.query === undefined ? undefined : normalizeSearchText(input.query);
    const source = input.source?.trim().toLowerCase();
    const filtered = skills.filter((skill) => {
      if (source !== undefined && source.length > 0 && skill.source.toLowerCase() !== source) return false;
      if (query === undefined || query.length === 0) return true;
      return normalizeSearchText(skill.name).includes(query)
        || normalizeSearchText(skill.description).includes(query)
        || normalizeSearchText(skill.id).includes(query);
    });
    return ok({ skills: filtered });
  }

  public async read(input: { readonly skillId: string; readonly relativePath?: string }): Promise<Result<SkillContent>> {
    const skills = await this.discover();
    const requestedSkillId = input.skillId.trim();
    const normalizedSkillId = requestedSkillId.startsWith('$') ? requestedSkillId.slice(1) : requestedSkillId;
    const exact = skills.find((entry) => entry.id === normalizedSkillId);
    const named = exact === undefined ? skills.filter((entry) => entry.name === normalizedSkillId) : [];
    if (named.length > 1) {
      return err(appError(
        'INVALID_INPUT',
        `Skill name is ambiguous: ${input.skillId}. Use one of: ${named.map((entry) => entry.id).join(', ')}`,
      ));
    }
    const skill = exact ?? named[0];
    if (skill === undefined) return err(appError('FILE_NOT_FOUND', `Skill not found: ${input.skillId}`));

    const relativePath = input.relativePath?.trim() || 'SKILL.md';
    if (relativePath.includes('\0') || path.isAbsolute(relativePath)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Skill relative path must stay inside the skill folder'));
    }
    const skillDir = path.dirname(skill.skillPath);
    const resolved = path.resolve(skillDir, relativePath);
    if (!isPathInside(skillDir, resolved)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Skill relative path must stay inside the skill folder'));
    }

    try {
      const content = await readFile(resolved, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
        return err(appError('FILE_TOO_LARGE', 'Skill file exceeds 2 MiB'));
      }
      const meta = parseSkillMarkdown(content, path.basename(skillDir));
      return ok({
        id: skill.id,
        name: meta.name,
        description: meta.description,
        source: skill.source,
        path: resolved,
        content,
      });
    } catch {
      return err(appError('FILE_NOT_FOUND', `Skill file not found: ${relativePath}`));
    }
  }

  private async discover(): Promise<readonly SkillSummary[]> {
    const roots = this.roots();
    const skills: SkillSummary[] = [];
    for (const root of roots) {
      if (!isSkillRootEnabled(root.path, this.options.settings)) continue;
      const skillFiles = await findSkillFiles(root.path);
      for (const skillPath of skillFiles) {
        try {
          const content = await readFile(skillPath, 'utf8');
          const fallbackName = path.basename(path.dirname(skillPath));
          const meta = parseSkillMarkdown(content, fallbackName);
          skills.push({
            id: `${root.source}/${meta.name}`,
            name: meta.name,
            description: meta.description,
            source: root.source,
            rootPath: root.path,
            skillPath,
          });
        } catch {
          continue;
        }
      }
    }
    return dedupeByPathAndDisambiguateIds(skills);
  }

  private roots(): readonly { readonly source: string; readonly path: string }[] {
    const home = this.options.homeDir ?? os.homedir();
    const configuredCodexHome = this.options.homeDir === undefined ? process.env.CODEX_HOME?.trim() : undefined;
    const codexHome = configuredCodexHome === undefined || configuredCodexHome.length === 0
      ? path.join(home, '.codex')
      : path.resolve(configuredCodexHome);
    const defaults: { readonly source: string; readonly path: string }[] = [
      { source: 'cursor-skills-cursor', path: path.join(home, '.cursor', 'skills-cursor') },
      { source: 'cursor-skills', path: path.join(home, '.cursor', 'skills') },
      { source: 'claude-skills', path: path.join(home, '.claude', 'skills') },
      { source: 'agents-skills', path: path.join(home, '.agents', 'skills') },
      { source: 'codex-skills', path: path.join(codexHome, 'skills') },
      { source: 'codex-plugin-skills', path: path.join(codexHome, 'plugins', 'cache') },
    ];
    const workspaceRoot = this.options.workspaceRoot?.trim();
    if (workspaceRoot !== undefined && workspaceRoot.length > 0) {
      defaults.push(
        { source: 'workspace-cursor-skills', path: path.join(workspaceRoot, '.cursor', 'skills') },
        { source: 'workspace-cursor-skills-cursor', path: path.join(workspaceRoot, '.cursor', 'skills-cursor') },
        { source: 'workspace-claude-skills', path: path.join(workspaceRoot, '.claude', 'skills') },
        { source: 'workspace-agents-skills', path: path.join(workspaceRoot, '.agents', 'skills') },
        { source: 'workspace-codex-skills', path: path.join(workspaceRoot, '.codex', 'skills') },
        { source: 'workspace-github-skills', path: path.join(workspaceRoot, '.github', 'skills') },
      );
    }
    for (const extra of [...this.options.settings.extraSkillRoots, ...(this.options.extraRoots ?? [])]) {
      defaults.push({ source: `extra:${path.basename(extra)}`, path: path.resolve(extra) });
    }
    return defaults;
  }
}

export function parseSkillMarkdown(content: string, fallbackName: string): { readonly name: string; readonly description: string } {
  const frontmatter = extractFrontmatter(content);
  const name = frontmatter.name?.trim() || fallbackName;
  const description = frontmatter.description?.trim()
    || firstParagraph(frontmatter.body)
    || `Skill ${name}`;
  return { name, description };
}

function extractFrontmatter(content: string): { readonly name?: string; readonly description?: string; readonly body: string } {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { body: content };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (match === null) return { body: content };
  const yaml = match[1] ?? '';
  const body = match[2] ?? '';
  return {
    ...parseSimpleYaml(yaml),
    body,
  };
}

function parseSimpleYaml(yaml: string): { readonly name?: string; readonly description?: string } {
  const lines = yaml.split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;
  let collectingDescription = false;
  const descriptionLines: string[] = [];

  for (const line of lines) {
    if (collectingDescription) {
      if (/^[A-Za-z0-9_-]+\s*:/.test(line) && !line.startsWith(' ') && !line.startsWith('\t')) {
        collectingDescription = false;
      } else {
        descriptionLines.push(line.replace(/^\s+/, ''));
        continue;
      }
    }
    const nameMatch = /^name\s*:\s*(.+)\s*$/.exec(line);
    if (nameMatch?.[1] !== undefined) {
      name = stripQuotes(nameMatch[1]);
      continue;
    }
    const descriptionMatch = /^description\s*:\s*(.*)$/.exec(line);
    if (descriptionMatch !== null) {
      const value = descriptionMatch[1]?.trim() ?? '';
      if (value === '>-' || value === '|' || value === '>' || value === '|-') {
        collectingDescription = true;
        continue;
      }
      description = stripQuotes(value);
    }
  }
  if (descriptionLines.length > 0) description = descriptionLines.join(' ').trim();
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function firstParagraph(body: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const paragraph = lines.find((line) => !line.startsWith('#') && !line.startsWith('---'));
  return paragraph ?? '';
}

async function findSkillFiles(root: string): Promise<readonly string[]> {
  const results: string[] = [];
  await walkForSkills(root, results, new Set<string>());
  return results;
}

async function walkForSkills(current: string, results: string[], visited: Set<string>): Promise<void> {
  const canonical = await safeRealpath(current);
  if (canonical === undefined) return;
  const visitKey = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  if (visited.has(visitKey)) return;
  visited.add(visitKey);

  const skillPath = path.join(current, 'SKILL.md');
  if (await isFile(skillPath)) {
    results.push(skillPath);
    return;
  }
  for (const entry of await safeReaddir(current)) {
    await walkForSkills(path.join(current, entry), results, visited);
  }
}

async function safeRealpath(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    return undefined;
  }
}

async function safeReaddir(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(path.sep);
  return firstSegment !== '..';
}

function dedupeByPathAndDisambiguateIds(skills: readonly SkillSummary[]): readonly SkillSummary[] {
  const seenPaths = new Set<string>();
  const usedIds = new Set<string>();
  const result: SkillSummary[] = [];
  for (const skill of skills) {
    const pathKey = normalizePathKey(skill.skillPath);
    if (seenPaths.has(pathKey)) continue;
    seenPaths.add(pathKey);

    let id = skill.id;
    if (usedIds.has(id)) {
      const relativeFolder = path.relative(skill.rootPath, path.dirname(skill.skillPath))
        .split(path.sep)
        .filter((segment) => segment.length > 0 && segment !== '..')
        .join('/');
      const pathQualifiedId = `${skill.source}/${relativeFolder || skill.name}`;
      id = pathQualifiedId;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${pathQualifiedId}#${suffix}`;
        suffix += 1;
      }
    }
    usedIds.add(id);
    result.push(id === skill.id ? skill : { ...skill, id });
  }
  return result;
}

function normalizePathKey(value: string): string {
  const resolved = path.resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ');
}
