import type { MarkdownLocation } from '@platform/tauri/client';
import type { WorkWorkspaceSurfaceTarget, BrowserWorkspaceSurfaceTarget } from './surface-target';

export type WorkspaceContentLocation =
  | { host: 'main-third'; state: 'active' | 'pending' }
  | { host: 'browser-column'; surfaceId: string };

export interface WorkspaceOpenNavigationOptions {
  history?: 'push' | 'skip';
  /** Re-resolve and commit an already-open collection after its backing file changes. */
  refresh?: boolean;
}
export interface WorkWorkspaceSurfaceOptions extends WorkspaceOpenNavigationOptions {
  notebookId?: string | null;
  markdownLocation?: MarkdownLocation | null;
  initialFocus?: 'title' | 'body';
}
export interface BrowserWorkspaceSurfaceOptions {
  notebookId?: string | null;
}
export type WorkspaceNavigationSource = 'notebook-tree' | 'notebook-tree-new-tab' | 'agent-message' | 'html-link';

export interface WorkWorkspaceSurfaceRequest {
  source?: WorkspaceNavigationSource;
  /** Callers own the destination; focus and runtime state must not infer it. */
  host: 'main-third';
  target: WorkWorkspaceSurfaceTarget;
  options?: WorkWorkspaceSurfaceOptions;
}
export interface BrowserWorkspaceSurfaceRequest {
  source?: WorkspaceNavigationSource;
  host: 'browser-column';
  target: BrowserWorkspaceSurfaceTarget;
  options?: BrowserWorkspaceSurfaceOptions;
}
export type OpenWorkspaceSurfaceRequest = WorkWorkspaceSurfaceRequest | BrowserWorkspaceSurfaceRequest;
export type WorkWorkspaceOpenResult =
  | { status: 'opened' | 'activated'; host: 'main-third'; location: Extract<WorkspaceContentLocation, { host: 'main-third' }> }
  | { status: 'cancelled'; host: 'main-third'; reason: 'navigation-cancelled' };
export type BrowserWorkspaceOpenResult =
  | { status: 'opened' | 'activated'; host: 'browser-column'; location: Extract<WorkspaceContentLocation, { host: 'browser-column' }> }
  | { status: 'cancelled'; host: 'browser-column'; reason: 'navigation-cancelled' };
export type WorkspaceSurfaceOpenResult = WorkWorkspaceOpenResult | BrowserWorkspaceOpenResult;
/** Internal Browser adapter detail, normalized by openWorkspaceSurface. */
export type BrowserColumnNavigationResult = {
  host: 'browser-column';
  surfaceId: string;
  alreadyOpen: boolean;
} | null;
