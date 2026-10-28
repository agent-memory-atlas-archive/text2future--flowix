import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveBrowserColumnLayout } from '@features/shell/hooks/browser-column-layout';
import { useResizablePanels } from '@features/shell/hooks/use-resizable-panels';

export type NoteNavigationDrawerPhase = 'closed' | 'open' | 'closing';

// Slightly longer than --flowix-motion-duration (180ms, see styles/index.css)
// so the flag outlives the transition even if a frame is dropped. Kept local:
// this is a layout-sync signal, not a shared motion token.
const MEMO_LIST_ANIMATION_MS = 200;

interface MainPanelControllerOptions {
  browserColumnSplitRatio: number;
  documentPanelMinWidth: number;
  memoListVisible: boolean;
  noteNavigationVisible: boolean;
  setBrowserColumnSplitRatio(ratio: number): void;
  setMemoListVisible(visible: boolean): void;
  setNoteNavigationVisible(visible: boolean): void;
}

export function useMainPanelController({
  browserColumnSplitRatio,
  documentPanelMinWidth,
  memoListVisible,
  noteNavigationVisible,
  setBrowserColumnSplitRatio,
  setMemoListVisible,
  setNoteNavigationVisible,
}: MainPanelControllerOptions) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [noteNavigationPhase, setNoteNavigationPhase] = useState<NoteNavigationDrawerPhase>(
    () => noteNavigationVisible ? 'open' : 'closed',
  );

  // The persisted boolean is the semantic setting. The phase is transient
  // layout state used to synchronize the drawer with the list preview.
  useEffect(() => {
    if (noteNavigationVisible && noteNavigationPhase === 'closed') {
      setNoteNavigationPhase('open');
    } else if (!noteNavigationVisible && noteNavigationPhase === 'open') {
      setNoteNavigationPhase('closed');
    }
  }, [noteNavigationPhase, noteNavigationVisible]);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const {
    resizeMemoList,
    setIsDraggingListDivider,
    isDraggingListDivider,
    isMemoListHidden,
    memoColWidth,
    memoListWidth,
  } = useResizablePanels({
    documentPanelMinWidth,
    layoutWidth: viewportWidth,
    memoListVisible,
    noteNavigationWidth: 0,
  });

  // True while the memo list is mid-collapse/expand. Consumers use this to
  // gate transitions on the sibling columns so their widths interpolate in
  // lockstep with ListColumn's animated width — otherwise the flex row
  // overflows the container for the duration of the transition and
  // overflow-x-auto flashes a horizontal scrollbar.
  const [isMemoListAnimating, setIsMemoListAnimating] = useState(false);
  const memoListAnimateTimerRef = useRef<number | null>(null);
  const hasSeenInitialMemoListVisible = useRef(false);
  useEffect(() => {
    if (!hasSeenInitialMemoListVisible.current) {
      hasSeenInitialMemoListVisible.current = true;
      return;
    }
    setIsMemoListAnimating(true);
    if (memoListAnimateTimerRef.current !== null) {
      window.clearTimeout(memoListAnimateTimerRef.current);
    }
    memoListAnimateTimerRef.current = window.setTimeout(() => {
      memoListAnimateTimerRef.current = null;
      setIsMemoListAnimating(false);
    }, MEMO_LIST_ANIMATION_MS);
  }, [memoListVisible]);
  useEffect(() => () => {
    if (memoListAnimateTimerRef.current !== null) {
      window.clearTimeout(memoListAnimateTimerRef.current);
      memoListAnimateTimerRef.current = null;
    }
  }, []);

  const browserColumnLayout = resolveBrowserColumnLayout({
    viewportWidth,
    noteNavigationWidth: 0,
    memoListWidth,
    memoListVisible: !isMemoListHidden,
    dividerCount: !isMemoListHidden ? 1 : 0,
    splitRatio: browserColumnSplitRatio,
  });
  const browserColumnLayoutKey = [
    viewportWidth,
    memoListWidth,
    browserColumnLayout.mainColumnWidth,
    browserColumnLayout.browserColumnWidth,
    isMemoListHidden ? 'memo-hidden' : 'memo-visible',
  ].join(':');

  const handleBrowserColumnResize = useCallback((nextWidth: number) => {
    if (!browserColumnLayout.canSplit || browserColumnLayout.availableDocumentWidth <= 0) return;
    setBrowserColumnSplitRatio(nextWidth / browserColumnLayout.availableDocumentWidth);
  }, [
    browserColumnLayout.availableDocumentWidth,
    browserColumnLayout.canSplit,
    setBrowserColumnSplitRatio,
  ]);

  const openNoteNavigation = useCallback(() => {
    setNoteNavigationPhase('open');
    setNoteNavigationVisible(true);
  }, [setNoteNavigationVisible]);
  const closeNoteNavigation = useCallback(() => {
    if (!noteNavigationVisible || noteNavigationPhase === 'closing') return;
    // Start the drawer and list transitions in the same render.
    setNoteNavigationPhase('closing');
    setNoteNavigationVisible(false);
  }, [noteNavigationPhase, noteNavigationVisible, setNoteNavigationVisible]);
  const completeNoteNavigationClose = useCallback(() => {
    setNoteNavigationPhase('closed');
  }, []);
  const handleToggleNoteNavigation = useCallback(() => {
    if (noteNavigationVisible) closeNoteNavigation();
    else openNoteNavigation();
  }, [closeNoteNavigation, noteNavigationVisible, openNoteNavigation]);
  const collapseMemoList = useCallback(() => {
    setMemoListVisible(false);
  }, [setMemoListVisible]);
  const handleToggleMemoList = useCallback(() => {
    const nextVisible = !memoListVisible;
    setMemoListVisible(nextVisible);
    if (!nextVisible && noteNavigationVisible) closeNoteNavigation();
  }, [closeNoteNavigation, memoListVisible, noteNavigationVisible, setMemoListVisible]);

  return {
    browserColumnLayout,
    browserColumnLayoutKey,
    collapseMemoList,
    handleBrowserColumnResize,
    resizeMemoList,
    setIsDraggingListDivider,
    handleToggleMemoList,
    handleToggleNoteNavigation,
    openNoteNavigation,
    closeNoteNavigation,
    completeNoteNavigationClose,
    isDraggingListDivider,
    isMemoListAnimating,
    isMemoListHidden,
    memoColWidth,
    memoListWidth,
    noteNavigationPhase,
  };
}
