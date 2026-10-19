import type { BrowserColumnNavigationResult } from '../model/surface-opening';
import { collections, externalDocuments, notebooks } from '@platform/tauri/client';
import { collectionNotebookId } from '@features/collection/mutations';
import { parseCollectionDocumentV2 } from '@features/collection/model';
import { inspectCollectionRecoveryType } from '@features/collection/recovery';
import { ensureCollectionDisplay, bindCollectionDisplayPath } from '@/lib/collection-display-registry';
import { captureFileBrowserContext } from './file-browser-context';
import type { FileBrowserTarget } from '../store/file-browser-target';
import { canonicalDirectoryPath, canonicalPath, fileLocatorKey } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { canonicalUrl, contentIdentityKey } from '@features/workspace/store/workspace-content-identity';
import {
  useBrowserColumnStore,
  type BrowserColumnOpenDisposition,
  type BrowserColumnTarget,
} from '@features/workspace/store/browser-column-store';
import type { WorkColumnTarget } from '@features/workspace/store/work-column-target';
import {
  activateExistingWorkspaceContent,
  activateExistingWorkspaceContentAsync,
  findWorkspaceContentLocations,
  browserColumnTargetIdentity,
  workColumnTargetIdentity,
} from './workspace-content-activation';
import {
  enqueueBrowserColumnNavigation,
} from './browser-column-coordinator';
import {
  prepareActiveWorkColumnDocumentLeave,
} from './workspace-navigation';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import type { ContentIdentity } from '@features/workspace/store/workspace-content-identity';

export type BrowserColumnOpenResult = NonNullable<BrowserColumnNavigationResult>;
export type BrowserTargetOpenResult = BrowserColumnOpenResult;

function targetTabTitle(target: BrowserColumnTarget): string {
  const filenameFromPath = (path: string) => path.split(/[\\/]/).pop() ?? path;

  switch (target.kind) {
    case 'folder-collection':
      return target.viewMode === 'work-documents'
        ? '工作文档'
        : target.folderName || target.folderPath.split(/[\\/]/).filter(Boolean).pop() || '文件夹集合';
    case 'media':
      return filenameFromPath(target.filePath);
    case 'file-browser':
      return displayTitleFromFilename(filenameFromPath(target.activeFilePath ?? target.folderPath ?? '')) || '文件';
    case 'web':
      try {
        return new URL(target.url).hostname || target.url;
      } catch {
        return target.url;
      }
    case 'agent_conversation':
      return 'Agent 会话';
  }
}

function targetTabIcon(target: BrowserColumnTarget): string | null {
  if (target.kind !== 'web') return null;
  try {
    const parsed = new URL(target.url);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function targetTabId(target: BrowserColumnTarget): string {
  if (target.kind === 'folder-collection') return `folder-collection:${target.notebookId}:${canonicalPath(target.folderPath)}:${target.viewMode ?? 'chooser'}`;
  if (target.kind === 'agent_conversation') return `agent:${target.instanceId}`;
  if (target.kind === 'web') return `web:${canonicalUrl(target.url) ?? target.url}`;
  if (target.kind === 'file-browser') {
    return target.collectionDisplay
      ? target.collectionDisplay.displayId
      : target.activeFilePath
        ? fileLocatorKey(target.activeFilePath)
        : `file-browser:${target.folderPath}`;
  }
  if (target.kind === 'media') return fileLocatorKey(target.filePath);
  return 'empty';
}

export function openBrowserColumnTarget(
  target: BrowserColumnTarget,
  disposition: BrowserColumnOpenDisposition = 'focus-existing',
): Promise<BrowserColumnNavigationResult> {
  return enqueueBrowserColumnNavigation(async () => {
    target = await prepareCollectionBrowserTarget(target);
    // Browser opens are scoped to Browser: a matching Work target may
    // coexist, while a matching Browser tab is always reused.
    if (disposition !== 'replace-active') {
      const existingTab = findWorkspaceContentLocations(
        browserColumnTargetIdentity(target),
      ).browserColumn;
      if (existingTab) {
        const store = useBrowserColumnStore.getState();
        if (target.kind === 'file-browser') {
          const existingTarget = store.tabs.find((tab) => tab.id === existingTab.tabId)?.target;
          if (existingTarget?.kind === 'file-browser') {
            // Upgrade a standalone file tab to a file-browser tab in place.
            // The tab identity stays stable while the resource context and
            // tree preferences are added.
            store.updateFileBrowserContext(existingTab.tabId, {
              folderPath: target.folderPath,
              notebookId: target.notebookId,
              scopePath: target.scopePath,
            });
            if (target.activeFilePath) {
              store.selectFileBrowserFile(existingTab.tabId, target.activeFilePath, target.collectionDisplay, target.collectionType, target.collectionUnavailableReason);
            }
          }
        }
        store.commitTab(existingTab.tabId);
        return { host: 'browser-column', tabId: existingTab.tabId, alreadyOpen: true };
      }
    }

    // Directory opens reuse their browsing tab after file-identity lookup.
    // Independent file opens keep their own stable tabs.
    if (target.kind === 'file-browser' && target.folderPath && disposition !== 'replace-active') {
      const store = useBrowserColumnStore.getState();
      const folderTarget = target;
      const folderTab = store.tabs.find((tab) => tab.target.kind === 'file-browser'
        && tab.target.folderPath && canonicalPath(tab.target.folderPath) === canonicalPath(folderTarget.folderPath!)
        && tab.target.notebookId === folderTarget.notebookId);
      if (folderTab) {
        if (target.activeFilePath) store.selectFileBrowserFile(folderTab.id, target.activeFilePath, target.collectionDisplay, target.collectionType, target.collectionUnavailableReason);
        store.commitTab(folderTab.id);
        return { host: 'browser-column', tabId: folderTab.id, alreadyOpen: true };
      }
    }
    const id = targetTabId(target);
    const tabId = useBrowserColumnStore.getState().openTab({
      id,
      title: targetTabTitle(target),
      icon: targetTabIcon(target),
      target,
    }, disposition);
    return { host: 'browser-column', tabId, alreadyOpen: false };
  });
}

export function createFileBrowserTarget(activeFilePath: string | null, scopePath: string | null = null, folderPath: string | null = null): FileBrowserTarget {
  return { kind: 'file-browser', activeFilePath, ...captureFileBrowserContext(activeFilePath, scopePath, folderPath) };
}

/** All file changes in an existing tab share the save-before-switch barrier. */
export function selectBrowserColumnFile(tabId: string, filePath: string | null, folderPath?: string): Promise<boolean | null> {
  const select = () => enqueueBrowserColumnNavigation(async () => {
    const state = useBrowserColumnStore.getState();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.target.kind !== 'file-browser') return false;
    const existing = filePath ? state.tabs.find((candidate) => candidate.id !== tabId
      && candidate.target.kind === 'file-browser' && candidate.target.activeFilePath
      && canonicalPath(candidate.target.activeFilePath) === canonicalPath(filePath)) : null;
    if (existing) { state.commitTab(existing.id); return true; }
    if (folderPath !== undefined) state.switchFileBrowserFolder(tabId, folderPath);
    const prepared = await prepareCollectionBrowserTarget({ ...tab.target, activeFilePath: filePath, collectionDisplay: undefined, collectionType: undefined });
    const existingBrowser = findWorkspaceContentLocations(
      browserColumnTargetIdentity(prepared),
    ).browserColumn;
    if (existingBrowser && existingBrowser.tabId !== tabId) {
      activateExistingWorkspaceContent(browserColumnTargetIdentity(prepared), 'browser-column');
      return true;
    }
    if (prepared.kind === 'file-browser') state.selectFileBrowserFile(tabId, prepared.activeFilePath, prepared.collectionDisplay, prepared.collectionType, prepared.collectionUnavailableReason);
    return true;
  });
  if (!filePath) return select();

  const documentIdentity: ContentIdentity = { kind: 'external', path: filePath };
  const existingBrowser = findWorkspaceContentLocations(documentIdentity).browserColumn;
  if (!existingBrowser || existingBrowser.tabId === tabId) {
    return select();
  }
  return activateExistingWorkspaceContentAsync(documentIdentity, 'browser-column')
    .then((location) => location ? true : select());
}

export function openBrowserColumnMarkdown(filePath: string): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget(createFileBrowserTarget(filePath));
}

/** An external drop explicitly targets the browser column, even if the file is open elsewhere. */
export function openBrowserColumnDroppedFile(filePath: string): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget(createFileBrowserTarget(filePath), 'open-in-column');
}

export function openBrowserColumnNotebookNote(
  filePath: string,
  notebookId: string,
  notebookPath: string,
  disposition: BrowserColumnOpenDisposition = 'focus-existing',
): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget({
    ...createFileBrowserTarget(filePath, notebookPath),
    notebookId,
  }, disposition);
}

export function openBrowserColumnText(
  filePath: string,
  scopePath: string | null,
  disposition: BrowserColumnOpenDisposition = 'focus-existing',
): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget(createFileBrowserTarget(filePath, scopePath), disposition);
}

export function openBrowserColumnMedia(
  filePath: string,
  notebookId: string,
  notebookPath: string,
  resourceKind: 'image' | 'video',
): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget({
    kind: 'media',
    filePath,
    notebookId,
    notebookPath,
    resourceKind,
  }, 'open-in-column');
}

export function openBrowserColumnFileBrowser(
  folderPath: string,
  activeFilePath: string | null = null,
): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget(createFileBrowserTarget(activeFilePath, folderPath, folderPath));
}

export function openBrowserColumnWebpage(url: string): Promise<BrowserColumnOpenResult | null> {
  const normalized = canonicalUrl(url);
  if (!normalized) return Promise.reject(new Error(`Unsupported webpage URL: ${url}`));
  return openBrowserColumnTarget({ kind: 'web', url: normalized });
}

export function openBrowserColumnAgentConversation(instanceId: string): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget({ kind: 'agent_conversation', instanceId });
}

/** Open the currently displayed work-column target in the right browser column. */
export function openWorkColumnTargetInBrowserColumn(
  target: WorkColumnTarget,
): Promise<BrowserColumnOpenResult | null> {
  const browserTarget: BrowserColumnTarget | null = (() => {
  switch (target.kind) {
    case 'folder-collection': return { kind: 'folder-collection', notebookId: target.notebookId,
      notebookPath: target.notebookPath, folderPath: target.folderPath, folderName: target.folderName, viewMode: target.viewMode };
      case 'media':
        return {
          kind: 'media',
          filePath: target.filePath,
          notebookId: target.notebookId ?? '',
          notebookPath: target.notebookPath ?? '',
          resourceKind: target.resourceKind,
        };
      case 'table':
      case 'media-library':
        return { ...createFileBrowserTarget(target.filePath, target.notebookPath), notebookId: target.notebookId };
      case 'collection':
        return { ...createFileBrowserTarget(target.filePath, target.notebookPath), notebookId: target.notebookId, collectionDisplay: target, collectionType: target.collectionType };
      case 'external':
        return { ...createFileBrowserTarget(target.path, target.scopePath), ...target.fileBrowser };
      case 'agent-conversation':
        return { kind: 'agent_conversation', instanceId: target.instanceId };
      case 'web':
        return { kind: 'web', url: target.url };
      default:
        return null;
    }
  })();

  if (!browserTarget) return Promise.resolve(null);

  return enqueueBrowserColumnNavigation(async () => {
    const isStillCurrentTarget = () => {
      const identity = workColumnTargetIdentity(target);
      const currentIdentity = workColumnTargetIdentity(useWorkColumnStore.getState().navigation.target);
      return !!identity && !!currentIdentity
        && contentIdentityKey(identity) === contentIdentityKey(currentIdentity);
    };
    if (!isStillCurrentTarget()) {
      return null;
    }

    // This legacy transfer opens the current Work content as a second view.
    if (target.kind !== 'agent-conversation') await prepareActiveWorkColumnDocumentLeave();
    if (!isStillCurrentTarget()) return null;

    const preparedTarget = await prepareCollectionBrowserTarget(browserTarget);
    if (!isStillCurrentTarget()) return null;

    const id = targetTabId(preparedTarget);
    const existingTab = findWorkspaceContentLocations(
      browserColumnTargetIdentity(preparedTarget),
    ).browserColumn;
    const tabId = useBrowserColumnStore.getState().openTab({
      id,
      title: targetTabTitle(preparedTarget),
      icon: targetTabIcon(preparedTarget),
      target: preparedTarget,
    });
    return { host: 'browser-column', tabId, alreadyOpen: !!existingTab };
  });
}

/** Remove path-owned Markdown tabs after their document buffers were flushed. */
export function removeBrowserColumnTabsByPath(path: string): string[] {
  const wanted = canonicalPath(path);
  const state = useBrowserColumnStore.getState();
  const matching = state.tabs.filter((tab) => {
    const tabPath = tab.target.kind === 'file-browser' ? tab.target.activeFilePath : null;
    return !!tabPath && canonicalPath(tabPath) === wanted;
  });
  for (const tab of matching) useBrowserColumnStore.getState().closeTab(tab.id);
  return matching.map((tab) => tab.id);
}

/** Resolve identity before a browser surface can mount. */
async function prepareCollectionBrowserTarget(target: BrowserColumnTarget): Promise<BrowserColumnTarget> {
  if (target.kind !== 'file-browser' || !target.activeFilePath || (!target.collectionDisplay && !/(?:\.(table|lib)\.ya?ml|\.index\.yaml)$/i.test(target.activeFilePath))) return target.kind === 'file-browser' ? { ...target, collectionType: undefined, collectionUnavailableReason: undefined } : target;
  const registered = (await notebooks.getAll()).find((notebook) => target.notebookId ? notebook.id === target.notebookId : canonicalPath(target.activeFilePath!).startsWith(`${canonicalDirectoryPath(notebook.path)}/`));
  const root = registered ? canonicalDirectoryPath(registered.path) : null;
  if (!root) throw new Error('集合需要笔记本上下文');
  const notebookId = await collectionNotebookId(root, target.notebookId);
  let envelope: ReturnType<typeof parseCollectionDocumentV2> | null = null;
  if (!target.collectionDisplay) {
    const source = await externalDocuments.read(target.activeFilePath, root);
    try { envelope = parseCollectionDocumentV2(source); }
    catch {
      return { ...target, notebookId, scopePath: root, collectionType: inspectCollectionRecoveryType(source, target.activeFilePath), collectionUnavailableReason: '集合文件格式无效' };
    }
  }
  const collectionId = target.collectionDisplay?.collectionId ?? envelope!.collection.id;
  let item: Awaited<ReturnType<typeof collections.resolve>>;
  try { item = await collections.resolve(notebookId, collectionId); }
  catch {
    return { ...target, notebookId, scopePath: root, collectionType: target.collectionType ?? envelope?.collection.type ?? 'table', collectionUnavailableReason: '集合不存在或暂时无法读取' };
  }
  if (item.identityConflict) throw new Error('集合身份冲突或格式暂不可用');
  if (item.parseState !== 'valid') return { ...target, notebookId, scopePath: root, collectionType: item.collectionType, collectionUnavailableReason: '集合文件格式无效' };
  const display = ensureCollectionDisplay({ notebookId, collectionId, viewId: target.collectionDisplay?.viewId ?? null }, target.collectionDisplay?.displayId);
  const path = `${root.replace(/\/$/, '')}/${item.relativePath}`;
  bindCollectionDisplayPath(display.displayId, path, item.indexSequence);
  return { ...target, notebookId, scopePath: root, activeFilePath: path, collectionDisplay: display, collectionType: item.collectionType, collectionUnavailableReason: undefined };
}
