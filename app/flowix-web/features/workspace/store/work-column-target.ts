import type { FileBrowserContext } from './file-browser-target';
import type { PluginDescriptor } from '@platform/tauri/client';

/**
 * The stable target currently owned by the workColumn.
 *
 * Notebook and list selection are deliberately not part of this state. A
 * target can remain open while the surrounding library context changes.
 */
export type WorkColumnTarget =
  | { kind: 'empty' }
  | { kind: 'document-list'; scope: { kind: 'folder'; path: string; notebookPath: string; notebookId: string | null }; filters: { resourceKinds?: string[]; tags?: string[]; customFilterId?: string } }
  | {
      kind: 'external';
      fileBrowser?: FileBrowserContext;
      path: string;
      scopePath: string | null;
      transitionId: number | null;
    }
  | {
      kind: 'media';
      filePath: string;
      notebookId: string | null;
      notebookPath: string | null;
      resourceKind: 'image' | 'video';
    }
  | { kind: 'agent-conversation'; instanceId: string }
  /** View identity only. Plugin run state and artifacts live in host stores. */
  | { kind: 'plugin-workbench'; plugin: PluginDescriptor }
  | { kind: 'web'; url: string };

/** Local file path for the last successfully committed workColumn target. */
export function workColumnTargetFilePath(target: WorkColumnTarget): string | null {
  switch (target.kind) {
    case 'external':
      return target.path;
    case 'media':
      return target.filePath;
    default:
      return null;
  }
}

export const EMPTY_WORK_COLUMN_TARGET = { kind: 'empty' } as const satisfies WorkColumnTarget;

export type WorkColumnNavigationPhase = 'idle' | 'loading' | 'committed' | 'failed';

export interface WorkColumnNavigationFailure {
  code: 'navigation-failed' | 'navigation-stale';
  message: string;
  requestId: number;
  retryToken: string | null;
}

export interface WorkColumnNavigationState {
  /** The last successfully committed workColumn target. */
  phase: WorkColumnNavigationPhase;
  /** Whether an in-flight transaction should visually block the workColumn. */
  showWorkColumnLoading: boolean;
  requestId: number;
  target: WorkColumnTarget;
  /** The target currently being attempted, if any. */
  pendingTarget: WorkColumnTarget | null;
  /** Target that was active when the current request began. */
  previousTarget: WorkColumnTarget | null;
  failure: WorkColumnNavigationFailure | null;
  retryToken: string | null;
}
