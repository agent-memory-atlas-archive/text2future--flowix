import { useEffect, useRef } from 'react';
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
  memoListRefreshTrigger: number;
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
  memoListRefreshTrigger,
  loadNotes,
  setLoadedMemoListQueryKey,
  setIsMemoListLoading,
  onLoadError,
  onLoadStart,
  onLoadSuccess,
}: MemoListDataLoaderProps) {
  // One lifecycle record owns deduplication and completion for the rendered
  // query revision. Data response ordering belongs to the store session.
  const requestRef = useRef<{
    fingerprint: string;
    promise?: Promise<boolean>;
    applied: boolean;
  } | null>(null);

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
      const fingerprint = JSON.stringify([queryKey, memoListRefreshTrigger]);
      // The startup orchestrator has already loaded this exact query. Mark it
      // as rendered locally without issuing a duplicate IPC request.
      if (
        initialMemoQueryKey === queryKey
        && memoListQueryKey === queryKey
        && memoListRefreshTrigger === 0
      ) {
        requestRef.current = { fingerprint, applied: true };
        setLoadedMemoListQueryKey(queryKey);
        setIsMemoListLoading(false);
        onLoadSuccess?.(queryKey);
        return;
      }
      // A completed list request updates memoListQueryKey, which is also an
      // effect dependency. Remember that query revision so this state update
      // cannot immediately issue the same request again.
      if (requestRef.current?.fingerprint === fingerprint && requestRef.current.applied) {
        setLoadedMemoListQueryKey(queryKey);
        setIsMemoListLoading(false);
        return;
      }
      setIsMemoListLoading(true);
      let request = requestRef.current;
      // Effect re-entry for the exact same query revision shares its request;
      // a newer invalidation has a different fingerprint and fetches again.
      if (!request || request.fingerprint !== fingerprint) {
        request = {
          fingerprint,
          applied: false,
          promise: loadNotes({
            notebookId: selectedNotebookId,
            filter: activeFilter,
            sort: activeSort,
            tagId: activeTagId ?? undefined,
            source: 'memo-list-loader',
          }),
        };
        requestRef.current = request;
      }
      try {
        const applied = await request.promise;
        if (cancelled) return;
        if (!applied) {
          // Another request may have loaded the same query while this one was
          // superseded. Accept only that exact applied query; otherwise the
          // rerendered current query owns the next readiness report.
          if (memoListQueryKey === queryKey) {
            request.applied = true;
            setLoadedMemoListQueryKey(queryKey);
          }
          return;
        }
        request.applied = true;
        setLoadedMemoListQueryKey(queryKey);
        onLoadSuccess?.(queryKey);
      } catch (error) {
        if (!cancelled) {
          onLoadError(error);
        }
      } finally {
        if (!cancelled && requestRef.current === request && !request.applied) {
          requestRef.current = null;
        }
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
    memoListRefreshTrigger,
    selectedNotebookId,
    setIsMemoListLoading,
    setLoadedMemoListQueryKey,
    startupPhase,
  ]);

  return null;
}
