/** Lightweight gallery surface shown while the media library renderer loads. */
export function MediaLibraryLoadingSkeleton() {
  const columns = [
    ['h-56', 'h-40', 'h-64'],
    ['h-40', 'h-64', 'h-48'],
    ['h-64', 'h-48', 'h-56'],
    ['h-48', 'h-56', 'h-40'],
  ];
  return <div aria-label="媒体库预览" aria-busy="true" className="flex h-full min-h-0 flex-col overflow-auto px-5 pb-4">
    <div className="multidimensional-table__view-nav -mx-5 flex shrink-0 items-center justify-between gap-3 px-4" aria-hidden="true">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="h-5 w-5 shrink-0 animate-pulse rounded bg-[var(--muted)]" />
        <span className="h-4 w-28 max-w-full animate-pulse rounded bg-[var(--muted)]" />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="h-3 w-12 animate-pulse rounded bg-[var(--muted)]" />
        <span className="h-7 w-7 animate-pulse rounded-lg bg-[var(--muted)]" />
        <span className="h-7 w-7 animate-pulse rounded-lg bg-[var(--muted)]" />
      </div>
    </div>
    <div className="flex min-h-0 flex-1 items-start gap-2" aria-hidden="true">
      {columns.map((heights, column) => <div key={column} className={`min-w-0 flex-1 flex-col gap-2 ${column === 2 ? 'hidden sm:flex' : column === 3 ? 'hidden lg:flex' : 'flex'}`}>
        {heights.map((height, card) => <div key={card} className={`${height} w-full animate-pulse rounded-md bg-[var(--muted)]`} />)}
      </div>)}
    </div>
  </div>;
}
