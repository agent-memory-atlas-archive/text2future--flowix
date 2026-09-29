import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listByPath: vi.fn(),
  setSelectedTagId: vi.fn(),
}));

vi.mock('@features/memo/services', () => ({
  memoRepository: {
    list: mocks.list,
    listByPath: mocks.listByPath,
    listPluginNotes: vi.fn(),
  },
  notebookRepository: {},
}));

vi.mock('@/lib/constants', () => ({
  STORAGE_KEYS: { MEMO: 'test-memo-store' },
}));

vi.mock('@features/memo/store/tag-store', () => ({
  useTagStore: {
    getState: () => ({
      selectedTagId: null,
      setSelectedTagId: mocks.setSelectedTagId,
    }),
  },
}));

import { useMemoStore } from '@features/memo/store/memo-store';

describe('memo store list loading', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.listByPath.mockReset();
    mocks.setSelectedTagId.mockReset();
    useMemoStore.setState({
      memos: [],
      selectedPathNote: { notebookId: 'notebook-1', relativePath: 'current.md' },
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

    await useMemoStore.getState().loadPathNotes({
      notebookId: 'notebook-1',
      filter: 'todos',
    });

    expect(useMemoStore.getState().pathNotes[0].relativePath).toBe('todo.md');
    expect(useMemoStore.getState().selectedPathNote?.relativePath).toBe('current.md');
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
    useMemoStore.setState({
      selectedNotebook: {
        id: 'notebook-1',
        name: 'Notebook',
        path: '/tmp/notebook',
        createdAt: 1,
        updatedAt: 1,
        isDefault: true,
      },
    });

    await useMemoStore.getState().loadPathNotes({ notebookId: 'notebook-1', filter: 'all' });

    expect(mocks.listByPath).toHaveBeenCalledWith(expect.objectContaining({
      notebookId: 'notebook-1',
      limit: 50,
    }));
    expect(mocks.list).not.toHaveBeenCalled();
    expect(useMemoStore.getState().pathNotes[0]).toMatchObject({
      kind: 'path-note',
      notebookId: 'notebook-1',
      relativePath: 'folder/Path note.md',
      filename: 'Path note.md',
      title: 'Path note',
    });
    expect('id' in useMemoStore.getState().pathNotes[0]).toBe(false);
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
    useMemoStore.setState({
      selectedNotebook: {
        id: 'notebook-1', name: 'Notebook', path: '/tmp/notebook',
        createdAt: 1, updatedAt: 1, isDefault: true,
      },
      activeFilter: 'all',
      activeSort: 'createdAt',
      activePluginId: null,
    });

    await useMemoStore.getState().loadPathNotes({ notebookId: 'notebook-1', filter: 'all' });
    await useMemoStore.getState().loadMoreMemos();

    expect(mocks.listByPath).toHaveBeenNthCalledWith(2, expect.objectContaining({
      notebookId: 'notebook-1',
      cursor: 'path-cursor',
      limit: 50,
    }));
    expect(useMemoStore.getState().pathNotes.map((note) => note.relativePath)).toEqual([
      'Alpha.md', 'Beta.md',
    ]);
    expect(useMemoStore.getState().memoListHasMore).toBe(false);
  });

  it('ignores an older path response after a newer path load', async () => {
    let resolveOld: ((value: { notes: never[]; nextCursor: null; hasMore: false }) => void) | undefined;
    mocks.listByPath
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ notes: [], nextCursor: null, hasMore: false });

    const older = useMemoStore.getState().loadPathNotes({ notebookId: 'notebook-1', filter: 'all' });
    await useMemoStore.getState().loadPathNotes({ notebookId: 'notebook-1', filter: 'all' });
    resolveOld?.({ notes: [], nextCursor: null, hasMore: false });

    await expect(older).resolves.toBe(false);
  });

  it('persists sidebar navigation and normalizes middle-column-only filters', () => {
    useMemoStore.getState().setActiveFilter('agents');

    let persisted = JSON.parse(localStorage.getItem('test-memo-store') ?? '{}');
    expect(persisted.state.activeFilter).toBe('agents');
    expect(useMemoStore.getState().middleColumnView).toBe('conversations');
    expect(persisted.state.selectedMemoId).toBeUndefined();
    expect(persisted.state.selectedMemo).toBeUndefined();

    useMemoStore.getState().setActiveFilter('color');
    persisted = JSON.parse(localStorage.getItem('test-memo-store') ?? '{}');
    expect(persisted.state.activeFilter).toBe('all');
    expect(useMemoStore.getState().middleColumnView).toBe('notes');

  });

  it('persists path selection without an ID selection', () => {
    useMemoStore.getState().setSelectedPathNote({
      notebookId: 'notebook-1',
      relativePath: 'folder/note.md',
    });

    const persisted = JSON.parse(localStorage.getItem('test-memo-store') ?? '{}');
    expect(useMemoStore.getState().selectedPathNote?.relativePath).toBe('folder/note.md');
    expect(persisted.state.selectedMemoId).toBeUndefined();
    expect(persisted.state.selectedPathNote).toEqual({
      notebookId: 'notebook-1',
      relativePath: 'folder/note.md',
    });
  });

  it('drops legacy memo selection when rehydrating saved state', async () => {
    localStorage.setItem('test-memo-store', JSON.stringify({
      state: {
        selectedMemoId: 'legacy-id',
        selectedMemo: { id: 'legacy-id', filename: 'old.md' },
        selectedNotebookId: 'notebook-1',
        selectedPathNote: { notebookId: 'notebook-1', relativePath: 'folder/note.md' },
        activeFilter: 'all',
      },
      version: 0,
    }));
    await useMemoStore.persist.rehydrate();

    const state = useMemoStore.getState() as unknown as Record<string, unknown>;
    expect(state).not.toHaveProperty('selectedMemoId');
    expect(state).not.toHaveProperty('selectedMemo');
    expect(state.selectedPathNote).toEqual({ notebookId: 'notebook-1', relativePath: 'folder/note.md' });
  });

  it('exits a plugin view when notes is already the active filter', () => {
    useMemoStore.setState({
      activeFilter: 'all',
      activePluginId: 'plugin-1',
    });

    useMemoStore.getState().setActiveFilter('all');

    expect(useMemoStore.getState().activeFilter).toBe('all');
    expect(useMemoStore.getState().activePluginId).toBeNull();
  });
});
