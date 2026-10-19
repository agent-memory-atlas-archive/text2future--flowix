import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import { joinNotebookMemoPath } from '@/lib/path';
import { noteRepository } from '@features/memo/services/note-repository';
import { registerMemoEventHandler } from '@/lib/memo-dispatcher';
import type { DocTreeItem, NoteEntry } from '@platform/tauri/client';
import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';

const logger = createLogger('notebook-pinned-notes');
const PINNED_NOTES_PAGE_SIZE = 100;

interface PinnedNotePage {
  nextCursor?: string;
  hasMore: boolean;
  items: DocTreeItem[];
}

interface UseNotebookPinnedNotesOptions {
  notebookId: string | null;
  notebookPath: string;
  isActive: boolean;
  refreshTrigger: number;
}

export function useNotebookPinnedNotes({
  notebookId,
  notebookPath,
  isActive,
  refreshTrigger,
}: UseNotebookPinnedNotesOptions) {
  const [pages, setPages] = useState<PinnedNotePage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestSequence = useRef(0);
  const loadingMoreRef = useRef(false);
  const loadedScope = useRef<{ notebookId: string; notebookPath: string } | null>(null);
  const [changeRevision, setChangeRevision] = useState(0);

  const toPinnedItems = useCallback((notes: NoteEntry[], path: string): DocTreeItem[] => notes.flatMap((note) => {
    const relativePath = note.relativePath.replace(/\\/g, '/');
    const fullPath = joinNotebookMemoPath(path, relativePath);
    if (!fullPath) return [];
    return [{
      id: `pinned:${relativePath}`,
      fullPath,
      name: relativePath.split('/').pop() || relativePath,
      type: 'document' as const,
      parentId: null,
      children: null,
      sizeBytes: note.sizeBytes ?? null,
      modifiedMs: note.updatedAt,
      createdMs: note.createdAt,
      memoCreatedMs: note.createdAt,
      resourceKind: 'note' as const,
      memoMeta: {
        icon: note.icon,
        colors: note.colors,
        favorited: true,
      },
    }];
  }), []);

  useEffect(() => subscribeNotebookChanges((change) => {
    if (change.notebookId === notebookId
      && (change.kind !== 'resource-created' || change.source === 'external_tool')) {
      setChangeRevision((revision) => revision + 1);
    }
  }), [notebookId]);

  useEffect(() => registerMemoEventHandler((event) => {
    if (event.notebookId !== notebookId || event.kind === 'tags_renamed' || event.kind === 'tags_deleted') return;
    if (event.kind === 'deleted' || event.source === 'cloud_sync') {
      setChangeRevision((revision) => revision + 1);
    }
  }), [notebookId]);

  useEffect(() => {
    if (!isActive) return;
    if (!notebookId) {
      loadedScope.current = null;
      setPages([]);
      setPageIndex(0);
      setLoadingInitial(false);
      return;
    }
    if (loadedScope.current?.notebookId !== notebookId || loadedScope.current.notebookPath !== notebookPath) {
      setPages([]);
      setPageIndex(0);
    }
    let cancelled = false;
    const sequence = ++requestSequence.current;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setLoadingInitial(true);

    void (async () => {
      const page = await noteRepository.listByPath({
        notebookId,
        filter: 'favorited',
        sort: 'updatedAt',
        limit: PINNED_NOTES_PAGE_SIZE,
      });

      if (cancelled || sequence !== requestSequence.current) return;
      const cursor = page.nextCursor ?? undefined;
      setPages([{
        nextCursor: cursor,
        hasMore: page.hasMore && Boolean(cursor),
        items: toPinnedItems(page.notes, notebookPath),
      }]);
      setPageIndex(0);
      setLoadingInitial(false);
      loadedScope.current = { notebookId, notebookPath };
    })().catch((error) => {
      if (!cancelled) {
        logger.warn('failed to load pinned notes', { error, notebookPath });
        setLoadingInitial(false);
      }
    });

    return () => {
      cancelled = true;
      if (requestSequence.current === sequence) requestSequence.current += 1;
    };
  }, [isActive, notebookId, notebookPath, refreshTrigger, changeRevision, toPinnedItems]);

  const currentPage = pages[pageIndex];
  const hasPrevious = pageIndex > 0;
  const hasMore = pageIndex < pages.length - 1 || Boolean(currentPage?.hasMore && currentPage.nextCursor);

  const loadMore = useCallback(async () => {
    if (pageIndex < pages.length - 1) {
      setPageIndex(pageIndex + 1);
      return;
    }
    if (loadingInitial || !notebookId || !currentPage?.hasMore || !currentPage.nextCursor || loadingMoreRef.current) return;
    const sequence = requestSequence.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await noteRepository.listByPath({
        notebookId,
        filter: 'favorited',
        sort: 'updatedAt',
        cursor: currentPage.nextCursor,
        limit: PINNED_NOTES_PAGE_SIZE,
      });
      if (sequence !== requestSequence.current) return;
      const cursor = page.nextCursor ?? undefined;
      const nextIndex = pageIndex + 1;
      setPages((current) => [...current.slice(0, nextIndex), {
        nextCursor: cursor,
        hasMore: page.hasMore && Boolean(cursor),
        items: toPinnedItems(page.notes, notebookPath),
      }]);
      setPageIndex(nextIndex);
    } catch (error) {
      if (sequence === requestSequence.current) {
        logger.warn('failed to load more pinned notes', { error, notebookPath });
      }
    } finally {
      if (sequence === requestSequence.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [currentPage, loadingInitial, notebookId, pageIndex, pages.length, notebookPath, toPinnedItems]);

  const loadPrevious = useCallback(() => {
    setPageIndex((current) => Math.max(0, current - 1));
  }, []);

  const removePinnedItem = useCallback((itemId: string) => {
    setPages((current) => current.map((page) => ({
      ...page,
      items: page.items.filter((item) => item.id !== itemId),
    })));
  }, []);

  return {
    pinnedItems: currentPage?.items ?? [],
    hasPrevious,
    hasMore,
    loadingInitial,
    loadingMore,
    loadPrevious,
    loadMore,
    removePinnedItem,
  };
}
