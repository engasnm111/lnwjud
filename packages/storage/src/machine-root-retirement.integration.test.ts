import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('automatic machine-root retirement migration', () => {
  it('archives generated Local Disk roots while preserving projects and explicitly named roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-retire-machine-roots-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'state.sqlite');
    const legacy = new SqliteDatabase(filename);
    legacy.connection.prepare(`
      INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run('auto-c', 'Local Disk C:', 'C:\\', 'C:\\', '2026-08-01T00:00:00.000Z');
    legacy.connection.prepare(`
      INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run('auto-z', 'Local Disk Z:', 'Z:\\', '\\\\dgx-spark\\models', '2026-08-01T00:00:01.000Z');
    legacy.connection.prepare(`
      INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run('project-z', 'DGX Project', 'Z:\\project-a', '\\\\dgx-spark\\models\\project-a', '2026-08-01T00:00:02.000Z');
    legacy.connection.prepare(`
      INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run('manual-z', 'DGX Models Root', 'Y:\\', '\\\\dgx-spark\\models', '2026-08-01T00:00:03.000Z');
    legacy.connection.prepare("DELETE FROM schema_migrations WHERE id = '012_retire_auto_machine_roots'").run();
    legacy.close();

    const upgraded = new SqliteDatabase(filename);
    try {
      const repository = new SqliteWorkspaceRepository(upgraded);
      await expect(repository.list().then((entries) => entries.map((entry) => entry.id))).resolves.toEqual([
        'project-z',
        'manual-z',
      ]);
      await expect(repository.listAll()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'auto-c', archivedAt: expect.any(String) }),
        expect.objectContaining({ id: 'auto-z', archivedAt: expect.any(String) }),
      ]));
    } finally {
      upgraded.close();
    }
  });
});
