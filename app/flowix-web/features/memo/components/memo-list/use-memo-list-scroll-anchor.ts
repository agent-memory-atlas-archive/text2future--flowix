import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

type Anchor = { key: string; offset: number };

/** Keep visible cards at the same viewport offset across metadata/height changes.
 * Several candidates let deletion of the first visible card fall back to its
 * neighbor. A different query starts a new anchor scope.
 */
export function useMemoListScrollAnchor(
  scrollerRef: RefObject<HTMLDivElement | null>,
  queryKey: string | null,
  items: readonly unknown[],
) {
  const snapshot = useRef<{ queryKey: string | null; anchors: Anchor[] } | null>(null);
  const capture = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || scroller.clientHeight === 0) return;
    const rows = scroller.querySelector('[data-note-list-content]')?.children;
    if (!rows?.length) { snapshot.current = null; return; }
    const top = scroller.getBoundingClientRect().top;
    // Rows are ordered vertically. Avoid measuring every loaded card on scroll.
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (rows[middle].getBoundingClientRect().bottom <= top) low = middle + 1;
      else high = middle;
    }
    const anchors: Anchor[] = [];
    for (let index = low; index < rows.length; index += 1) {
      const row = rows[index];
      const rect = row.getBoundingClientRect();
      const key = row.getAttribute('data-note-path');
      if (key) anchors.push({ key, offset: rect.top - top });
      if (rect.top >= top + scroller.clientHeight) break;
    }
    snapshot.current = { queryKey, anchors };
  }, [queryKey, scrollerRef]);

  const restore = useCallback(() => {
    const scroller = scrollerRef.current;
    const previous = snapshot.current;
    if (!scroller || !previous || previous.queryKey !== queryKey || scroller.clientHeight === 0) return;
    const rows = scroller.querySelector('[data-note-list-content]')?.children;
    if (!rows) return;
    const byKey = new Map(Array.from(rows, row => [row.getAttribute('data-note-path'), row]));
    for (const anchor of previous.anchors) {
      const row = byKey.get(anchor.key);
      if (!row) continue;
      const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
      break;
    }
  }, [queryKey, scrollerRef]);

  useLayoutEffect(() => {
    restore();
    capture();
  });

  useLayoutEffect(() => {
    const content = scrollerRef.current?.querySelector('[data-note-list-content]');
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { restore(); capture(); });
    observer.observe(content);
    return () => observer.disconnect();
  }, [items, queryKey, scrollerRef, restore, capture]);

  return capture;
}
