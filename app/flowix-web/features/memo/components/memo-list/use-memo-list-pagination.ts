import { useCallback, useLayoutEffect, type RefObject, type UIEvent } from 'react';

const MIN_LOAD_MORE_THRESHOLD_PX = 720;
const LOAD_MORE_VIEWPORT_MULTIPLIER = 2;

interface MemoListPaginationOptions {
  itemCount: number;
  loading: boolean;
  hasMorePages: boolean;
  loadingMorePages: boolean;
  loadMorePages: () => void;
  scrollerRef: RefObject<HTMLDivElement | null>;
  isActive: boolean;
}

/** Requests more of the backend query before the visible window reaches its end. */
export function useMemoListPagination({
  itemCount,
  loading,
  hasMorePages,
  loadingMorePages,
  loadMorePages,
  scrollerRef,
  isActive,
}: MemoListPaginationOptions) {
  const loadWhenNearEnd = useCallback((scroller: HTMLDivElement | null) => {
    if (!isActive || loading || loadingMorePages || !hasMorePages || !scroller) return;
    const distanceToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    // Start fetching well before the user reaches the current page boundary.
    // Two viewports gives the backend time to respond during a fast fling,
    // while the floor preserves the previous buffer for short list panes.
    const threshold = Math.max(
      MIN_LOAD_MORE_THRESHOLD_PX,
      scroller.clientHeight * LOAD_MORE_VIEWPORT_MULTIPLIER,
    );
    if (distanceToBottom <= threshold) loadMorePages();
  }, [hasMorePages, isActive, loadMorePages, loading, loadingMorePages]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    loadWhenNearEnd(event.currentTarget);
  }, [loadWhenNearEnd]);

  // Continue filling short viewports and heavily filtered pages until there
  // is enough content to scroll or the backend has no more pages.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    loadWhenNearEnd(scroller);
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    // Both the viewport and the card stack can resize without a scroll event.
    const observer = new ResizeObserver(() => loadWhenNearEnd(scroller));
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, [itemCount, loadWhenNearEnd, scrollerRef]);

  return { onScroll };
}
