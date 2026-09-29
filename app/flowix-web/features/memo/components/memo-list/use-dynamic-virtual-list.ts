import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type UIEvent,
} from 'react';

const DEFAULT_OVERSCAN = 8;
const MIN_ITEM_SIZE = 1;

export interface DynamicVirtualItem<T> {
  key: string;
  index: number;
  item: T;
  start: number;
  size: number;
}

interface DynamicVirtualListOptions<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  estimateSize: (item: T, index: number) => number;
  scrollerRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  /** Changes when the row structure changes. */
  resetKey?: string;
  overscan?: number;
  keepAliveKeys?: readonly string[];
  /** Height of non-virtual content before this list in the same scroller. */
  scrollMargin?: number;
}

interface Layout<T> {
  offsets: number[];
  sizes: number[];
  totalSize: number;
  byKey: Map<string, { start: number; size: number }>;
  items: readonly T[];
}

interface Viewport {
  scrollTop: number;
  width: number;
  height: number;
}

function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.scrollTop === b.scrollTop && a.width === b.width && a.height === b.height;
}

interface ScrollAnchor {
  key: string;
  offset: number;
}

function firstIndexWhoseEndExceeds(
  offsets: readonly number[],
  sizes: readonly number[],
  target: number,
): number {
  let low = 0;
  let high = sizes.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] + sizes[middle] <= target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function firstIndexWhoseStartReaches(
  offsets: readonly number[],
  target: number,
): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Dynamic-height virtualizer for lists whose rows can change after mount.
 *
 * Rows start with a content-aware estimate, then ResizeObserver replaces that
 * estimate with the measured height. The scroll anchor is adjusted when a row
 * above the viewport changes, so image failures and text reflow do not make
 * the user's current position jump.
 */
export function useDynamicVirtualList<T>({
  items,
  getKey,
  estimateSize,
  scrollerRef,
  enabled,
  resetKey,
  overscan = DEFAULT_OVERSCAN,
  keepAliveKeys = [],
  scrollMargin = 0,
}: DynamicVirtualListOptions<T>) {
  const [layoutVersion, bumpLayoutVersion] = useState(0);
  const [viewport, setViewport] = useState<Viewport>({
    scrollTop: 0,
    width: 0,
    height: 0,
  });
  // A dynamic row cannot be virtualized safely while its containing width is
  // changing. During reflow the loaded prefix is rendered in normal document
  // flow until every mounted row has settled at the new width.
  const [isReflowing, setIsReflowing] = useState(true);
  const isReflowingRef = useRef(true);
  const sizeByKeyRef = useRef(new Map<string, number>());
  const itemKeyByNodeRef = useRef(new Map<Element, string>());
  const measureRefCacheRef = useRef(
    new Map<string, (element: HTMLDivElement | null) => void>(),
  );
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const layoutRef = useRef<Layout<T> | null>(null);
  const lastResetKeyRef = useRef(resetKey);
  const lastScrollerWidthRef = useRef<number | null>(null);
  const viewportFrameRef = useRef<number | null>(null);
  const pendingAnchorRef = useRef<ScrollAnchor | null>(null);

  const keyByIndex = useMemo(
    () => items.map((item) => getKey(item)),
    [getKey, items],
  );

  const captureScrollAnchor = useCallback((): ScrollAnchor | null => {
    const scroller = scrollerRef.current;
    const currentLayout = layoutRef.current;
    if (!scroller || !currentLayout || currentLayout.items.length === 0) return null;

    const index = Math.min(
      currentLayout.items.length - 1,
      Math.max(
        0,
        firstIndexWhoseEndExceeds(
          currentLayout.offsets,
          currentLayout.sizes,
          Math.max(0, scroller.scrollTop - scrollMargin),
        ),
      ),
    );
    const key = keyByIndex[index];
    if (!key) return null;
    return {
      key,
      offset: Math.max(0, scroller.scrollTop - scrollMargin) - currentLayout.offsets[index],
    };
  }, [keyByIndex, scrollMargin, scrollerRef]);

  const beginReflow = useCallback((preserveAnchor: boolean) => {
    if (!isReflowingRef.current) {
      pendingAnchorRef.current = preserveAnchor ? captureScrollAnchor() : null;
      isReflowingRef.current = true;
      setIsReflowing(true);
      sizeByKeyRef.current.clear();
    } else if (!preserveAnchor) {
      pendingAnchorRef.current = null;
      sizeByKeyRef.current.clear();
    }
    bumpLayoutVersion((version) => version + 1);
  }, [captureScrollAnchor]);

  const syncViewport = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const nextWidth = scroller.clientWidth;
    if (
      lastScrollerWidthRef.current !== null &&
      lastScrollerWidthRef.current !== nextWidth
    ) {
      // Width changes alter line wrapping and therefore the height of every
      // memo card. Reflow the loaded prefix while preserving the visible memo.
      beginReflow(true);
    }
    lastScrollerWidthRef.current = nextWidth;
    const nextViewport = {
      scrollTop: Math.max(0, scroller.scrollTop - scrollMargin),
      width: nextWidth,
      height: scroller.clientHeight,
    };
    setViewport((previous) =>
      sameViewport(previous, nextViewport) ? previous : nextViewport,
    );
  }, [beginReflow, scrollMargin, scrollerRef]);

  useLayoutEffect(() => {
    if (lastResetKeyRef.current === resetKey) return;
    lastResetKeyRef.current = resetKey;
    pendingAnchorRef.current = null;
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    beginReflow(false);
  }, [beginReflow, resetKey, scrollerRef]);

  const scheduleViewportSync = useCallback(() => {
    if (viewportFrameRef.current !== null) return;
    if (
      typeof window === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function'
    ) {
      syncViewport();
      return;
    }
    viewportFrameRef.current = window.requestAnimationFrame(() => {
      viewportFrameRef.current = null;
      syncViewport();
    });
  }, [syncViewport]);

  useLayoutEffect(
    () => () => {
      if (viewportFrameRef.current !== null) {
        if (typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(viewportFrameRef.current);
        }
        viewportFrameRef.current = null;
      }
    },
    [],
  );

  const updateMeasuredSize = useCallback(
    (key: string, measuredSize: number) => {
      const scroller = scrollerRef.current;
      // A collapsed list has no meaningful wrapping width. Never retain a
      // height measured from that zero-width layout for the visible surface.
      if (scroller && scroller.clientWidth <= 0) return;
      const nextSize = Math.max(MIN_ITEM_SIZE, Math.ceil(measuredSize));
      const previousSize = sizeByKeyRef.current.get(key);
      if (previousSize !== undefined && Math.abs(previousSize - nextSize) < 1) {
        return;
      }

      const oldPosition = layoutRef.current?.byKey.get(key);
      if (
        oldPosition &&
        scroller &&
        !isReflowingRef.current &&
        oldPosition.start < Math.max(0, scroller.scrollTop - scrollMargin)
      ) {
        scroller.scrollTop += nextSize - (previousSize ?? oldPosition.size);
      }

      sizeByKeyRef.current.set(key, nextSize);
      bumpLayoutVersion((version) => version + 1);
    },
    [scrollMargin, scrollerRef],
  );

  // ResizeObserver is complemented by a synchronous layout read. This makes
  // reflow deterministic during a divider drag and avoids waiting for a
  // browser-specific observer delivery when a popup becomes measurable.
  useLayoutEffect(() => {
    if (!enabled || !isReflowing || typeof document === 'undefined') return;
    const scroller = scrollerRef.current;
    if (!scroller || scroller.clientWidth <= 0 || scroller.clientHeight <= 0) return;

    let changed = false;
    let allMounted = true;
    for (const key of keyByIndex) {
      const node = [...itemKeyByNodeRef.current.entries()]
        .find(([, currentKey]) => currentKey === key)?.[0];
      if (!node || !node.isConnected) {
        allMounted = false;
        continue;
      }
      const nextSize = Math.max(MIN_ITEM_SIZE, Math.ceil(node.getBoundingClientRect().height));
      if (sizeByKeyRef.current.get(key) !== nextSize) {
        sizeByKeyRef.current.set(key, nextSize);
        changed = true;
      }
    }

    if (changed) bumpLayoutVersion((version) => version + 1);
    if (allMounted && keyByIndex.length > 0) {
      isReflowingRef.current = false;
      setIsReflowing(false);
    }
  }, [enabled, isReflowing, keyByIndex, layoutVersion, scrollerRef]);

  useLayoutEffect(() => {
    if (!enabled || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const key = itemKeyByNodeRef.current.get(entry.target);
        if (!key) continue;
        updateMeasuredSize(key, entry.contentRect.height);
      }
    });
    resizeObserverRef.current = observer;
    for (const node of itemKeyByNodeRef.current.keys()) {
      observer.observe(node);
    }

    return () => {
      observer.disconnect();
      if (resizeObserverRef.current === observer) {
        resizeObserverRef.current = null;
      }
    };
  }, [enabled, updateMeasuredSize]);

  useLayoutEffect(() => {
    if (!enabled) return;
    syncViewport();
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(scheduleViewportSync);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scheduleViewportSync, scrollerRef, syncViewport]);

  const getMeasureRef = useCallback(
    (key: string) => {
      const cached = measureRefCacheRef.current.get(key);
      if (cached) return cached;

      const ref = (element: HTMLDivElement | null) => {
        const previousElement = [...itemKeyByNodeRef.current.entries()].find(
          ([, currentKey]) => currentKey === key,
        )?.[0];

        if (previousElement && previousElement !== element) {
          itemKeyByNodeRef.current.delete(previousElement);
          resizeObserverRef.current?.unobserve(previousElement);
        }

        if (!element) {
          if (previousElement) {
            resizeObserverRef.current?.unobserve(previousElement);
            itemKeyByNodeRef.current.delete(previousElement);
          }
          measureRefCacheRef.current.delete(key);
          return;
        }

        itemKeyByNodeRef.current.set(element, key);
        resizeObserverRef.current?.observe(element);
      };

      measureRefCacheRef.current.set(key, ref);
      return ref;
    },
    [],
  );

  const layout = useMemo<Layout<T>>(() => {
    const offsets: number[] = [];
    const sizes: number[] = [];
    const byKey = new Map<string, { start: number; size: number }>();
    let totalSize = 0;

    items.forEach((item, index) => {
      const key = keyByIndex[index];
      const estimate = Math.max(MIN_ITEM_SIZE, estimateSize(item, index));
      const size = sizeByKeyRef.current.get(key) ?? estimate;
      offsets.push(totalSize);
      sizes.push(size);
      byKey.set(key, { start: totalSize, size });
      totalSize += size;
    });

    return { offsets, sizes, totalSize, byKey, items };
  }, [estimateSize, items, keyByIndex, layoutVersion]);

  layoutRef.current = layout;

  const virtualItems = useMemo<DynamicVirtualItem<T>[]>(() => {
    if (!enabled) return [];
    if (layout.items.length === 0) return [];

    // A scroller can report a zero height during the first layout pass (for
    // example while a Tauri/WebKit column is being attached or restored from
    // a hidden tab).  The normal window calculation would then interpret the
    // viewport as containing no rows and return only `overscan + 1` items
    // (nine with the default overscan), leaving the rest of a short notebook
    // permanently absent if ResizeObserver does not deliver a follow-up
    // notification.  Until we have a usable viewport, render the loaded
    // prefix in full; the next measured viewport immediately restores normal
    // virtualization.  This also avoids losing notes in environments without
    // reliable element geometry during startup.
    if (
      !Number.isFinite(viewport.width) ||
      viewport.width <= 0 ||
      !Number.isFinite(viewport.height) ||
      viewport.height <= 0
    ) {
      return layout.items.map((item, index) => ({
        key: keyByIndex[index],
        index,
        item,
        start: layout.offsets[index],
        size: layout.sizes[index],
      }));
    }

    const extra = Math.max(0, Math.floor(overscan));
    const firstVisible = firstIndexWhoseEndExceeds(
      layout.offsets,
      layout.sizes,
      viewport.scrollTop,
    );
    const lastVisible = firstIndexWhoseStartReaches(
      layout.offsets,
      viewport.scrollTop + viewport.height,
    );
    const first = Math.max(0, firstVisible - extra);
    const last = Math.min(layout.items.length, lastVisible + extra + 1);
    const indexes = new Set<number>();
    for (let index = first; index < last; index += 1) indexes.add(index);

    for (const key of keepAliveKeys) {
      const index = keyByIndex.indexOf(key);
      if (index >= 0) indexes.add(index);
    }

    return [...indexes]
      .sort((a, b) => a - b)
      .map((index) => ({
        key: keyByIndex[index],
        index,
        item: layout.items[index],
        start: layout.offsets[index],
        size: layout.sizes[index],
      }));
  }, [enabled, keepAliveKeys, keyByIndex, layout, overscan, viewport]);

  useLayoutEffect(() => {
    if (isReflowing || !pendingAnchorRef.current) return;
    const scroller = scrollerRef.current;
    const currentLayout = layoutRef.current;
    const anchor = pendingAnchorRef.current;
    const position = currentLayout?.byKey.get(anchor.key);
    if (!scroller || !position) return;

    scroller.scrollTop = Math.max(0, scrollMargin + position.start + anchor.offset);
    pendingAnchorRef.current = null;
    syncViewport();
  }, [isReflowing, layoutVersion, scrollMargin, scrollerRef, syncViewport]);

  const onScroll = useCallback(
    (_event: UIEvent<HTMLDivElement>) => {
      if (!enabled) return;
      scheduleViewportSync();
    },
    [enabled, scheduleViewportSync],
  );

  useLayoutEffect(() => {
    // A query/filter change can leave the browser's scrollTop past the new
    // content. Clamp it without changing the user's position for normal row
    // measurements.
    const scroller = scrollerRef.current;
    if (!scroller || !enabled) return;
    const maxScrollTop = Math.max(0, scrollMargin + layout.totalSize - scroller.clientHeight);
    if (scroller.scrollTop > maxScrollTop) {
      scroller.scrollTop = maxScrollTop;
      syncViewport();
    }
  }, [enabled, layout.totalSize, scrollMargin, scrollerRef, syncViewport]);

  return {
    totalSize: enabled ? layout.totalSize : 0,
    virtualItems,
    isVirtualizationReady:
      enabled &&
      !isReflowing &&
      viewport.width > 0 &&
      viewport.height > 0,
    getMeasureRef,
    onScroll,
  };
}
