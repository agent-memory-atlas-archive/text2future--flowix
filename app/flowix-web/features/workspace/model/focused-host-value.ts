import type { WorkspaceSurfaceHost } from './surface-contract';

/**
 * Pick the focused host's value first, then fall back to the other one.
 *
 * Both visible hosts can show a different document/conversation at the same
 * time. "What is the user looking at" is the focus, so selection, highlight and
 * unread markers all resolve through this single rule instead of each surface
 * re-deriving it.
 */
export function pickFocusedHostValue(input: {
  focusedHostId: WorkspaceSurfaceHost;
  /** Value contributed by the Work column. */
  work: string | null;
  /** Value contributed by the Browser column. */
  browser: string | null;
}): string | null {
  return input.focusedHostId === 'browser-column'
    ? input.browser ?? input.work
    : input.work ?? input.browser;
}
