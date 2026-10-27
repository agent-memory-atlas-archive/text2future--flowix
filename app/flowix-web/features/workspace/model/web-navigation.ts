import type { WorkspaceWebRuntime } from './surface-contract';

export function createWorkspaceWebRuntime(url: string): WorkspaceWebRuntime {
  return { currentUrl: url, history: [url], historyIndex: 0, reloadToken: 0, isLoading: true, error: null };
}

/** Address is already normalized by the navigation caller. */
export function navigateWorkspaceWebRuntime(current: WorkspaceWebRuntime, url: string): WorkspaceWebRuntime {
  const history = current.history.slice(0, current.historyIndex + 1);
  if (history[history.length - 1] !== url) history.push(url);
  return { ...current, currentUrl: url, history, historyIndex: history.length - 1,
    reloadToken: current.reloadToken + 1, isLoading: true, error: null };
}

/** Automatic redirects replace the current entry so Back can leave the page. */
export function replaceWorkspaceWebRuntimeUrl(current: WorkspaceWebRuntime, url: string): WorkspaceWebRuntime {
  const history = [...current.history];
  history[current.historyIndex] = url;
  return { ...current, currentUrl: url, history,
    reloadToken: current.reloadToken + 1, isLoading: true, error: null };
}

export function moveWorkspaceWebHistory(current: WorkspaceWebRuntime, direction: -1 | 1): WorkspaceWebRuntime | null {
  const historyIndex = current.historyIndex + direction;
  if (historyIndex < 0 || historyIndex >= current.history.length) return null;
  return { ...current, currentUrl: current.history[historyIndex], historyIndex,
    reloadToken: current.reloadToken + 1, isLoading: true, error: null };
}

export function reloadWorkspaceWebRuntime(current: WorkspaceWebRuntime): WorkspaceWebRuntime {
  return { ...current, reloadToken: current.reloadToken + 1, isLoading: true, error: null };
}
