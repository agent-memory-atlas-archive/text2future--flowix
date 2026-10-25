import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { useWorkspaceFocusStore } from '../store/workspace-focus-store';

export { openWorkspaceSurface } from './open-surface-api';
export type { OpenWorkspaceSurfaceRequest, BrowserWorkspaceSurfaceRequest } from './open-surface-api';
export { createFileBrowserTarget, removeBrowserColumnContentByPath, selectBrowserColumnFile, navigateBrowserColumnHistory } from '../use-cases/browser-column-navigation';
export { openBrowserColumnContentInWorkColumn } from '../use-cases/surface-opening';
export { canOpenBrowserColumnTargetInWorkColumn } from '../store/browser-column-store';
export type { BrowserColumnEntry, BrowserColumnTarget } from '../store/browser-column-store';
export { closeBrowserColumnContent, clearBrowserColumnSession } from '../use-cases/browser-column-closing';

export function useBrowserColumnViewModel() {
  return useBrowserColumnStore(useShallow((state) => ({
    current: state.current,
    webRuntime: state.webRuntime,
    canNavigateBack: state.backStack.length > 0,
    canNavigateForward: state.forwardStack.length > 0,
  })));
}

export function useBrowserColumnFocusViewModel() {
  const isFocused = useWorkspaceFocusStore((state) => state.focusedHostId === 'browser-column');
  const focusHost = useWorkspaceFocusStore((state) => state.focusHost);
  const focusBrowserColumn = useCallback(() => focusHost('browser-column'), [focusHost]);
  return { isFocused, focusBrowserColumn };
}

export function hideBrowserColumn(): void {
  useBrowserColumnStore.getState().setVisible(false);
}

export function useBrowserColumnVisible(): boolean {
  return useBrowserColumnStore((state) => state.visible);
}

export function toggleBrowserColumn(): void {
  const state = useBrowserColumnStore.getState();
  state.setVisible(!state.visible);
}
