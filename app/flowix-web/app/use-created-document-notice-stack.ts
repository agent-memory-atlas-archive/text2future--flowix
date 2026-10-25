import { useCallback, useState, type CSSProperties } from 'react';
import type { CreatedDocumentNotice } from './created-document-notices';

export const NOTICE_PAGE_SIZE = 20;
const STACK_GAP_PX = 8;
const ESTIMATED_CARD_HEIGHT_PX = 82;
const STACK_DEPTH = 2;
const STACK_SCALE_STEP = 0.04;

export function useCreatedDocumentNoticeStack(notices: CreatedDocumentNotice[], expanded: boolean) {
  const [heights, setHeights] = useState<Record<string, number>>({});
  const onHeight = useCallback((id: string, height: number | null) => {
    setHeights((current) => {
      if (height === null) {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      }
      if (current[id] === height) return current;
      return { ...current, [id]: height };
    });
  }, []);
  let totalHeight = 0;
  const offsets = notices.map((notice) => {
    const offset = totalHeight;
    totalHeight += (heights[notice.id] || ESTIMATED_CARD_HEIGHT_PX) + STACK_GAP_PX;
    return offset;
  });
  const stackHeight = !notices.length ? 0 : expanded
    ? totalHeight - STACK_GAP_PX
    : (heights[notices[0].id] || ESTIMATED_CARD_HEIGHT_PX) + Math.min(notices.length - 1, STACK_DEPTH) * STACK_GAP_PX;
  const cardStyle = (index: number): CSSProperties => ({
    '--notice-offset': `${expanded ? offsets[index] : Math.min(index, STACK_DEPTH) * STACK_GAP_PX}px`,
    '--notice-scale': expanded ? 1 : 1 - Math.min(index, STACK_DEPTH) * STACK_SCALE_STEP,
    opacity: expanded || index <= STACK_DEPTH ? 1 : 0,
    zIndex: notices.length - index,
  } as CSSProperties);
  return { stackHeight, cardStyle, onHeight };
}
