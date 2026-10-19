import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { noteListItemKey, type NoteListItem } from '@/types/note-item';
import { useDynamicVirtualList } from '../../hooks/use-dynamic-virtual-list';

export type MemoRowKeepAliveChange = (item: NoteListItem, active: boolean) => void;

interface MemoListRowsProps {
  items: readonly NoteListItem[];
  scrollElement: HTMLDivElement | null;
  queryKey: string;
  renderRow: (item: NoteListItem, onKeepAliveChange: MemoRowKeepAliveChange) => ReactNode;
}

const ESTIMATED_ROW_HEIGHT = 112;
const estimateRowSize = () => ESTIMATED_ROW_HEIGHT;
const INITIAL_ROW_COUNT = 16;

/** Paging owns data; this component owns only row geometry and mounted rows. */
export function MemoListRows({ items, scrollElement, queryKey, renderRow }: MemoListRowsProps) {
  const scrollerRef = useMemo(() => ({ current: scrollElement }), [scrollElement]);
  const [keptAliveKeys, setKeptAliveKeys] = useState<readonly string[]>([]);
  const onKeepAliveChange = useCallback<MemoRowKeepAliveChange>((item, active) => {
    const key = noteListItemKey(item);
    setKeptAliveKeys((current) => {
      if (current.includes(key) === active) return current;
      return active ? [...current, key] : current.filter((candidate) => candidate !== key);
    });
  }, []);
  const { virtualItems, totalSize, getMeasureRef, isVirtualizationReady } = useDynamicVirtualList({
    items,
    getKey: noteListItemKey,
    estimateSize: estimateRowSize,
    scrollerRef,
    resetKey: queryKey,
    enabled: true,
    keepAliveKeys: keptAliveKeys,
    preserveScrollAnchor: true,
    scrollMargin: 8, // The scroller's py-2 precedes this list.
  });
  // A hidden pane has no measurable viewport. Avoid mounting the entire list
  // while waiting for its first usable rectangle.
  const mountedRows = isVirtualizationReady ? virtualItems : virtualItems.slice(0, INITIAL_ROW_COUNT);
  return <div className="relative min-w-0 w-full" style={{
    height: isVirtualizationReady ? totalSize : items.length * ESTIMATED_ROW_HEIGHT,
    overflowAnchor: 'none',
  }}>
    {mountedRows.map(({ key, index, item, start }) => <div
      key={key}
      ref={getMeasureRef(key)}
      data-index={index}
      className="absolute left-0 top-0 min-w-0 w-full"
      style={{ transform: `translateY(${start}px)` }}
    >{renderRow(item, onKeepAliveChange)}</div>)}
  </div>;
}
