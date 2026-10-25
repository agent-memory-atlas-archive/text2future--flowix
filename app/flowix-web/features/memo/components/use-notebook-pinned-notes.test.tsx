import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteEntry, NoteListPage } from '@platform/tauri/client';
import type { NotebookChange } from '@platform/tauri/notebook-change-events';

const mocks = vi.hoisted(() => ({ listByPath: vi.fn(), ready: null as null | (() => void), notify: null as null | ((change: NotebookChange) => void) }));
vi.mock('@features/memo/services/note-repository', () => ({
  noteRepository: { listByPath: mocks.listByPath },
}));
vi.mock('@/lib/memo-dispatcher', () => ({ registerMemoEventHandler: () => () => {} }));
vi.mock('@platform/tauri/notebook-change-events', () => ({ subscribeNotebookChanges: (handler: (change: NotebookChange) => void, options: { onListenerReady: () => void }) => { mocks.notify = handler; mocks.ready = options.onListenerReady; return () => { mocks.notify = null; }; } }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

import { useNotebookPinnedNotes } from './use-notebook-pinned-notes';
import { noteMetadata } from '../services/note-metadata-service';

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
    noteMetadata.clear();
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

  it('keeps the current page when an unloaded pinned note only changes metadata', async () => {
    mocks.listByPath.mockResolvedValueOnce({ notes: [note('first.md')], nextCursor: 'page-2', hasMore: true })
      .mockResolvedValueOnce({ notes: [note('second.md')], hasMore: false });
    await act(async () => root.render(createElement(Harness)));
    await act(async () => data().loadMore());
    await act(async () => mocks.notify?.({
      kind: 'resource-updated', notebookId: 'nb-1', relativePath: 'deep/unloaded.md',
      entry: { ...note('deep/unloaded.md'), icon: 'book' }, previousFavorited: true,
      source: 'native',
    } as NotebookChange));
    expect(mocks.listByPath).toHaveBeenCalledTimes(2);
    expect(data().pinnedItems.map((item) => item.name)).toEqual(['second.md']);
    expect(data().hasPrevious).toBe(true);
  });

  it('refreshes pinned notes on listener recovery', async () => {
    mocks.listByPath.mockResolvedValueOnce({ notes: [note('old.md')], hasMore: false })
      .mockResolvedValueOnce({ notes: [note('new.md')], hasMore: false });
    await act(async () => root.render(createElement(Harness)));
    expect(data().pinnedItems[0].name).toBe('old.md');
    await act(async () => mocks.ready?.());
    expect(data().pinnedItems[0].name).toBe('new.md');
    expect(mocks.listByPath).toHaveBeenCalledTimes(2);
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

  it('updates deep pinned note metadata on cached pages without resetting pagination', async () => {
    mocks.listByPath.mockResolvedValueOnce({ notes: [note('a/b/first.md')], nextCursor: 'page-2', hasMore: true })
      .mockResolvedValueOnce({ notes: [note('a/b/second.md')], hasMore: false });
    await act(async () => root.render(createElement(Harness)));
    await act(async () => data().loadMore());
    const updated = { ...note('a/b/first.md'), icon: 'flashlight', colors: ['blue' as const] };
    await act(async () => mocks.notify?.({ kind: 'resource-updated', notebookId: 'nb-1', relativePath: updated.relativePath, entry: updated }));
    expect(data().pinnedItems[0].name).toBe('second.md');
    expect(data().hasPrevious).toBe(true);
    await act(async () => data().loadPrevious());
    expect(data().pinnedItems[0].fullPath).toBe('/notes/nb-1/a/b/first.md');
    expect(data().pinnedItems[0].memoMeta).toEqual({ icon: 'flashlight', colors: ['blue'], favorited: true });
    await act(async () => mocks.notify?.({ kind: 'resource-updated', notebookId: 'nb-1', relativePath: updated.relativePath, entry: { ...updated, icon: null, colors: [] } }));
    expect(data().pinnedItems[0].memoMeta).toEqual({ icon: null, colors: [], favorited: true });
    expect(mocks.listByPath).toHaveBeenCalledTimes(2);
  });

  it('does not let a delayed page overwrite a saved metadata update', async () => {
    const old = note('a/b/note.md');
    mocks.listByPath.mockResolvedValueOnce({ notes: [old], hasMore: false });
    await act(async () => root.render(createElement(Harness)));
    let finish!: (page: NoteListPage) => void;
    mocks.listByPath.mockImplementationOnce(() => new Promise<NoteListPage>(resolve => { finish = resolve; }));
    await act(async () => mocks.ready?.());
    const updated = { ...old, icon: 'flashlight', colors: ['blue' as const] };
    await act(async () => mocks.notify?.({ kind: 'resource-updated', notebookId: 'nb-1', relativePath: old.relativePath, entry: updated }));
    await act(async () => finish({ notes: [old], nextCursor: null, hasMore: false }));
    expect(data().pinnedItems[0].memoMeta).toEqual({ icon: 'flashlight', colors: ['blue'], favorited: true });
    expect(mocks.listByPath).toHaveBeenCalledTimes(2);
  });

  it('refreshes membership when a deep note is pinned or unpinned', async () => {
    const pinned = note('a/b/note.md');
    mocks.listByPath.mockResolvedValueOnce({ notes: [], hasMore: false })
      .mockResolvedValueOnce({ notes: [pinned], hasMore: false })
      .mockResolvedValueOnce({ notes: [], hasMore: false });
    await act(async () => root.render(createElement(Harness)));
    await act(async () => mocks.notify?.({ kind: 'resource-updated', notebookId: 'nb-1', relativePath: pinned.relativePath, entry: pinned }));
    expect(data().pinnedItems[0].fullPath).toBe('/notes/nb-1/a/b/note.md');
    await act(async () => mocks.notify?.({ kind: 'resource-updated', notebookId: 'nb-1', relativePath: pinned.relativePath, entry: { ...pinned, favorited: false } }));
    expect(data().pinnedItems).toEqual([]);
    expect(mocks.listByPath).toHaveBeenCalledTimes(3);
  });

  it('ignores changes to unpinned notes and other notebooks', async () => {
    mocks.listByPath.mockResolvedValue({ notes: [note('pinned.md')], hasMore: false });
    await act(async () => root.render(createElement(Harness)));
    await act(async () => {
      mocks.notify?.({ kind: 'resource-updated', notebookId: 'nb-1', relativePath: 'unrelated.md', entry: { ...note('unrelated.md'), favorited: false } });
      mocks.notify?.({ kind: 'resource-updated', notebookId: 'other', relativePath: 'pinned.md', entry: { ...note('pinned.md'), icon: 'flashlight' } });
    });
    expect(data().pinnedItems[0].memoMeta?.icon).toBeNull();
    expect(mocks.listByPath).toHaveBeenCalledOnce();
  });
});
