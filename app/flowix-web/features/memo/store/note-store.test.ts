import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listByPath: vi.fn(),
  loadNotebookFilters: vi.fn(),
  setSelectedTagId: vi.fn(),
}));

vi.mock('@features/memo/services', () => ({
  noteRepository: {
    list: mocks.list,
    listByPath: mocks.listByPath,
    listPluginNotes: vi.fn(),
  },
  notebookRepository: {},
}));

vi.mock('@/lib/constants', () => ({
  STORAGE_KEYS: { NOTE: 'test-note-store' },
}));

vi.mock('@features/memo/store/tag-store', () => ({
  useTagStore: {
    getState: () => ({
      selectedTagId: null,
      setSelectedTagId: mocks.setSelectedTagId,
    }),
  },
}));

vi.mock('@features/memo/store/custom-filter-store', () => ({
  memoMatchesCustomFilter: vi.fn(() => true),
  useCustomFilterStore: {
    getState: () => ({
      filtersByNotebook: {},
      loadNotebookFilters: mocks.loadNotebookFilters,
    }),
  },
}));

import { useNoteStore } from '@features/memo/store/note-store';
import { useNotebookBackgroundStore } from './notebook-background-store';
import { noteListItemKey } from '@/types/note-item';

describe('note store list loading', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.listByPath.mockReset();
    mocks.loadNotebookFilters.mockReset().mockResolvedValue(undefined);
    mocks.setSelectedTagId.mockReset();
    useNoteStore.setState({
      notes: [],
      memoListQueryKey: null,
      memoListQuery: null,
      memoListNextCursor: null,
      memoListHasMore: false,
      memoListLoadingMore: false,
      selectedNote: { notebookId: 'notebook-1', relativePath: 'current.md' },
      selectedNotebook: null,
      middleColumnView: 'notes',
      activeFilter: 'todos',
      activePluginId: null,
    });
  });

  it('keeps a missing index as pending without treating it as an empty result', async () => {
    useNotebookBackgroundStore.setState({ statuses: {} });
    mocks.listByPath.mockRejectedValue(new Error('NOTE_INDEX_PENDING'));
    await expect(useNoteStore.getState().loadNotes({ notebookId: 'notebook-1', filter: 'all' })).resolves.toBe(false);
    expect(useNoteStore.getState().memoListQueryKey).toBeNull();
    expect(useNotebookBackgroundStore.getState().statuses['notebook-1'].state).toBe('queued');
  });

  it('updates a filtered list without clearing the document selection', async () => {
    const filteredNote = {
      relativePath: 'todo.md', title: 'todo', preview: '', thumbnail: null,
      tags: [], todos: [], agents: [], createdAt: 1, updatedAt: 1,
      favorited: false, icon: null, colors: [], properties: {},
    };
    mocks.listByPath.mockResolvedValue({ notes: [filteredNote], nextCursor: null, hasMore: false });

    await useNoteStore.getState().loadNotes({
      notebookId: 'notebook-1',
      filter: 'todos',
    });

    expect(useNoteStore.getState().notes[0].relativePath).toBe('todo.md');
    expect(useNoteStore.getState().selectedNote?.relativePath).toBe('current.md');
  });

  it('loads the primary note list from path records without memo IDs', async () => {
    mocks.listByPath.mockResolvedValue({
      notes: [{
        relativePath: 'folder/Path note.md',
        title: 'Path note',
        preview: 'preview',
        thumbnail: null,
        tags: [],
        todos: [],
        agents: [],
        createdAt: 1,
        updatedAt: 2,
        favorited: false,
        icon: null,
        colors: [],
        properties: {},
      }],
      nextCursor: null,
      hasMore: false,
    });
    useNoteStore.setState({
      selectedNotebook: {
        id: 'notebook-1',
        name: 'Notebook',
        path: '/tmp/notebook',
        createdAt: 1,
        updatedAt: 1,
        isDefault: true,
      },
    });

    await useNoteStore.getState().loadNotes({ notebookId: 'notebook-1', filter: 'all' });

    expect(mocks.listByPath).toHaveBeenCalledWith(expect.objectContaining({
      notebookId: 'notebook-1',
      limit: 50,
    }));
    expect(mocks.list).not.toHaveBeenCalled();
    expect(useNoteStore.getState().notes[0]).toMatchObject({
      kind: 'path-note',
      notebookId: 'notebook-1',
      relativePath: 'folder/Path note.md',
      filename: 'Path note.md',
      title: 'Path note',
    });
    expect('id' in useNoteStore.getState().notes[0]).toBe(false);
  });

  it('appends path pages by notebook and relative path without duplicates', async () => {
    const alpha = {
      relativePath: 'Alpha.md', title: 'Alpha', preview: '', thumbnail: null,
      tags: [], todos: [], agents: [], createdAt: 1, updatedAt: 1,
      favorited: false, icon: null, colors: [], properties: {},
    };
    const beta = { ...alpha, relativePath: 'Beta.md', title: 'Beta' };
    mocks.listByPath
      .mockResolvedValueOnce({ notes: [alpha], nextCursor: 'path-cursor', hasMore: true })
      .mockResolvedValueOnce({ notes: [alpha, beta], nextCursor: null, hasMore: false });
    useNoteStore.setState({
      selectedNotebook: {
        id: 'notebook-1', name: 'Notebook', path: '/tmp/notebook',
        createdAt: 1, updatedAt: 1, isDefault: true,
      },
      activeFilter: 'all',
      activeSort: 'createdAt',
      activePluginId: null,
    });

    await useNoteStore.getState().loadNotes({ notebookId: 'notebook-1', filter: 'all' });
    await useNoteStore.getState().loadMoreMemos();

    expect(mocks.listByPath).toHaveBeenNthCalledWith(2, expect.objectContaining({
      notebookId: 'notebook-1',
      cursor: 'path-cursor',
      limit: 50,
    }));
    expect(useNoteStore.getState().notes.map((note) => note.relativePath)).toEqual([
      'Alpha.md', 'Beta.md',
    ]);
    expect(useNoteStore.getState().memoListHasMore).toBe(false);
  });

  it('ignores an older path response after a newer path load', async () => {
    let resolveOld: ((value: { notes: never[]; nextCursor: null; hasMore: false }) => void) | undefined;
    mocks.listByPath
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ notes: [], nextCursor: null, hasMore: false });

    const older = useNoteStore.getState().loadNotes({ notebookId: 'notebook-1', filter: 'all' });
    await Promise.resolve();
    expect(mocks.listByPath).toHaveBeenCalledOnce();
    await useNoteStore.getState().loadNotes({ notebookId: 'notebook-1', filter: 'all' });
    resolveOld?.({ notes: [], nextCursor: null, hasMore: false });

    await expect(older).resolves.toBe(false);
  });

  function entry(index: number) {
    return {
      relativePath: `note-${index}.md`, title: `Note ${index}`, preview: 'before', thumbnail: null,
      tags: [], todos: [], agents: [], createdAt: 1000 - index, updatedAt: 1000 - index,
      favorited: false, icon: null, colors: [], properties: {},
    };
  }

  async function loadBrowsingSession(sort: 'updatedAt' | 'filenameAsc' = 'updatedAt') {
    useNoteStore.setState({
      selectedNotebook: { id: 'notebook-1', name: 'Notebook', path: '/tmp/notebook', createdAt: 1, updatedAt: 1, isDefault: true },
      activeFilter: 'all', activeSort: sort, activePluginId: null,
    });
    mocks.listByPath.mockResolvedValueOnce({ notes: Array.from({ length: 150 }, (_, i) => entry(i)), nextCursor: 'page-4', hasMore: true });
    await useNoteStore.getState().loadNotes();
  }

  it('keeps every loaded position and cursor when editing a card after several pages', async () => {
    await loadBrowsingSession();
    const before = useNoteStore.getState().notes;
    useNoteStore.getState().applyNoteListChange('notebook-1', 'note-120.md', { ...entry(120), preview: 'edited', updatedAt: 9999 });
    const state = useNoteStore.getState();
    expect(state.notes.map(note => note.relativePath)).toEqual(before.map(note => note.relativePath));
    expect(state.notes[120].preview).toBe('edited');
    expect(state.notes[0]).toBe(before[0]);
    expect(state.memoListNextCursor).toBe('page-4');
    expect(state.memoListHasMore).toBe(true);
    expect(mocks.listByPath).toHaveBeenCalledOnce();
    const updated = state.notes;
    state.applyNoteListChange('notebook-1', 'note-120.md', { ...entry(120), preview: 'edited', updatedAt: 9999 });
    expect(useNoteStore.getState().notes).toBe(updated);
  });

  it('commits a batch once and replays its edits over later pages', async () => {
    await loadBrowsingSession();
    const before = useNoteStore.getState().notes;
    const subscriber = vi.fn();
    const unsubscribe = useNoteStore.subscribe(subscriber);
    try {
      useNoteStore.getState().applyNoteListBatch([
        { notebookId: 'notebook-1', relativePath: 'note-120.md', entry: { ...entry(120), preview: 'batch edit' } },
        { notebookId: 'notebook-1', relativePath: 'note-121.md', entry: null },
        { notebookId: 'other', relativePath: 'note-0.md', entry: null },
      ]);
      expect(subscriber).toHaveBeenCalledOnce();
      expect(useNoteStore.getState().notes[0]).toBe(before[0]);
      expect(useNoteStore.getState().notes).toHaveLength(149);
      mocks.listByPath.mockResolvedValueOnce({ notes: [entry(120), entry(121), entry(150)], nextCursor: null, hasMore: false });
      await useNoteStore.getState().loadMoreMemos();
      expect(useNoteStore.getState().notes.find(note => note.relativePath === 'note-120.md')?.preview).toBe('batch edit');
      expect(useNoteStore.getState().notes.some(note => note.relativePath === 'note-121.md')).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('does not insert an unseen edited note into the loaded window', async () => {
    await loadBrowsingSession('filenameAsc');
    const before = useNoteStore.getState().notes;
    useNoteStore.getState().applyNoteListChange('notebook-1', 'new.md', { ...entry(999), relativePath: 'new.md' });
    expect(useNoteStore.getState().notes).toBe(before);
  });

  it('replays edits and deletions over an in-flight page response', async () => {
    await loadBrowsingSession();
    let resolvePage!: (value: unknown) => void;
    mocks.listByPath.mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }));
    const loading = useNoteStore.getState().loadMoreMemos();
    useNoteStore.getState().applyNoteListChange('notebook-1', 'note-120.md', { ...entry(120), preview: 'newer' });
    useNoteStore.getState().applyNoteListChange('notebook-1', 'note-121.md', null);
    resolvePage({ notes: [entry(120), entry(121), entry(150)], nextCursor: 'page-5', hasMore: true });
    await loading;
    const state = useNoteStore.getState();
    expect(state.notes.find(note => note.relativePath === 'note-120.md')?.preview).toBe('newer');
    expect(state.notes.some(note => note.relativePath === 'note-121.md')).toBe(false);
    expect(state.notes[state.notes.length - 1]?.relativePath).toBe('note-150.md');
    expect(state.memoListNextCursor).toBe('page-5');
  });

  it('retains the session overlay for later pages and clears it on explicit refresh', async () => {
    await loadBrowsingSession();
    useNoteStore.getState().applyNoteListChange('notebook-1', 'note-120.md', { ...entry(120), preview: 'local' });
    mocks.listByPath.mockResolvedValueOnce({ notes: [entry(120), entry(150)], nextCursor: null, hasMore: false });
    await useNoteStore.getState().loadMoreMemos();
    expect(useNoteStore.getState().notes[120].preview).toBe('local');
    mocks.listByPath.mockResolvedValueOnce({ notes: [entry(120)], nextCursor: null, hasMore: false });
    await useNoteStore.getState().loadNotes();
    expect(useNoteStore.getState().notes[0].preview).toBe('before');
  });

  it('renames a loaded card in place and removes folder descendants without resetting pagination', async () => {
    await loadBrowsingSession();
    useNoteStore.getState().applyNoteListChange('notebook-1', 'note-120.md', { ...entry(120), relativePath: 'folder/renamed.md' });
    expect(useNoteStore.getState().notes[120].relativePath).toBe('folder/renamed.md');
    useNoteStore.getState().applyNoteListChange('notebook-1', 'folder', null);
    expect(useNoteStore.getState().notes).toHaveLength(149);
    expect(useNoteStore.getState().memoListNextCursor).toBe('page-4');
  });

  it('keeps the rendered card identity and selection through a path rename and index refresh', async () => {
    await loadBrowsingSession();
    useNoteStore.getState().setSelectedNote({ notebookId: 'notebook-1', relativePath: 'note-120.md' });
    const before = useNoteStore.getState().notes[120];
    const key = noteListItemKey(before);

    useNoteStore.getState().rebaseNoteListPaths('notebook-1', 'note-120.md', 'renamed.md', false);
    const moved = useNoteStore.getState().notes[120];
    expect(moved.relativePath).toBe('renamed.md');
    expect(noteListItemKey(moved)).toBe(key);
    expect(useNoteStore.getState().selectedNote?.relativePath).toBe('renamed.md');
    expect(useNoteStore.getState().memoListNextCursor).toBe('page-4');

    useNoteStore.getState().applyNoteListChange('notebook-1', 'renamed.md', {
      ...entry(120), relativePath: 'renamed.md', preview: 'indexed refresh',
    });
    const refreshed = useNoteStore.getState().notes[120];
    expect(refreshed.preview).toBe('indexed refresh');
    expect(noteListItemKey(refreshed)).toBe(key);
  });

  it('does not duplicate a renamed card when a stale page still contains its former path', async () => {
    await loadBrowsingSession();
    useNoteStore.getState().applyNoteListChange('notebook-1', 'note-120.md', { ...entry(120), relativePath: 'renamed.md' });
    mocks.listByPath.mockResolvedValueOnce({ notes: [entry(120), entry(150)], nextCursor: null, hasMore: false });
    await useNoteStore.getState().loadMoreMemos();
    const notes = useNoteStore.getState().notes;
    expect(notes[120].relativePath).toBe('renamed.md');
    expect(notes.filter(note => note.relativePath === 'renamed.md')).toHaveLength(1);
    expect(notes.some(note => note.relativePath === 'note-120.md')).toBe(false);
  });

  it('does not let an old-window scroll request supersede a first-page refresh', async () => {
    await loadBrowsingSession();
    let resolveRefresh!: (value: unknown) => void;
    mocks.listByPath.mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
    const refresh = useNoteStore.getState().loadNotes();
    await Promise.resolve();
    await expect(useNoteStore.getState().loadMoreMemos()).resolves.toBe(false);
    expect(mocks.listByPath).toHaveBeenCalledTimes(2);
    resolveRefresh({ notes: [entry(999)], nextCursor: null, hasMore: false });
    await refresh;
    expect(useNoteStore.getState().notes[0].relativePath).toBe('note-999.md');
  });

  it('removes a card that no longer matches without reordering the remaining cards', async () => {
    await loadBrowsingSession();
    mocks.listByPath.mockResolvedValueOnce({ notes: [0, 1, 2].map(i => ({ ...entry(i), favorited: true })), nextCursor: 'next', hasMore: true });
    await useNoteStore.getState().loadNotes({ filter: 'favorited' });
    useNoteStore.getState().applyNoteListChange('notebook-1', 'note-1.md', entry(1));
    expect(useNoteStore.getState().notes.map(note => note.relativePath)).toEqual(['note-0.md', 'note-2.md']);
    expect(useNoteStore.getState().memoListNextCursor).toBe('next');
  });

  it('rebases directory moves for records still arriving from an in-flight page', async () => {
    await loadBrowsingSession();
    let resolve!: (value: unknown) => void;
    mocks.listByPath.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const loading = useNoteStore.getState().loadMoreMemos();
    useNoteStore.getState().rebaseNoteListPaths('notebook-1', 'folder', 'moved', true);
    resolve({ notes: [{ ...entry(150), relativePath: 'folder/unseen.md' }], nextCursor: null, hasMore: false });
    await loading;
    expect(useNoteStore.getState().notes[150].relativePath).toBe('moved/unseen.md');
  });

  it('ignores property key order when deciding whether a card changed', async () => {
    await loadBrowsingSession();
    useNoteStore.getState().applyNoteListChange('notebook-1', 'note-120.md', { ...entry(120), properties: { a: 1, b: 2 } });
    const notes = useNoteStore.getState().notes;
    useNoteStore.getState().applyNoteListChange('notebook-1', 'note-120.md', { ...entry(120), properties: { b: 2, a: 1 } });
    expect(useNoteStore.getState().notes).toBe(notes);
  });

  it('keeps a loaded window intact on a background invalidation', async () => {
    await loadBrowsingSession();
    const state = useNoteStore.getState();
    const revision = state.memoListRefreshTrigger;
    state.handleMemoListInvalidation('notebook-1');
    expect(useNoteStore.getState().notes).toBe(state.notes);
    expect(useNoteStore.getState().memoListRefreshTrigger).toBe(revision);
  });

  it('automatically resumes a cold query that does not have a loaded window yet', async () => {
    await loadBrowsingSession();
    useNoteStore.setState({ memoListQueryKey: null });
    const revision = useNoteStore.getState().memoListRefreshTrigger;
    useNoteStore.getState().handleMemoListInvalidation('notebook-1');
    expect(useNoteStore.getState().memoListRefreshTrigger).toBe(revision + 1);
  });

  it('persists sidebar navigation and normalizes middle-column-only filters', () => {
    useNoteStore.getState().setActiveFilter('agents');

    let persisted = JSON.parse(localStorage.getItem('test-note-store') ?? '{}');
    expect(persisted.state.activeFilter).toBe('agents');
    expect(useNoteStore.getState().middleColumnView).toBe('conversations');
    expect(persisted.state.selectedMemoId).toBeUndefined();
    expect(persisted.state.selectedMemo).toBeUndefined();

    useNoteStore.getState().setActiveFilter('color');
    persisted = JSON.parse(localStorage.getItem('test-note-store') ?? '{}');
    expect(persisted.state.activeFilter).toBe('all');
    expect(useNoteStore.getState().middleColumnView).toBe('notes');

  });

  it('persists path selection without an ID selection', () => {
    useNoteStore.getState().setSelectedNote({
      notebookId: 'notebook-1',
      relativePath: 'folder/note.md',
    });

    const persisted = JSON.parse(localStorage.getItem('test-note-store') ?? '{}');
    expect(useNoteStore.getState().selectedNote?.relativePath).toBe('folder/note.md');
    expect(persisted.state.selectedMemoId).toBeUndefined();
    expect(persisted.state.selectedNote).toEqual({
      notebookId: 'notebook-1',
      relativePath: 'folder/note.md',
    });
  });

  it('exits a plugin view when notes is already the active filter', () => {
    useNoteStore.setState({
      activeFilter: 'all',
      activePluginId: 'plugin-1',
    });

    useNoteStore.getState().setActiveFilter('all');

    expect(useNoteStore.getState().activeFilter).toBe('all');
    expect(useNoteStore.getState().activePluginId).toBeNull();
  });
});
