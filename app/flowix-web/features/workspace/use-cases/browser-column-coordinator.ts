import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { getWorkspaceSurfaceLifecycle } from '@features/workspace/public/surface-lifecycle-api';

import { createLogger } from '@/lib/logger';
const logger = createLogger('workspace:browser-column');
let navigationChain: Promise<unknown> = Promise.resolve();

export async function flushActiveBrowserColumnDocument(
  options?: { silent?: boolean },
): Promise<boolean> {
  const surfaceId = useBrowserColumnStore.getState().current?.id;
  const lifecycle = surfaceId ? getWorkspaceSurfaceLifecycle(surfaceId) : null;
  if (lifecycle?.status === 'ready' && lifecycle.flush) {
    try {
      return await lifecycle.flush(options);
    } catch (error) {
      logger.error('Failed to flush active surface lifecycle', { error });
      return false;
    }
  }
  return true;
}

/** False means this editor cannot discard and must still cross its flush barrier. */
export function discardActiveBrowserColumnDocument(): boolean {
  const surfaceId = useBrowserColumnStore.getState().current?.id;
  const lifecycle = surfaceId ? getWorkspaceSurfaceLifecycle(surfaceId) : null;
  if (lifecycle?.status === 'ready' && lifecycle.discard) {
    lifecycle.discard();
    return true;
  }
  if (lifecycle?.flush) return false;
  return true;
}

/**
 * Serialize every operation which can replace or unmount the current surface.
 * `null` means the operation was rejected because the active editor could not
 * be flushed; callers must leave the current surface intact in that case.
 */
export function enqueueBrowserColumnNavigation<T>(
  operation: () => T | Promise<T>,
  options: { flush?: boolean; silentFlush?: boolean } = {},
): Promise<T | null> {
  const run = navigationChain
    .catch(() => undefined)
    .then(async () => {
      if (options.flush !== false
        && !await flushActiveBrowserColumnDocument({ silent: options.silentFlush })) return null;
      return await operation();
    });
  navigationChain = run.catch(() => undefined);
  return run;
}

export function activateBrowserColumnEntry(surfaceId: string): Promise<boolean | null> {
  return enqueueBrowserColumnNavigation(() => {
    const state = useBrowserColumnStore.getState();
    if (state.current?.id !== surfaceId) return false;
    state.focusContent(surfaceId);
    return true;
  });
}

export function resetBrowserColumnCoordinator(): void {
  navigationChain = Promise.resolve();
}
