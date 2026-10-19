import { useEffect, useRef, useState } from 'react';

/** Gallery-card placeholder used while the work-document surface is loading. */
export function WorkDocumentsLoadingSkeleton({ showHeader = true }: { showHeader?: boolean }) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(1);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const updateColumnCount = () => {
      const nextColumnCount = Math.max(1, Math.floor((grid.clientWidth + 14) / 214));
      setColumnCount((current) => current === nextColumnCount ? current : nextColumnCount);
    };

    updateColumnCount();
    const observer = new ResizeObserver(updateColumnCount);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  const placeholderClass = 'animate-pulse rounded';
  const placeholderStyle = {
    backgroundColor: 'color-mix(in srgb, var(--muted) 70%, var(--background))',
  };

  return <div aria-label="工作文档列表加载中" aria-busy="true" className="flex h-full min-h-0 flex-col overflow-auto px-5 pb-4">
    {showHeader && <div className="multidimensional-table__view-nav -mx-5 flex shrink-0 items-center justify-between gap-3 px-4" aria-hidden="true">
      <div className="flex min-w-0 flex-1 items-center gap-2 py-1">
        <span className={`h-5 w-5 shrink-0 ${placeholderClass}`} style={placeholderStyle} />
        <span className={`h-4 w-28 max-w-full ${placeholderClass}`} style={placeholderStyle} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={`h-3 w-12 ${placeholderClass}`} style={placeholderStyle} />
        <span className="h-7 w-7 animate-pulse rounded-lg" style={placeholderStyle} />
      </div>
    </div>}
    <div ref={gridRef} className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] items-stretch gap-3.5 pt-3" aria-hidden="true">
      {Array.from({ length: columnCount * 2 }, (_, index) => <div key={index} className="h-[210px] min-w-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
        <div className={`h-[148px] border-b border-[var(--border)] ${placeholderClass}`} style={placeholderStyle} />
        <div className="space-y-2 px-3 py-3">
          <div className={`h-3.5 w-3/4 ${placeholderClass}`} style={placeholderStyle} />
          <div className={`h-2.5 w-1/2 ${placeholderClass}`} style={placeholderStyle} />
        </div>
      </div>)}
    </div>
  </div>;
}
