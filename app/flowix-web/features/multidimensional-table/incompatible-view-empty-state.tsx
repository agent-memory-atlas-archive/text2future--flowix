import type { ReactNode } from 'react';

/** Shared empty state for views whose configured fields don't fit the layout. */
export function IncompatibleViewEmptyState({ title, description, titleAction }: { title: string; description: string; titleAction?: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
    <div className="flex items-center justify-center gap-3">
      <div className="text-sm font-medium text-[var(--foreground)]">{title}</div>
      {titleAction}
    </div>
    <p className="max-w-md text-sm leading-6 text-[var(--muted-foreground)]">{description}</p>
  </div>;
}
