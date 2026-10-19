import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteEntry, NoteListPage } from '@platform/tauri/client';

const mocks = vi.hoisted(() => ({ listByPath: vi.fn() }));
vi.mock('@features/memo/services/note-repository', () => ({
  noteRepository: { listByPath: mocks.listByPath },
}));
vi.mock('@/lib/memo-dispatcher', () => ({ registerMemoEventHandler: () => () => {} }));
vi.mock('@platform/tauri/notebook-change-events', () => ({ subscribeNotebookChanges: () => () => {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

import { useNotebookPinnedNotes } from './use-notebook-pinned-notes';

function note(relativePath: string): NoteEntry {
  return {
    relativePath,
    title: relativePath,
    preview: '',
    thumbnail: null,
    tags: [],
    todos: [],
    agents: [],
    createdAt: 1,
    updatedAt: 2,
    favorited: true,
    icon: null,
    colors: [],
    properties: {},
  };
}

let root: Root;
let latest: ReturnType<typeof useNotebookPinnedNotes> | null;

function Harness() {
  latest = useNotebookPinnedNotes({
    notebookId: 'nb-1', notebookPath: '/notes/nb-1', isActive: true, refreshTrigger: 0,
  });
  return null;
}

function data() {
  if (!latest) throw new Error('Harness is not mounted');
  return latest;
}

describe('notebook pinned note pagination', () => {
  beforeEach(() => {
    latest = null;
    mocks.listByPath.mockReset();
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('loads one page at a time and keeps earlier pages reachable', async () => {
    mocks.listByPath
      .mockResolvedValueOnce({ notes: [note('first.md')], nextCursor: 'page-2', hasMore: true } satisfies NoteListPage)
      .mockResolvedValueOnce({ notes: [note('second.md')], nextCursor: null, hasMore: false } satisfies NoteListPage);

    await act(async () => root.render(createElement(Harness)));
    expect(mocks.listByPath).toHaveBeenCalledTimes(1);
    expect(data().pinnedItems.map((item) => item.name)).toEqual(['first.md']);
    expect(data().hasMore).toBe(true);

    await act(async () => data().loadMore());
    expect(mocks.listByPath).toHaveBeenCalledTimes(2);
    expect(mocks.listByPath).toHaveBeenLastCalledWith({
      notebookId: 'nb-1', filter: 'favorited', sort: 'updatedAt', cursor: 'page-2', limit: 100,
    });
    expect(data().pinnedItems.map((item) => item.name)).toEqual(['second.md']);
    expect(data().hasMore).toBe(false);
    expect(data().hasPrevious).toBe(true);

    await act(async () => data().loadPrevious());
    expect(data().pinnedItems.map((item) => item.name)).toEqual(['first.md']);
    expect(mocks.listByPath).toHaveBeenCalledTimes(2);
  });
});
