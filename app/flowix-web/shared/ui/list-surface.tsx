'use client';

import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CenteredLoadingSpinner } from '@shared/ui/centered-loading-spinner';

/** Shared flexible viewport used by list surfaces in the middle column. */
export function ListSurfaceViewport({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      {children}
    </div>
  );
}

/** Initial-load state shared by notes, trees, and conversation lists. */
export function ListSurfaceLoadingState({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <CenteredLoadingSpinner
      className={cn('h-full w-full', className)}
      ariaLabel={label}
      label={label}
    />
  );
}

/** Compact ring spinner using the editor loading indicator's visual treatment. */
export function ListSurfaceSpinner({
  className,
  ariaLabel,
}: {
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <span
      className={cn(
        'shrink-0 animate-spin rounded-full border-2 border-[color-mix(in_oklch,var(--muted-foreground)_26%,transparent)] border-t-[var(--brand)]',
        className,
      )}
      role={ariaLabel ? 'status' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    />
  );
}

/** Compact progress row for pagination and other in-place loads. */
export function ListSurfaceInlineLoadingState({
  label,
  className,
  style,
}: {
  label: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-center gap-2 px-2 py-2 text-xs text-[var(--muted-foreground)]',
        className,
      )}
      style={style}
      role="status"
      aria-live="polite"
    >
      <ListSurfaceSpinner className="h-3.5 w-3.5" />
      <span>{label}</span>
    </div>
  );
}
