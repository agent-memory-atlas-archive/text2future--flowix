import { useEffect } from 'react';
import {
  type ColorFilterValue,
  type ExtendedFilterType,
  type NoteLibraryStartupPhase,
  type NoteLibraryStore,
} from '@features/memo/store/note-store';
import type { SortType } from '@features/memo/services';
import { getMemoListQueryKey } from './memo-list-loading-state';

export interface MemoListDataLoaderProps {
  dataLoadingEnabled: boolean;
  startupPhase: NoteLibraryStartupPhase;
  initialMemoQueryKey: string | null;
  memoListQueryKey: string | null;
  selectedNotebookId: string | undefined;
  activeFilter: ExtendedFilterType;
  activeSort: SortType;
  activeTagId: string | null;
  colorFilter: ColorFilterValue;
  activePluginId: string | null;
  activeCustomFilterId?: string | null;
  refreshTrigger: number;
  loadNotes: NoteLibraryStore['loadNotes'];
  setLoadedMemoListQueryKey: (queryKey: string | null) => void;
  setIsMemoListLoading: (loading: boolean) => void;
  onLoadError: (error: unknown) => void;
  onLoadStart?: (queryKey: string) => void;
  onLoadSuccess?: (queryKey: string) => void;
}

/**
 * Owns the memo-list query effect separately from the large list view.
 * Keeping this as a small component makes the startup/no-duplicate-request
 * contract directly testable without mounting the whole navigation surface.
 */
export function MemoListDataLoader({
  dataLoadingEnabled,
  startupPhase,
  initialMemoQueryKey,
  memoListQueryKey,
  selectedNotebookId,
  activeFilter,
  activeSort,
  activeTagId,
  colorFilter,
  activePluginId,
  activeCustomFilterId,
  refreshTrigger,
  loadNotes,
  setLoadedMemoListQueryKey,
  setIsMemoListLoading,
  onLoadError,
  onLoadStart,
  onLoadSuccess,
}: MemoListDataLoaderProps) {
  useEffect(() => {
    let cancelled = false;
    if (!dataLoadingEnabled) {
      setIsMemoListLoading(false);
      return () => {
        cancelled = true;
      };
    }
    if (startupPhase !== 'ready') {
      setIsMemoListLoading(startupPhase === 'loading');
      return () => {
        cancelled = true;
      };
    }
    if (!selectedNotebookId) {
      setIsMemoListLoading(false);
      setLoadedMemoListQueryKey(null);
      return () => {
        cancelled = true;
      };
    }

    const queryKey = getMemoListQueryKey(
      selectedNotebookId,
      activeFilter,
      activeSort,
      activeTagId,
      colorFilter,
      activePluginId,
      activeCustomFilterId,
    );
    async function loadMemoListOnly() {
      onLoadStart?.(queryKey);
      // The startup orchestrator has already loaded this exact query. Mark it
      // as rendered locally without issuing a duplicate IPC request.
      if (initialMemoQueryKey === queryKey && memoListQueryKey === queryKey) {
        setLoadedMemoListQueryKey(queryKey);
        setIsMemoListLoading(false);
        onLoadSuccess?.(queryKey);
        return;
      }
      setIsMemoListLoading(true);
      try {
        const applied = await loadNotes({
          notebookId: selectedNotebookId,
          filter: activeFilter,
          sort: activeSort,
          tagId: activeTagId ?? undefined,
        });
        if (cancelled || !applied) return;
        setLoadedMemoListQueryKey(queryKey);
        onLoadSuccess?.(queryKey);
      } catch (error) {
        if (!cancelled) onLoadError(error);
      } finally {
        if (!cancelled) {
          setIsMemoListLoading(false);
        }
      }
    }

    void loadMemoListOnly();

    return () => {
      cancelled = true;
    };
  }, [
    activeFilter,
    activePluginId,
    activeCustomFilterId,
    activeSort,
    activeTagId,
    colorFilter,
    dataLoadingEnabled,
    initialMemoQueryKey,
    loadNotes,
    memoListQueryKey,
    onLoadError,
    onLoadStart,
    onLoadSuccess,
    refreshTrigger,
    selectedNotebookId,
    setIsMemoListLoading,
    setLoadedMemoListQueryKey,
    startupPhase,
  ]);

  return null;
}
