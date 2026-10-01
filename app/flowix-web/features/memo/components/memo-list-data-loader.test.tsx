import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoListDataLoader } from './memo-list-data-loader';

let container: HTMLDivElement;
let root: Root;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function renderLoader(overrides: Partial<ComponentProps<typeof MemoListDataLoader>> = {}) {
  const props: ComponentProps<typeof MemoListDataLoader> = {
    dataLoadingEnabled: true,
    startupPhase: 'ready',
    initialMemoQueryKey: null,
    memoListQueryKey: null,
    selectedNotebookId: 'notebook-1',
    activeFilter: 'all',
    activeSort: 'createdAt',
    activeTagId: null,
    colorFilter: 'any',
    activePluginId: null,
    refreshTrigger: 0,
    loadNotes: vi.fn().mockResolvedValue(true),
    setLoadedMemoListQueryKey: vi.fn(),
    setIsMemoListLoading: vi.fn(),
    onLoadError: vi.fn(),
    ...overrides,
  };
  root.render(createElement(MemoListDataLoader, props));
  return props;
}

describe('MemoListDataLoader', () => {
  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('does not issue a duplicate request for the startup query', async () => {
    const loadNotes = vi.fn().mockResolvedValue(true);
    const setLoadedMemoListQueryKey = vi.fn();
    const setIsMemoListLoading = vi.fn();

    await act(async () => {
      renderLoader({
        initialMemoQueryKey: 'notebook-1:all:createdAt:::',
        memoListQueryKey: 'notebook-1:all:createdAt:::',
        loadNotes,
        setLoadedMemoListQueryKey,
        setIsMemoListLoading,
      });
    });

    expect(loadNotes).not.toHaveBeenCalled();
    expect(setLoadedMemoListQueryKey).toHaveBeenCalledWith('notebook-1:all:createdAt:::');
    expect(setIsMemoListLoading).toHaveBeenCalledWith(false);
  });

  it('reports a query failure and clears loading state', async () => {
    const error = new Error('list unavailable');
    const loadNotes = vi.fn().mockRejectedValue(error);
    const onLoadError = vi.fn();
    const setIsMemoListLoading = vi.fn();

    await act(async () => {
      renderLoader({ loadNotes, onLoadError, setIsMemoListLoading });
    });

    expect(onLoadError).toHaveBeenCalledWith(error);
    expect(setIsMemoListLoading).toHaveBeenLastCalledWith(false);
  });

  it('marks a successful interactive query once without reloading it', async () => {
    const loadNotes = vi.fn().mockResolvedValue(true);
    const setLoadedMemoListQueryKey = vi.fn();

    await act(async () => {
      renderLoader({ loadNotes, setLoadedMemoListQueryKey });
    });

    expect(loadNotes).toHaveBeenCalledOnce();
    expect(setLoadedMemoListQueryKey).toHaveBeenCalledWith('notebook-1:all:createdAt:::');
  });

  it('reloads the initial all-notes query after switching away and back', async () => {
    const loadNotes = vi.fn().mockResolvedValue(true);
    const setLoadedMemoListQueryKey = vi.fn();

    await act(async () => {
      renderLoader({
        initialMemoQueryKey: 'notebook-1:all:createdAt:::',
        memoListQueryKey: 'notebook-1:todos:createdAt:::',
        activeFilter: 'all',
        loadNotes,
        setLoadedMemoListQueryKey,
      });
    });

    expect(loadNotes).toHaveBeenCalledWith(expect.objectContaining({
      filter: 'all',
    }));
    expect(setLoadedMemoListQueryKey).toHaveBeenCalledWith('notebook-1:all:createdAt:::');
  });

  it('does not mark a superseded query as loaded', async () => {
    const loadNotes = vi.fn().mockResolvedValue(false);
    const setLoadedMemoListQueryKey = vi.fn();

    await act(async () => {
      renderLoader({ loadNotes, setLoadedMemoListQueryKey });
    });

    expect(loadNotes).toHaveBeenCalledOnce();
    expect(setLoadedMemoListQueryKey).not.toHaveBeenCalled();
  });
});
