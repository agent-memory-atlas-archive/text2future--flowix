import { describe, expect, it } from 'vitest';

import type { DocTreeItem } from '@platform/tauri/client';
import { sortNotebookTreeItems } from './notebook-folder-view';

function item(name: string, type: DocTreeItem['type']): DocTreeItem {
  return {
    id: name,
    fullPath: `/notebook/${name}`,
    name,
    type,
    parentId: null,
    children: type === 'folder' ? [] : null,
    sizeBytes: null,
    modifiedMs: null,
    createdMs: null,
    memoCreatedMs: null,
  };
}

describe('notebook folder sorting', () => {
  it('keeps folders first and sorts notes by creation time descending', () => {
    const folder = item('projects', 'folder');
    const older = { ...item('older.md', 'document'), createdMs: 10, modifiedMs: 30 };
    const newer = { ...item('newer.md', 'document'), createdMs: 20, modifiedMs: 15 };

    expect(sortNotebookTreeItems([older, newer, folder]).map((entry) => entry.name))
      .toEqual(['projects', 'newer.md', 'older.md']);
  });

  it('uses the indexed memo creation time when the file was atomically replaced', () => {
    const replacedOlder = {
      ...item('older.md', 'document'),
      createdMs: 100,
      memoCreatedMs: 10,
    };
    const genuinelyNewer = {
      ...item('newer.md', 'document'),
      createdMs: 20,
      memoCreatedMs: 20,
    };

    expect(sortNotebookTreeItems([replacedOlder, genuinelyNewer]).map((entry) => entry.name))
      .toEqual(['newer.md', 'older.md']);
  });
});
