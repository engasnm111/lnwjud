import type { GitStatusEntrySummary } from '@lnwjud/ipc-contracts';

export type GitTreeNode = GitTreeFolder | GitTreeFile;
export interface GitTreeFolder {
  readonly type: 'folder';
  readonly name: string;
  readonly path: string;
  readonly count: number;
  readonly children: readonly GitTreeNode[];
}
export interface GitTreeFile {
  readonly type: 'file';
  readonly name: string;
  readonly path: string;
  readonly entry: GitStatusEntrySummary;
}

type MutableFolder = {
  type: 'folder';
  name: string;
  path: string;
  count: number;
  children: Map<string, MutableFolder | GitTreeFile>;
};

export function buildGitFileTree(entries: readonly GitStatusEntrySummary[]): readonly GitTreeNode[] {
  const root: MutableFolder = { type: 'folder', name: '', path: '', count: 0, children: new Map() };
  for (const entry of entries) {
    const segments = entry.path.replace(/\\/g, '/').split('/').filter(Boolean);
    if (segments.length === 0) continue;
    let parent = root;
    for (const name of segments.slice(0, -1)) {
      const folderPath = parent.path ? `${parent.path}/${name}` : name;
      let folder = parent.children.get(name);
      if (folder?.type !== 'folder') {
        folder = { type: 'folder', name, path: folderPath, count: 0, children: new Map() };
        parent.children.set(name, folder);
      }
      parent.count += 1;
      parent = folder;
    }
    parent.count += 1;
    parent.children.set(segments[segments.length - 1]!, {
      type: 'file', name: segments[segments.length - 1]!, path: entry.path, entry,
    });
  }
  function finalize(folder: MutableFolder): readonly GitTreeNode[] {
    const nodes = [...folder.children.values()].sort((a, b) => (
      a.type !== b.type ? (a.type === 'folder' ? -1 : 1) :
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    ));
    return nodes.map((node): GitTreeNode => node.type === 'folder'
      ? { type: 'folder', name: node.name, path: node.path, count: node.count, children: finalize(node) }
      : node);
  }
  return finalize(root);
}
