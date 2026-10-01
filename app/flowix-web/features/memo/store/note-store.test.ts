import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listByPath: vi.fn(),
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

import { useNoteStore } from '@features/memo/store/note-store';

describe('note store list loading', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.listByPath.mockReset();
    mocks.setSelectedTagId.mockReset();
    useNoteStore.setState({
      selectedNote: { notebookId: 'notebook-1', relativePath: 'current.md' },
      selectedNotebook: null,
      middleColumnView: 'notes',
      activeFilter: 'todos',
      activePluginId: null,
    });
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
    await useNoteStore.getState().loadNotes({ notebookId: 'notebook-1', filter: 'all' });
    resolveOld?.({ notes: [], nextCursor: null, hasMore: false });

    await expect(older).resolves.toBe(false);
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
