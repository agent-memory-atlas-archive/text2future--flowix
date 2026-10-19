'use client';

import { useCallback, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { type CollectionDisplayDescriptor } from '@/lib/collection-display-registry';
import { requireFileDisplayIdentity, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { selectBrowserColumnFile } from '@features/workspace/public/browser-column-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { setCollectionActiveView } from '@features/workspace/use-cases/collection-view-state';
import { useBrowserColumnStore, type BrowserColumnTab, type BrowserColumnWebRuntime } from '@features/workspace/store/browser-column-store';
import { canonicalUrl } from '@features/workspace/store/workspace-content-identity';
import type { WorkspaceSurfaceCapability, SurfaceAppearance, SurfaceHeaderStyle } from '@features/workspace/public/surface-api';
import type { FileBrowserViewSurface } from './file-browser-view';
import { getWorkspaceSurfaceRendererDefinition, WorkspaceSurfaceRendererView } from './workspace-surface-renderer-registry';
import type { ExternalDocumentProps, WorkspaceSurfaceRendererData, WorkspaceWebNavigationPort } from './workspace-surface-renderer-contract';
import { registerWorkspaceSurfacePresentationOwner, reportWorkspaceSurfacePresentation } from './workspace-surface-runtime';
import { workspaceSurfaceRetainsInitialContent } from './workspace-surface-renderer-registry';
import type { SurfacePresentationUpdate } from '@features/workspace/model/surface-contract';
import type { SurfaceLifecycle } from '@features/workspace/model/surface-contract';
import { registerWorkspaceSurfaceLifecycle, registerWorkspaceSurfaceHostView } from '@features/workspace/public/surface-lifecycle-api';

export type BrowserColumnSurfaceCapability = WorkspaceSurfaceCapability;

interface SurfaceBase {
  instanceKey: string;
  tabId: string;
}

interface FileSurfaceBase extends SurfaceBase {
  fileIdentity: FileDisplayIdentity;
}

export interface BrowserMediaSurface extends FileSurfaceBase {
  kind: 'media';
  notebookId: string;
  notebookPath: string;
  resourceKind: 'image' | 'video';
}

export interface BrowserFolderCollectionSurface extends SurfaceBase {
  kind: 'collection';
  notebookId: string;
  notebookPath: string;
  folderPath: string;
  folderName: string;
  viewMode?: 'work-documents';
}

export type BrowserFileBrowserSurface = SurfaceBase
  & FileBrowserViewSurface
  & { collectionType?: 'table' | 'media_library' | 'work_documents'; collectionUnavailableReason?: string; collectionDisplay?: CollectionDisplayDescriptor; documentProps: ExternalDocumentProps }
  & (
    | { activeFilePath: string; fileIdentity: FileDisplayIdentity }
    | { activeFilePath: null; fileIdentity?: never }
  );

export interface BrowserWebSurface extends SurfaceBase {
  kind: 'web';
  url: string;
  title: string;
  runtime: BrowserColumnWebRuntime | null;
}

export interface BrowserAgentConversationSurface extends SurfaceBase {
  kind: 'agent-conversation';
  instanceId: string;
}

export type BrowserColumnSurface =
  | BrowserFolderCollectionSurface
  | BrowserMediaSurface
  | BrowserFileBrowserSurface
  | BrowserWebSurface
  | BrowserAgentConversationSurface;

export type BrowserColumnSurfaceKind = BrowserColumnSurface['kind'];

/** Titlebar skin owned by the surface currently mounted in Browser Column. */
export type BrowserColumnSurfaceChrome = SurfaceHeaderStyle;

export interface BrowserColumnSurfaceDefinition {
  appearance: Readonly<SurfaceAppearance>;
  chrome: BrowserColumnSurfaceChrome;
  capabilities: readonly BrowserColumnSurfaceCapability[];
  render: () => ReactNode;
}

export type BrowserColumnDocumentFlush = (
  (options?: { silent?: boolean }) => Promise<boolean>
) | null;
export type BrowserColumnFlushRegistration = (
  flush: BrowserColumnDocumentFlush,
  discard?: (() => void) | null,
) => void;

export function resolveBrowserColumnSurface(
  tab: BrowserColumnTab,
  readOnly: boolean,
  onFlushReady?: BrowserColumnFlushRegistration,
  webRuntime?: BrowserColumnWebRuntime | null,
  toolbarCollapsed = false,
  onToolbarCollapsedChange?: (collapsed: boolean) => void,
): BrowserColumnSurface {
  const base = {
    instanceKey: `tab:${tab.id}`,
    tabId: tab.id,
  };
  switch (tab.target.kind) {
    case 'folder-collection':
      return { ...base, kind: 'collection', notebookId: tab.target.notebookId,
        notebookPath: tab.target.notebookPath, folderPath: tab.target.folderPath, folderName: tab.target.folderName,
        viewMode: tab.target.viewMode };
    case 'media':
      return {
        ...base,
        fileIdentity: requireFileDisplayIdentity(tab.target.filePath),
        kind: 'media',
        notebookId: tab.target.notebookId,
        notebookPath: tab.target.notebookPath,
        resourceKind: tab.target.resourceKind,
      };
    case 'file-browser': {
      const target = tab.target;
      const surface: SurfaceBase & FileBrowserViewSurface & Pick<BrowserFileBrowserSurface, 'documentProps'> = {
        ...base,
        ...target,
        documentProps: {
          isExternalDocument: true,
          externalScopePath: target.scopePath,
          documentSessionMode: 'isolated',
          workspaceHost: 'browser-column',
          readOnly, onFlushReady, toolbarCollapsed, onToolbarCollapsedChange,
        },
        onSelectFile: (path) => { void selectBrowserColumnFile(tab.id, path); },
        onOpenFileInNewTab: (path) => { void openWorkspaceSurface({
          host: 'browser-column',
          target: { ...target, activeFilePath: path, collectionDisplay: undefined, folderPath: null },
          options: { browserDisposition: 'open-in-column' },
        }); },
        onContextChange: (patch) => useBrowserColumnStore.getState().updateFileBrowserContext(tab.id, patch),
        onSelectFolder: (path) => { void selectBrowserColumnFile(tab.id, null, path); },
        onTreeVisibleChange: (visible) => useBrowserColumnStore.getState().setFileBrowserTreeVisible(tab.id, visible),
        onTreeWidthChange: (width) => useBrowserColumnStore.getState().setFileBrowserTreeWidth(tab.id, width),
      };
      return target.activeFilePath
        ? {
            ...surface,
            activeFilePath: target.activeFilePath,
            collectionType: target.collectionType,
            collectionUnavailableReason: target.collectionUnavailableReason,
            fileIdentity: target.collectionDisplay ? { path: target.activeFilePath, displayId: target.collectionDisplay.displayId } : requireFileDisplayIdentity(target.activeFilePath),
          }
        : { ...surface, activeFilePath: null };
    }
    case 'web':
      return {
        ...base,
        kind: 'web',
        url: tab.target.url,
        title: tab.title,
        runtime: webRuntime ?? null,
      };
    case 'agent_conversation':
      return { ...base, kind: 'agent-conversation', instanceId: tab.target.instanceId };
  }
}

function browserSurfaceData(surface: BrowserColumnSurface): WorkspaceSurfaceRendererData {
  switch (surface.kind) {
    case 'collection': return { kind: 'collection', notebookId: surface.notebookId,
      notebookPath: surface.notebookPath, folderPath: surface.folderPath, folderName: surface.folderName, viewMode: surface.viewMode };
    case 'media': return { kind: 'media', fileIdentity: surface.fileIdentity, notebookPath: surface.notebookPath,
      notebookId: surface.notebookId, resourceKind: surface.resourceKind };
    case 'agent-conversation': return { kind: 'agent-conversation', instanceId: surface.instanceId };
    case 'web': return { kind: 'web', url: surface.url, title: surface.title, runtime: surface.runtime };
    case 'file-browser': return { kind: 'file-browser', props: surface };
  }
}

function createBrowserWebNavigationPort(tabId: string): WorkspaceWebNavigationPort {
  return {
    getRuntime: () => useBrowserColumnStore.getState().webRuntimes[tabId] ?? null,
    setRuntime: (runtime) => useBrowserColumnStore.getState().setWebRuntime(tabId, runtime),
    navigate: (url) => { useBrowserColumnStore.getState().navigateWebTab(tabId, url); },
    back: () => { useBrowserColumnStore.getState().goBackWebTab(tabId); },
    forward: () => { useBrowserColumnStore.getState().goForwardWebTab(tabId); },
    reload: () => { useBrowserColumnStore.getState().reloadWebTab(tabId); },
    updateMetadata: (metadata) => useBrowserColumnStore.getState().updateTabMetadata(tabId, metadata),
  };
}

function BrowserRegisteredSurfaceView({ surface, focused }: { surface: BrowserColumnSurface; focused: boolean }) {
  const presentationIdentity = surface.kind === 'collection'
    ? `${surface.notebookId}:${surface.folderPath}`
    : surface.kind === 'file-browser'
    ? `${surface.fileIdentity?.displayId ?? ''}:${surface.activeFilePath ?? surface.folderPath ?? 'folder'}:${surface.collectionType ?? ''}`
    : surface.kind === 'media'
      ? surface.fileIdentity.displayId
      : surface.kind === 'web'
        ? canonicalUrl(surface.url) ?? surface.url
      : surface.instanceId;
  const presentationOwner = useMemo(() => ({}), [surface.tabId, presentationIdentity]);
  const webNavigation = useMemo(() => surface.kind === 'web' ? createBrowserWebNavigationPort(surface.tabId) : undefined,
    [surface.kind, surface.tabId]);
  const onCollectionActiveViewChange = useCallback((viewId: string) => {
    const tab = useBrowserColumnStore.getState().tabs.find((candidate) => candidate.id === surface.tabId);
    if (tab?.target.kind !== 'file-browser' || !tab.target.collectionDisplay) return;
    const { notebookId, collectionId } = tab.target.collectionDisplay;
    setCollectionActiveView({ host: 'browser-column', tabId: surface.tabId }, { notebookId, collectionId }, viewId);
  }, [surface.tabId]);
  const reportPresentation = useCallback((update: SurfacePresentationUpdate) => {
    const accepted = reportWorkspaceSurfacePresentation(surface.tabId, update, presentationOwner);
    if (!accepted) return;
    if (update.title !== undefined || update.icon !== undefined) {
      const metadata: { title?: string; icon?: string | null } = {};
      if (update.title !== undefined) metadata.title = update.title;
      if (update.icon !== undefined) metadata.icon = update.icon;
      useBrowserColumnStore.getState().updateTabMetadata(surface.tabId, metadata);
    }
  }, [presentationOwner, surface.tabId]);
  const retainInitialContent = workspaceSurfaceRetainsInitialContent(browserSurfaceData(surface));
  const registerLifecycle = useCallback((lifecycle: SurfaceLifecycle | null, owner?: object) => {
    registerWorkspaceSurfaceLifecycle(surface.tabId, lifecycle, owner);
  }, [surface.tabId]);
  useLayoutEffect(() => registerWorkspaceSurfaceHostView('browser-column', surface.tabId), [surface.tabId]);
  useLayoutEffect(() => registerWorkspaceSurfacePresentationOwner(surface.tabId, presentationOwner, {
    state: { status: 'loading', loadingMode: 'blocking', retainContent: retainInitialContent },
  }),
    [presentationOwner, retainInitialContent, surface.tabId]);
  return <WorkspaceSurfaceRendererView
    surface={browserSurfaceData(surface)}
    context={{ host: 'browser-column', viewId: surface.tabId, focused,
      initialFocus: surface.kind === 'file-browser' ? surface.documentProps.initialFocus : undefined,
      webNavigation, onCollectionActiveViewChange,
      readOnly: surface.kind === 'file-browser' && Boolean(surface.documentProps.readOnly),
      reportPresentation, registerLifecycle }}
  />;
}

/** Browser provides view data and navigation ports; all kinds use the common registry. */
export function getBrowserColumnSurfaceDefinition(surface: BrowserColumnSurface): BrowserColumnSurfaceDefinition {
  const definition = getWorkspaceSurfaceRendererDefinition(browserSurfaceData(surface));
  return { appearance: definition.appearance, chrome: definition.appearance.headerStyle,
    capabilities: definition.capabilities, render: () => <BrowserRegisteredSurfaceView surface={surface} focused={false} /> };
}

export function browserColumnSurfaceSupports(surface: BrowserColumnSurface, capability: BrowserColumnSurfaceCapability): boolean {
  return getBrowserColumnSurfaceDefinition(surface).capabilities.includes(capability);
}

export function BrowserColumnSurfaceHost({ surface, focused = false }: { surface: BrowserColumnSurface; focused?: boolean }) {
  return <BrowserRegisteredSurfaceView key={`${surface.kind}:${surface.instanceKey}`} surface={surface} focused={focused} />;
}
