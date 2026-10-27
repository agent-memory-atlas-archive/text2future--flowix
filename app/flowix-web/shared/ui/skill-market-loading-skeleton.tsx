import { useI18n } from '@/lib/i18n';
import { useEffect, useRef, useState } from 'react';

/** Matches the Skill Market's container breakpoints and card geometry. */
export function SkillMarketLoadingSkeleton() {
  const { language } = useI18n();
  const gridRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const update = () => {
      const width = grid.clientWidth;
      setColumns(width >= 980 ? 4 : width >= 680 ? 3 : width >= 380 ? 2 : 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);
  const block = 'animate-pulse rounded bg-[var(--muted)] motion-reduce:animate-none';
  return <div role="status" aria-label={language === 'en-US' ? 'Loading Skill Market' : '技能市场加载中'} aria-busy="true" className="h-full overflow-hidden bg-[var(--document-bg)] px-[26px] pb-12 pt-3 max-[680px]:px-[14px]">
    <div aria-hidden="true" className="mb-5 flex h-10 items-center gap-1 overflow-hidden">
      {[64, 80, 72, 80].map((width, index) => <div key={index} className={`h-8 shrink-0 ${block}`} style={{ width }} />)}
      <div className="ml-auto flex shrink-0 gap-2"><div className={`h-7 w-7 rounded-full ${block}`} /><div className={`h-7 w-7 rounded-full ${block}`} /></div>
    </div>
    <div aria-hidden="true" className={`mb-4 h-10 w-full ${block}`} />
    <div ref={gridRef} aria-hidden="true" className="grid gap-4 max-[680px]:gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {Array.from({ length: 9 }, (_, index) => <div key={index} className="flex h-[180px] min-w-0 flex-col rounded-[22px] border border-[var(--border)] bg-[var(--card)] px-6 pb-[18px] pt-[22px] max-[680px]:px-[18px]">
        <div className="flex items-center gap-4"><div className={`h-[42px] w-[42px] shrink-0 rounded-xl ${block}`} /><div className={`h-3.5 w-1/2 ${block}`} /></div>
        <div className="my-3.5 space-y-2"><div className={`h-3 w-full ${block}`} /><div className={`h-3 w-4/5 ${block}`} /></div>
        <div className="mt-auto flex gap-1.5"><div className={`h-[26px] w-12 ${block}`} /><div className={`h-[26px] w-16 ${block}`} /></div>
      </div>)}
    </div>
  </div>;
}
