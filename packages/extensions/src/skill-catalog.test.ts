import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXTENSIONS_SETTINGS } from './types.js';
import { SkillCatalog, parseSkillMarkdown } from './skill-catalog.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SkillCatalog', () => {
  it('parses folded frontmatter descriptions', () => {
    const parsed = parseSkillMarkdown(`---
name: demo
description: >-
  First line
  Second line
---
# Body
`, 'fallback');
    expect(parsed).toEqual({ name: 'demo', description: 'First line Second line' });
  });

  it('lists and reads skills under configured roots', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-skills-'));
    temporaryRoots.push(home);
    const skillRoot = path.join(home, '.cursor', 'skills-cursor', 'demo-skill');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, 'SKILL.md'), `---
name: demo-skill
description: Demo skill for tests
---
# Demo
Do the thing.
`, 'utf8');
    await writeFile(path.join(skillRoot, 'notes.md'), 'extra notes\n', 'utf8');

    const catalog = new SkillCatalog({ homeDir: home, settings: DEFAULT_EXTENSIONS_SETTINGS });
    const listed = await catalog.list({ query: 'demo' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.skills).toEqual([
      expect.objectContaining({
        id: 'cursor-skills-cursor/demo-skill',
        name: 'demo-skill',
        source: 'cursor-skills-cursor',
      }),
    ]);

    const read = await catalog.read({ skillId: 'cursor-skills-cursor/demo-skill' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.content).toContain('Do the thing.');

    const relative = await catalog.read({ skillId: 'cursor-skills-cursor/demo-skill', relativePath: 'notes.md' });
    expect(relative.ok).toBe(true);
    if (!relative.ok) return;
    expect(relative.value.content).toContain('extra notes');

    const escape = await catalog.read({ skillId: 'cursor-skills-cursor/demo-skill', relativePath: '../outside.md' });
    expect(escape.ok).toBe(false);
  });
});
