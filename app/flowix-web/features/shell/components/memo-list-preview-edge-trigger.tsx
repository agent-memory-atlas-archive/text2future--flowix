/**
 * Slim vertical trigger docked to the left edge of the detail column while the
 * memo list is collapsed. Hovering opens the floating list preview (via
 * onMouseEnter/onClick) instead of restoring the full column.
 */
export function MemoListPreviewEdgeTrigger({
  onTriggerEnter,
  onTriggerLeave,
  onPreviewOpen,
  ariaLabel,
  title,
}: {
  onTriggerEnter: () => void;
  onTriggerLeave: () => void;
  onPreviewOpen: () => void;
  ariaLabel: string;
  title: string;
}) {
  return (
    <button
      type="button"
      data-memo-list-preview-edge-trigger
      onMouseEnter={onTriggerEnter}
      onMouseLeave={onTriggerLeave}
      // Clicking the collapsed edge follows the hover interaction:
      // open the floating preview instead of restoring the full
      // list column.
      onClick={onPreviewOpen}
      aria-label={ariaLabel}
      title={title}
      className="group absolute bottom-0 left-0 top-0 z-[60] flex w-4 items-center justify-center text-[var(--muted-foreground)] opacity-30 transition-[color,opacity] duration-150 hover:text-[var(--foreground)] hover:opacity-50 focus-visible:outline-none focus-visible:text-[var(--brand)] focus-visible:opacity-100"
    >
      <span className="flex translate-x-0 flex-col items-center gap-[6px]" aria-hidden="true">
        <span className="h-1 w-1 rounded-full bg-current" />
        <span className="h-1 w-1 rounded-full bg-current" />
        <span className="h-1 w-1 rounded-full bg-current" />
      </span>
    </button>
  );
}
