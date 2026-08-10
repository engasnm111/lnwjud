import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_TREE_DEPTH, DEFAULT_TREE_ENTRIES, err, MAX_TREE_DEPTH, MAX_TREE_ENTRIES, ok, type Result } from '@lnwjud/domain';
import { isWithin } from '@lnwjud/workspace';

const IGNORED_DIRECTORIES = new Set(['.git', '.next', 'build', 'coverage', 'dist', 'node_modules', 'vendor']);

export interface TreeOptions {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

export interface TreeEntry {
  readonly path: string;
  readonly type: 'file' | 'directory';
}

export interface TreeResult {
  readonly entries: readonly TreeEntry[];
  readonly truncated: boolean;
}

export class TreeReader {
  public async read(rootPath: string, options: TreeOptions = {}): Promise<Result<TreeResult>> {
    const maxDepth = options.maxDepth ?? DEFAULT_TREE_DEPTH;
    const maxEntries = options.maxEntries ?? DEFAULT_TREE_ENTRIES;
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_TREE_DEPTH || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_TREE_ENTRIES) {
      return err({ code: 'INVALID_INPUT', message: 'Tree bounds are invalid', recoverable: false });
    }

    let rootRealPath: string;
    try {
      rootRealPath = await realpath(rootPath);
    } catch {
      return err({ code: 'FILE_NOT_FOUND', message: 'Tree root was not found', recoverable: false });
    }

    const entries: TreeEntry[] = [];
    let truncated = false;
    const walk = async (currentPath: string, relativeDirectory: string, depth: number): Promise<void> => {
      if (truncated || depth > maxDepth) return;
      let directoryEntries;
      try {
        directoryEntries = await readdir(currentPath, { withFileTypes: true });
      } catch {
        return;
      }
      directoryEntries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
      for (const directoryEntry of directoryEntries) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        if (directoryEntry.isDirectory() && IGNORED_DIRECTORIES.has(directoryEntry.name)) continue;
        const absoluteEntryPath = path.join(currentPath, directoryEntry.name);
        let entryRealPath: string;
        try {
          entryRealPath = await realpath(absoluteEntryPath);
        } catch {
          continue;
        }
        if (!isWithin(rootRealPath, entryRealPath)) continue;
        const relativePath = path.join(relativeDirectory, directoryEntry.name);
        const isDirectory = directoryEntry.isDirectory();
        if (!isDirectory && !directoryEntry.isFile()) continue;
        entries.push({ path: relativePath, type: isDirectory ? 'directory' : 'file' });
        if (isDirectory && depth < maxDepth) await walk(absoluteEntryPath, relativePath, depth + 1);
      }
    };

    try {
      if (!(await lstat(rootPath)).isDirectory()) return err({ code: 'INVALID_INPUT', message: 'Tree root must be a directory', recoverable: false });
    } catch {
      return err({ code: 'FILE_NOT_FOUND', message: 'Tree root was not found', recoverable: false });
    }
    await walk(rootPath, '', 1);
    return ok({ entries, truncated });
  }
}

export * from './text-file-reader.js';
