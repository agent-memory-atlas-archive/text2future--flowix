import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { createLogger } from '@/lib/logger';
import { joinNotebookMemoPath } from '@/lib/path';
import { noteRepository } from '@features/memo/services/note-repository';
import { registerMemoEventHandler } from '@/lib/memo-dispatcher';
import type { DocTreeItem, NoteEntry } from '@platform/tauri/client';
import { mergeNoteMetadata, noteMetadata, subscribeNotebookMetadata } from '../services/note-metadata-service';

const logger = createLogger('notebook-pinned-notes');
const EMPTY_PINNED_ITEMS: DocTreeItem[] = [];
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
  const pageIndexRef = useRef(pageIndex);
  pageIndexRef.current = pageIndex;
  const metadataRevision = useSyncExternalStore(noteMetadata.subscribeAll, noteMetadata.checkpoint, noteMetadata.checkpoint);
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestSequence = useRef(0);
  const loadingMoreRef = useRef(false);
  const loadedScope = useRef<{ notebookId: string; notebookPath: string } | null>(null);
  const [changeRevision, setChangeRevision] = useState(0);

  const toPinnedItems = useCallback((notes: NoteEntry[], path: string, checkpoint: number): DocTreeItem[] => notes.flatMap((note) => {
    const relativePath = note.relativePath.replace(/\\/g, '/');
    const fullPath = joinNotebookMemoPath(path, relativePath);
    if (!fullPath) return [];
    const metadata = mergeNoteMetadata(fullPath, note, checkpoint);
    if (!metadata?.favorited) return [];
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
      memoMeta: metadata,
    }];
  }), []);

  useEffect(() => {
    if (!notebookId) return;
    return subscribeNotebookMetadata({ notebookId, notebookPath }, ({ change, favoriteChanged }) => {
      if (change?.kind === 'resource-updated') {
        // Cache coverage is unrelated to membership. New senders supply the
        // previous pin state; legacy events use the shared projection baseline.
        if (favoriteChanged === true || (favoriteChanged === null && change.entry.favorited)) {
          setChangeRevision((revision) => revision + 1);
        }
      } else if (!change || change.kind !== 'resource-created' || change.source === 'external_tool') {
        setChangeRevision((revision) => revision + 1);
      }
    });
  }, [notebookId, notebookPath]);

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
    const sameScope = loadedScope.current?.notebookId === notebookId && loadedScope.current.notebookPath === notebookPath;
    const targetPage = sameScope ? pageIndexRef.current : 0;
    if (!sameScope) {
      setPages([]);
      setPageIndex(0);
    }
    let cancelled = false;
    const sequence = ++requestSequence.current;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setLoadingInitial(true);

    void (async () => {
      const nextPages: PinnedNotePage[] = [];
      let cursor: string | undefined;
      // Recovery and uncertain legacy events reconcile the existing page window
      // instead of silently moving the user back to the first page.
      for (let index = 0; index <= targetPage; index++) {
        const checkpoint = noteMetadata.checkpoint();
        const page = await noteRepository.listByPath({
          notebookId, filter: 'favorited', sort: 'updatedAt',
          limit: PINNED_NOTES_PAGE_SIZE, ...(cursor ? { cursor } : {}),
        });
        if (cancelled || sequence !== requestSequence.current) return;
        cursor = page.nextCursor ?? undefined;
        nextPages.push({ nextCursor: cursor, hasMore: page.hasMore && Boolean(cursor),
          items: toPinnedItems(page.notes, notebookPath, checkpoint) });
        if (!page.hasMore || !cursor) break;
      }
      setPages(nextPages);
      setPageIndex(Math.min(targetPage, nextPages.length - 1));
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
    const checkpoint = noteMetadata.checkpoint();
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
      const items = toPinnedItems(page.notes, notebookPath, checkpoint);
      setPages((current) => [...current.slice(0, nextIndex), {
        nextCursor: cursor,
        hasMore: page.hasMore && Boolean(cursor),
        items,
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

  const pinnedItems = useMemo(() => (currentPage?.items ?? EMPTY_PINNED_ITEMS).flatMap((item) => {
    const snapshot = noteMetadata.get(item.fullPath);
    if (snapshot.status === 'deleted' || snapshot.value?.favorited === false) return [];
    return [snapshot.value ? { ...item, memoMeta: snapshot.value } : item];
  }), [currentPage?.items, metadataRevision]);

  return {
    pinnedItems,
    hasPrevious,
    hasMore,
    loadingInitial,
    loadingMore,
    loadPrevious,
    loadMore,
    removePinnedItem,
  };
}
