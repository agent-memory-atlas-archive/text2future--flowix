import { canOpenBrowserColumnTargetInWorkColumn, useBrowserColumnStore, type BrowserColumnTarget } from '../store/browser-column-store';
import type { BrowserSurfaceOpenDisposition } from '../model/surface-opening';
import type {
  OpenWorkspaceSurfaceRequest, WorkWorkspaceSurfaceRequest, BrowserWorkspaceSurfaceRequest,
  WorkWorkspaceOpenResult, BrowserWorkspaceOpenResult, WorkspaceContentLocation, WorkspaceSurfaceOpenResult,
} from '../model/surface-opening';
import type { WorkWorkspaceSurfaceTarget, BrowserWorkspaceSurfaceTarget, CollectionReferenceSurfaceTarget } from '../model/surface-target';
export type * from '../model/surface-opening';
export type { WorkspaceSurfaceOpenTarget, BrowserWorkspaceSurfaceTarget, CollectionReferenceSurfaceTarget } from '../model/surface-target';
import { contentIdentityKey } from '../model/surface-identity';
import type { ContentIdentity } from '../model/surface-identity';
import { useWorkColumnStore } from '../store/work-column-store';
import type { WorkspaceSurfaceHost, WorkspaceSurfaceKind } from '../surface-registry';
import { collections, notebooks } from '@platform/tauri/client';
import { ensureCollectionDisplay, findCollectionDisplayPath } from '@/lib/collection-display-registry';
import {
  resolveWorkspaceFileSurfaceKind,
  workspaceFileSurfaceKind,
  workspaceSurfaceSupportsHost,
} from '../surface-registry';
import {
  createFileBrowserTarget,
  openBrowserColumnTarget,
} from './browser-column-navigation';
import {
  openCollectionTarget,
  openFolderCollectionChooserTarget,
  openExternalTarget,
  openMediaLibraryTarget,
  openMediaTarget,
  openPluginWorkbench,
  openTableTarget,
  openWebTarget,
  prepareActiveWorkColumnDocumentLeave,
} from './workspace-navigation';
import { selectAndOpenAgentConversation } from './agent-conversation-navigation';
import { browserColumnTargetIdentity, workColumnTargetIdentity, findWorkspaceContentForNavigation } from './workspace-content-activation';
import { flushBrowserViewBeforeOpeningWork } from './prepare-browser-document-for-work';

function fileKind(path: string): WorkspaceSurfaceKind {
  return workspaceFileSurfaceKind(resolveWorkspaceFileSurfaceKind(path));
}

function workTargetSurfaceKind(target: WorkWorkspaceSurfaceTarget): WorkspaceSurfaceKind {
  switch (target.kind) {
    case 'folder-collection': return 'collection';
    case 'external': return fileKind(target.path);
    case 'table': return 'file-table';
    case 'media-library': return 'file-media-library';
    case 'collection': return target.collectionType === 'table' ? 'file-table'
      : target.collectionType === 'media_library' ? 'file-media-library' : 'file-work-documents';
    case 'collection-reference': return target.collectionKind === 'media_library' ? 'file-media-library'
      : target.collectionKind === 'work_documents' ? 'file-work-documents' : 'file-table';
    case 'media': return 'media';
    case 'agent-conversation': return 'agent-conversation';
    case 'web': return 'web';
    case 'plugin-workbench': return 'plugin-workbench';
  }
}

function workTargetIdentity(target: WorkWorkspaceSurfaceTarget): ContentIdentity | null {
  switch (target.kind) {
    case 'folder-collection': return { kind: 'folder-collection', notebookId: target.notebookId, folderPath: target.folderPath, viewMode: target.viewMode };
    case 'external': return { kind: 'external', path: target.path };
    case 'table': case 'media-library': return { kind: 'external', path: target.filePath };
    case 'collection': return { kind: 'collection', notebookId: target.notebookId, collectionId: target.collectionId, viewId: target.viewId };
    case 'collection-reference': return { kind: 'collection', notebookId: target.notebookId, collectionId: target.collectionId, viewId: target.viewId ?? null };
    case 'media': return { kind: 'media', path: target.filePath };
    case 'agent-conversation': return { kind: 'agent-conversation', instanceId: target.instanceId };
    case 'web': return { kind: 'web', url: target.url };
    case 'plugin-workbench': return null;
  }
}

function browserTargetSurfaceKind(target: BrowserColumnTarget): WorkspaceSurfaceKind {
  switch (target.kind) {
    case 'folder-collection': return 'collection';
    case 'media': return 'media';
    case 'web': return 'web';
    case 'agent_conversation': return 'agent-conversation';
    case 'file-browser':
      if (!target.activeFilePath) return 'file-browser';
      if (target.collectionType === 'table' || /\.table\.ya?ml$/i.test(target.activeFilePath)) return 'file-table';
      if (target.collectionType === 'media_library' || /\.lib\.ya?ml$/i.test(target.activeFilePath)) return 'file-media-library';
      if (target.collectionType === 'work_documents' || /\.workdocs\.ya?ml$/i.test(target.activeFilePath)) return 'file-work-documents';
      if (/\.index\.yaml$/i.test(target.activeFilePath)) return 'file-browser';
      return fileKind(target.activeFilePath);
  }
}

function browserTargetFromOpenTarget(
  target: Exclude<BrowserWorkspaceSurfaceTarget, CollectionReferenceSurfaceTarget>,
  notebookId?: string | null,
): BrowserColumnTarget {
  switch (target.kind) {
    case 'folder-collection':
      return target;
    case 'file-browser':
      return target;
    case 'external':
      return {
        ...createFileBrowserTarget(target.path, target.scopePath),
        ...target.fileBrowser,
        ...(notebookId !== undefined ? { notebookId } : {}),
      };
    case 'table':
      return { ...createFileBrowserTarget(target.filePath, target.notebookPath), notebookId: target.notebookId };
    case 'media-library':
      return {
        ...createFileBrowserTarget(target.filePath, target.notebookPath),
        notebookId: target.notebookId,
        collectionType: 'media_library',
      };
    case 'collection':
      return {
        ...createFileBrowserTarget(target.filePath, target.notebookPath),
        notebookId: target.notebookId,
        collectionDisplay: target,
        collectionType: target.collectionType,
      };
    case 'media':
      if (!target.notebookPath?.trim()) throw new Error('Browser media target requires a notebook path');
      if (!target.notebookId?.trim()) throw new Error('Browser media target requires a notebook ID');
      return {
        kind: 'media',
        filePath: target.filePath,
        notebookId: target.notebookId,
        notebookPath: target.notebookPath,
        resourceKind: target.resourceKind,
      };
    case 'agent-conversation':
      return { kind: 'agent_conversation', instanceId: target.instanceId };
    case 'web':
      return { kind: 'web', url: target.url };
  }
}

async function openCollectionReferenceInBrowser(
  target: CollectionReferenceSurfaceTarget,
  disposition?: BrowserSurfaceOpenDisposition,
): Promise<BrowserWorkspaceOpenResult> {
  const notebook = (await notebooks.getAll()).find((candidate) => candidate.id === target.notebookId);
  if (!notebook) throw new Error('集合所属笔记本不存在');
  const descriptor = ensureCollectionDisplay({
    notebookId: target.notebookId,
    collectionId: target.collectionId,
    viewId: target.viewId ?? null,
  }, target.displayId);
  const root = notebook.path.replace(/[\\/]+$/, '');
  let path = target.filePath || (target.relativePathHint ? `${root}/${target.relativePathHint}` : null)
    || findCollectionDisplayPath(descriptor.displayId);
  let collectionType = target.collectionKind;
  try {
    const collection = await collections.resolve(target.notebookId, target.collectionId);
    path = `${root}/${collection.relativePath}`;
    collectionType = collection.collectionType;
  } catch (error) {
    if (!path) throw error;
  }
  if (!path) throw new Error('集合文件路径已丢失，请从文件树重新打开此文件');
  return openBrowserTarget({
    ...createFileBrowserTarget(path, notebook.path, notebook.path),
    notebookId: target.notebookId,
    collectionDisplay: descriptor,
    collectionType,
  }, disposition);
}

function activeWorkLocation(): Extract<WorkspaceContentLocation, { host: 'main-third' }> {
  return { host: 'main-third', state: 'active' };
}

function assertHostSupport(kind: WorkspaceSurfaceKind, host: WorkspaceSurfaceHost): void {
  if (!workspaceSurfaceSupportsHost(kind, host)) {
    throw new Error(`Surface '${kind}' is not supported in '${host}'`);
  }
}

async function openBrowserTarget(
  target: BrowserColumnTarget,
  disposition?: BrowserSurfaceOpenDisposition,
): Promise<BrowserWorkspaceOpenResult> {
  assertHostSupport(browserTargetSurfaceKind(target), 'browser-column');
  if (target.kind !== 'agent_conversation') {
    const requestedIdentity = browserColumnTargetIdentity(target);
    const activeWorkIdentity = workColumnTargetIdentity(useWorkColumnStore.getState().navigation.target);
    if (activeWorkIdentity && contentIdentityKey(activeWorkIdentity) === contentIdentityKey(requestedIdentity)) {
      await prepareActiveWorkColumnDocumentLeave();
    }
  }
  const result = await openBrowserColumnTarget(target, disposition);
  return result
    ? { status: result.alreadyOpen ? 'activated' : 'opened', host: 'browser-column', location: { host: 'browser-column', tabId: result.tabId } }
    : { status: 'cancelled', host: 'browser-column', reason: 'navigation-cancelled' };
}

export function openWorkspaceSurface(request: BrowserWorkspaceSurfaceRequest): Promise<BrowserWorkspaceOpenResult>;
export function openWorkspaceSurface(request: WorkWorkspaceSurfaceRequest): Promise<WorkWorkspaceOpenResult>;
export function openWorkspaceSurface(request: OpenWorkspaceSurfaceRequest): Promise<BrowserWorkspaceOpenResult | WorkWorkspaceOpenResult>;
/** Route a shared surface target through the selected host adapter. */
export async function openWorkspaceSurface(
  request: OpenWorkspaceSurfaceRequest,
): Promise<BrowserWorkspaceOpenResult | WorkWorkspaceOpenResult> {
  if (request.host === 'browser-column') {
    const target = request.target;
    if (target.kind === 'collection-reference') {
      assertHostSupport(target.collectionKind === 'media_library' ? 'file-media-library'
        : target.collectionKind === 'work_documents' ? 'file-work-documents' : 'file-table', 'browser-column');
      return openCollectionReferenceInBrowser(target, request.options?.browserDisposition);
    }
    const resolvedTarget = browserTargetFromOpenTarget(target, request.options?.notebookId);
    return openBrowserTarget(resolvedTarget, request.options?.browserDisposition);
  }

  const target = request.target;
  const kind = workTargetSurfaceKind(target);
  assertHostSupport(kind, 'main-third');
  const options = request.options;
  const identity = workTargetIdentity(target);
  const previousLocation = identity ? findWorkspaceContentForNavigation(identity, 'main-third') : null;
  if (target.kind !== 'external' && !(previousLocation?.host === 'main-third' && previousLocation.state === 'active') && identity
    && identity.kind !== 'media' && identity.kind !== 'web' && identity.kind !== 'agent-conversation') {
    if (!await flushBrowserViewBeforeOpeningWork(identity)) {
      return { status: 'cancelled', host: 'main-third', reason: 'navigation-cancelled' };
    }
  }
  const previousWorkTarget = useWorkColumnStore.getState().navigation.target;
  const pluginWasOpen = target.kind === 'plugin-workbench'
    && previousWorkTarget.kind === 'plugin-workbench'
    && previousWorkTarget.plugin.manifest.id === target.plugin.manifest.id;
  const finishWorkOpen = (): WorkWorkspaceOpenResult => {
    const navigationTarget = useWorkColumnStore.getState().navigation.target;
    const pluginMatches = target.kind === 'plugin-workbench'
      && navigationTarget.kind === 'plugin-workbench'
      && navigationTarget.plugin.manifest.id === target.plugin.manifest.id;
    const location = identity
      ? findWorkspaceContentForNavigation(identity, 'main-third')
      : pluginMatches ? activeWorkLocation() : null;
    if (!location || location.host !== 'main-third' || location.state === 'pending') {
      return { status: 'cancelled', host: 'main-third', reason: 'navigation-cancelled' };
    }
    return { status: previousLocation || pluginWasOpen ? 'activated' : 'opened', host: 'main-third', location };
  };
  switch (target.kind) {
    case 'folder-collection':
      await openFolderCollectionChooserTarget(target);
      return finishWorkOpen();
    case 'external': {
      await openExternalTarget(target.path, {
        scopePath: target.scopePath,
        fileBrowser: target.fileBrowser,
        history: options?.history,
        notebookId: options?.notebookId,
        markdownLocation: options?.markdownLocation,
        initialFocus: options?.initialFocus,
        destination: 'main-third',
      });
      return finishWorkOpen();
    }
    case 'table':
      await openTableTarget(target.filePath, target.notebookPath, target.notebookId, { history: options?.history, destination: 'main-third' });
      return finishWorkOpen();
    case 'media-library':
      await openMediaLibraryTarget(target.filePath, target.notebookPath, target.notebookId, { history: options?.history, destination: 'main-third' });
      return finishWorkOpen();
    case 'collection':
      await openCollectionTarget(target, { history: options?.history, destination: 'main-third', refresh: options?.refresh });
      return finishWorkOpen();
    case 'collection-reference':
      await openCollectionTarget(target, { history: options?.history, destination: 'main-third', refresh: options?.refresh });
      return finishWorkOpen();
    case 'media':
      await openMediaTarget({ ...target, history: options?.history, destination: 'main-third' });
      return finishWorkOpen();
    case 'agent-conversation': {
      await selectAndOpenAgentConversation(target.instanceId, {
        history: options?.history,
        destination: 'main-third',
        ...(target.blankIfMissing ? { blankIfMissing: true as const } : {}),
      });
      return finishWorkOpen();
    }
    case 'web':
      await openWebTarget(target.url, { history: options?.history, destination: 'main-third' });
      return finishWorkOpen();
    case 'plugin-workbench':
      await openPluginWorkbench(target.plugin);
      return finishWorkOpen();
  }
}

/** Open a Browser tab as an additional Work view through the shared protocol. */
export async function openBrowserColumnTabInWorkColumn(
  tabId: string,
): Promise<WorkspaceSurfaceOpenResult> {
  const tab = useBrowserColumnStore.getState().tabs.find((candidate) => candidate.id === tabId);
  if (!tab || !canOpenBrowserColumnTargetInWorkColumn(tab.target)) {
    return { status: 'cancelled', host: 'main-third', reason: 'navigation-cancelled' };
  }
  const target: WorkWorkspaceSurfaceTarget | null = (() => {
    switch (tab.target.kind) {
      case 'folder-collection': return tab.target;
      case 'file-browser':
        if (tab.target.collectionDisplay) return {
          kind: 'collection-reference',
          notebookId: tab.target.collectionDisplay.notebookId,
          collectionId: tab.target.collectionDisplay.collectionId,
          viewId: tab.target.collectionDisplay.viewId,
          displayId: tab.target.collectionDisplay.displayId,
          filePath: tab.target.activeFilePath ?? undefined,
        };
        if (!tab.target.activeFilePath) return null;
        return {
          kind: 'external', path: tab.target.activeFilePath,
          scopePath: tab.target.scopePath, fileBrowser: tab.target,
        };
      case 'media':
        return {
          kind: 'media', filePath: tab.target.filePath, notebookId: tab.target.notebookId,
          notebookPath: tab.target.notebookPath, resourceKind: tab.target.resourceKind,
        };
      case 'web': return { kind: 'web', url: tab.target.url };
      case 'agent_conversation': return { kind: 'agent-conversation', instanceId: tab.target.instanceId };
    }
  })();
  if (!target) return { status: 'cancelled', host: 'main-third', reason: 'navigation-cancelled' };
  return openWorkspaceSurface({ host: 'main-third', target });
}

export type { WorkspaceSurfaceHost };
