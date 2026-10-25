import { useBrowserColumnStore } from '../store/browser-column-store';
import { discardActiveBrowserColumnDocument, enqueueBrowserColumnNavigation, flushActiveBrowserColumnDocument } from './browser-column-coordinator';

type CloseOptions = { discardChanges?: boolean };

/** Evaluate the current surface and its save barrier within one navigation transaction. */
function closeContent(surfaceId: string | null, clearHistory: boolean, options?: CloseOptions): Promise<boolean | null> {
  return enqueueBrowserColumnNavigation(async () => {
    const state = useBrowserColumnStore.getState();
    if (surfaceId !== null && state.current?.id !== surfaceId) return true;
    const discarded = options?.discardChanges && discardActiveBrowserColumnDocument();
    if (!discarded && !await flushActiveBrowserColumnDocument({ silent: true })) return null;
    if (clearHistory) state.clearSession();
    else state.clearContent();
    return true;
  }, { flush: false });
}

export function closeBrowserColumnContent(surfaceId: string, options?: CloseOptions) {
  return closeContent(surfaceId, false, options);
}

export function clearBrowserColumnSession(options?: CloseOptions) {
  return closeContent(null, true, options);
}
