import { captureFileBrowserContext } from './file-browser-context';
import type { PluginDescriptor } from '@platform/tauri/client';
import { canonicalPath } from '@/lib/path';
import { resourceKindFromPath } from '@features/editor/public/code-file';
import { canonicalUrl } from '@features/workspace/store/workspace-content-identity';
import {
  flushWorkspaceDocumentPath,
  getWorkspaceDocumentState,
  recordWorkspaceDocumentNavigation,
  replaceWorkspaceMemoHistoryPath,
  replaceWorkspaceDocumentPath,
  type DocumentHistoryEntry,
} from '@features/document/public/workspace-api';
import {
  useBrowserColumnStore,
  type BrowserColumnTab,
} from '@features/workspace/store/browser-column-store';
import { documentIdentityFromFile } from '@features/document/public/workspace-api';
import {
  findFileDisplayId,
  ensureFileDisplayIdentity,
  suspendFileDisplayReconciliation,
} from '@/lib/file-display-registry';
import { waitForWorkspaceDocumentSaves } from '@features/document/public/workspace-api';
import {
  getWorkspaceMemoState,
  setCurrentWorkspaceNotebook,
  type Notebook,
} from '@features/memo/public/workspace-api';
import type { MemoItem } from '@/types/memo-item';
import {
  getPluginNoteInfo,
  type PluginArtifactRendererId,
} from '@features/plugin/public/workspace-api';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { EMPTY_WORK_COLUMN_TARGET } from '@features/workspace/store/work-column-target';
import type { WorkColumnTarget } from '@features/workspace/store/work-column-target';
import {
  useWorkspaceFocusStore,
  type WorkspaceHostId,
} from '@features/workspace/store/workspace-focus-store';
import {
  activateExistingWorkspaceContent,
  activateExistingWorkspaceContentAsync,
  findExistingWorkspaceContent,
  type WorkspaceContentLocation,
} from './workspace-content-activation';
import type { ContentIdentity } from '@features/workspace/store/workspace-content-identity';
import {
  useWorkspaceRestoreStore,
  type PersistedWorkspaceTarget,
} from '@features/workspace/store/workspace-restore-store';

export interface OpenMemoTargetParams {
  memoId: string;
  path: string | null;
  notebookId?: string | null;
  notebookPath?: string | null;
  history?: 'push' | 'skip';
  initialContent?: string;
  initialFocus?: 'title' | 'body';
  destination?: 'main-third';
  /** When supplied, selection is part of this navigation transaction. */
  memo?: MemoItem | null;
  /** Optional authoritative Notebook entity used during a cross-notebook open. */
  notebook?: Notebook | null;
}

export interface OpenExternalTargetOptions {
  fileBrowser?: import('../store/file-browser-target').FileBrowserContext;
  /** Explicit cross-column moves must not reactivate a BrowserColumn tab. */
  destination?: 'main-third';
  history?: 'push' | 'skip';
  scopePath?: string | null;
}

export interface OpenMediaTargetParams {
  filePath: string;
  notebookId?: string | null;
  notebookPath: string | null;
  resourceKind?: 'image' | 'video';
  history?: 'push' | 'skip';
  destination?: 'main-third';
}

export interface OpenArtifactTargetParams {
  pointerMemoId: string;
  notebookId?: string | null;
  notebookPath?: string | null;
  pluginId?: string | null;
  renderer?: PluginArtifactRendererId | null;
  history?: 'push' | 'skip';
  /** Optional pointer memo metadata used to avoid re-reading the list item. */
  memo?: MemoItem | null;
  notebook?: Notebook | null;
}

type RetryAction = () => Promise<void>;

type DocumentSnapshot = Pick<
  ReturnType<typeof getWorkspaceDocumentState>,
  'activeMemoSession' | 'activeExternalSession' | 'activeAgentConversationId'
>;

const retryActions = new Map<string, RetryAction>();
let retrySequence = 0;

/**
 * Let a selection-only update reach the screen before document navigation
 * starts doing synchronous editor work. A single rAF runs before the browser
 * paints, so the second frame is intentional: the first frame is the one in
 * which React can paint the selected memo card.
 */
function waitForSelectionPaint(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * Keep the no-op/main-third path synchronous. BrowserColumn activation is the
 * only path which needs to cross the save-before-unmount barrier.
 */
function activateExistingContentForNavigation(
  identity: ContentIdentity,
): WorkspaceContentLocation | null | Promise<WorkspaceContentLocation | null> {
  const existing = findExistingWorkspaceContent(identity);
  if (!existing) return null;
  if (existing.host === 'main-third') {
    activateExistingWorkspaceContent(identity);
    return existing;
  }
  return activateExistingWorkspaceContentAsync(identity);
}

function pendingMemoTarget(params: OpenMemoTargetParams): WorkColumnTarget {
  return {
    kind: 'memo',
    memoId: params.memoId,
    path: params.path ?? '',
    notebookId: params.notebookId ?? params.notebook?.id ?? null,
    notebookPath: params.notebookPath ?? params.notebook?.path ?? null,
    transitionId: null,
  };
}

function pendingExternalTarget(
  path: string | null,
  options?: OpenExternalTargetOptions,
): WorkColumnTarget {
  return {
    kind: 'external',
    path: path ?? '',
    scopePath: options?.scopePath ? canonicalPath(options.scopePath) : null,
    transitionId: null,
  };
}

function pendingMediaTarget(params: OpenMediaTargetParams): WorkColumnTarget {
  const resourceKind = params.resourceKind ?? resourceKindFromPath(params.filePath);
  if (resourceKind !== 'image' && resourceKind !== 'video') {
    throw new Error(`Unsupported media resource: ${params.filePath}`);
  }
  return {
    kind: 'media',
    filePath: params.filePath,
    notebookId: params.notebookId ?? null,
    notebookPath: params.notebookPath,
    resourceKind,
  };
}

function pendingArtifactTarget(params: OpenArtifactTargetParams): WorkColumnTarget {
  const noteInfo = getPluginNoteInfo(params.memo);
  const notebook = params.notebook;
  return {
    kind: 'artifact',
    pointerMemoId: params.pointerMemoId.trim(),
    notebookId: params.notebookId ?? notebook?.id ?? null,
    notebookPath: params.notebookPath ?? notebook?.path ?? null,
    pluginId: params.pluginId ?? noteInfo?.pluginId ?? null,
    renderer: params.renderer ?? noteInfo?.renderer ?? null,
  };
}

function beginNavigation(
  pendingTarget: WorkColumnTarget,
  retry: RetryAction | null,
  preservePreviousTarget = false,
  showWorkColumnLoading = true,
): number {
  const previousRetryToken = useWorkColumnStore.getState().navigation.retryToken;
  if (previousRetryToken) retryActions.delete(previousRetryToken);

  const retryToken = retry ? `navigation-retry-${++retrySequence}` : null;
  const requestId = useWorkColumnStore.getState().beginNavigation(
    pendingTarget,
    retryToken,
    preservePreviousTarget,
    showWorkColumnLoading,
  );
  if (retryToken && retry) retryActions.set(retryToken, retry);
  return requestId;
}

function commitNavigation(
  requestId: number,
  target: WorkColumnTarget,
  history: 'push' | 'skip' = 'skip',
): boolean {
  const state = useWorkColumnStore.getState();
  const retryToken = state.navigation.requestId === requestId ? state.navigation.retryToken : null;
  const previousTarget = state.navigation.target;
  const committed = state.commitNavigation(requestId, target);
  if (committed) {
    if (retryToken) retryActions.delete(retryToken);
    if (history === 'push') {
      recordWorkspaceDocumentNavigation(
        historyEntryFromWorkColumnTarget(previousTarget),
        historyEntryFromWorkColumnTarget(target),
      );
    }
    const desiredTarget: PersistedWorkspaceTarget | null = target.kind === 'memo'
      ? { kind: 'memo', memoId: target.memoId }
      : target.kind === 'external' && target.path
        ? { kind: 'external', path: canonicalPath(target.path), scopePath: target.scopePath }
        : target.kind === 'media'
          ? {
              kind: 'media',
              filePath: canonicalPath(target.filePath),
              notebookId: target.notebookId,
              notebookPath: target.notebookPath ? canonicalPath(target.notebookPath) : null,
              resourceKind: target.resourceKind,
            }
        : target.kind === 'agent-conversation'
          ? { kind: 'agent-conversation', instanceId: target.instanceId }
          : null;
    useWorkspaceRestoreStore.getState().setDesiredTarget(desiredTarget);
  }
  return committed;
}

export function captureWorkspaceRestoreTarget(): PersistedWorkspaceTarget | null {
  return useWorkspaceRestoreStore.getState().desiredTarget;
}

export async function restoreExternalDocumentWorkspace(
  restored: Extract<PersistedWorkspaceTarget, { kind: 'external' }>,
): Promise<void> {
  await openExternalTarget(restored.path, {
    scopePath: restored.scopePath,
    history: 'skip',
    destination: 'main-third',
  });
}

export async function restoreMediaWorkspace(
  restored: Extract<PersistedWorkspaceTarget, { kind: 'media' }>,
): Promise<void> {
  await openMediaTarget({
    filePath: restored.filePath,
    notebookId: restored.notebookId,
    notebookPath: restored.notebookPath,
    resourceKind: restored.resourceKind,
    history: 'skip',
  });
}

function isCurrentNavigation(requestId: number): boolean {
  return useWorkColumnStore.getState().isCurrentNavigation(requestId);
}

/** A notebook switch changes list context, not the workColumn target. */
function targetToPreserveOnNotebookSwitch(
  target: WorkColumnTarget,
  document: DocumentSnapshot,
): WorkColumnTarget {
  if (target.kind !== 'empty') return target;
  if (document.activeMemoSession) {
    return {
      kind: 'memo',
      memoId: document.activeMemoSession.memoId,
      path: document.activeMemoSession.fileIdentity.path,
      notebookId: document.activeMemoSession.notebookId,
      notebookPath: document.activeMemoSession.notebookPath,
      transitionId: document.activeMemoSession.transitionId,
    };
  }
  if (document.activeExternalSession) {
    return {
      kind: 'external',
      path: document.activeExternalSession.fileIdentity.path,
      scopePath: document.activeExternalSession.scopePath,
      transitionId: null,
    };
  }
  if (document.activeAgentConversationId) {
    return {
      kind: 'agent-conversation',
      instanceId: document.activeAgentConversationId,
    };
  }
  return EMPTY_WORK_COLUMN_TARGET;
}

async function runNavigation(
  pendingTarget: WorkColumnTarget,
  operation: (requestId: number) => Promise<void>,
  retry: RetryAction,
  rollback?: (requestId: number) => Promise<void>,
  preservePreviousTarget = false,
  showWorkColumnLoading = true,
): Promise<void> {
  const requestId = beginNavigation(
    pendingTarget,
    retry,
    preservePreviousTarget,
    showWorkColumnLoading,
  );
  try {
    await operation(requestId);
  } catch (error) {
    const workspace = useWorkColumnStore.getState();
    if (workspace.isCurrentNavigation(requestId)) {
      // Enter failed before compensation. Selection listeners must not turn a
      // failed navigation into a second, competing clear request.
      workspace.failNavigation(requestId, error);
      try {
        await rollback?.(requestId);
      } catch {
        // The original navigation error is the actionable failure. The
        // best-effort compensation is intentionally not allowed to hide it.
      }
    }
    throw error;
  }
}

function captureDocumentSnapshot(): DocumentSnapshot {
  const { activeMemoSession, activeExternalSession, activeAgentConversationId } = getWorkspaceDocumentState();
  return { activeMemoSession, activeExternalSession, activeAgentConversationId };
}

export function historyEntryFromWorkColumnTarget(
  target: WorkColumnTarget,
): DocumentHistoryEntry | null {
  switch (target.kind) {
    case 'memo': {
      if (!target.path) return null;
      return {
        kind: 'memo',
        memoId: target.memoId,
        notebookId: target.notebookId,
        notebookPath: target.notebookPath,
        path: target.path,
        openedAt: Date.now(),
      };
    }
    case 'external': {
      if (!target.path) return null;
      return {
        kind: 'external',
        path: target.path,
        scopePath: target.scopePath,
        openedAt: Date.now(),
      };
    }
    case 'media': {
      if (!target.filePath) return null;
      return {
        kind: 'media',
        filePath: target.filePath,
        notebookId: target.notebookId,
        notebookPath: target.notebookPath,
        resourceKind: target.resourceKind,
        openedAt: Date.now(),
      };
    }
    case 'agent-conversation':
      return {
        kind: 'agent-conversation',
        instanceId: target.instanceId,
        openedAt: Date.now(),
      };
    case 'artifact':
      if (!target.pointerMemoId) return null;
      return {
        kind: 'artifact',
        pointerMemoId: target.pointerMemoId,
        notebookId: target.notebookId,
        notebookPath: target.notebookPath,
        pluginId: target.pluginId,
        renderer: target.renderer,
        openedAt: Date.now(),
      };
    case 'web':
      if (!canonicalUrl(target.url)) return null;
      return {
        kind: 'web',
        url: target.url,
        openedAt: Date.now(),
      };
    default:
      return null;
  }
}

function selectArtifactMemo(params: OpenArtifactTargetParams): void {
  const state = getWorkspaceMemoState();
  const memo = params.memo
    ?? state.memos?.find((item) => item.id === params.pointerMemoId)
    ?? null;
  if (!memo) return;
  if (!state.memos?.some((item) => item.id === memo.id)) state.upsertMemo?.(memo);
  state.setSelectedMemo(memo);
}

async function restoreDocumentSnapshot(snapshot: DocumentSnapshot): Promise<void> {
  if (snapshot.activeMemoSession) {
    await getWorkspaceDocumentState().openMemoDocument({
      memoId: snapshot.activeMemoSession.memoId,
      path: snapshot.activeMemoSession.fileIdentity.path,
      notebookId: snapshot.activeMemoSession.notebookId,
      notebookPath: snapshot.activeMemoSession.notebookPath,
    });
    return;
  }
  if (snapshot.activeExternalSession) {
    await getWorkspaceDocumentState().openExternalDocument(
      snapshot.activeExternalSession.fileIdentity.path,
      { scopePath: snapshot.activeExternalSession.scopePath },
    );
    return;
  }
  if (snapshot.activeAgentConversationId) {
    await getWorkspaceDocumentState().openAgentConversation(snapshot.activeAgentConversationId);
    return;
  }
  await getWorkspaceDocumentState().clearDocument();
}

export async function retryLastNavigation(): Promise<void> {
  const navigation = useWorkColumnStore.getState().navigation;
  const token = navigation.phase === 'failed' ? navigation.retryToken : null;
  const retry = token ? retryActions.get(token) : undefined;
  if (!retry) throw new Error('No retryable navigation is available');
  await retry();
}

export function dismissNavigationFailure(): void {
  const token = useWorkColumnStore.getState().dismissNavigationFailure();
  if (token) retryActions.delete(token);
}

/** Switch the main workspace notebook as one navigation transaction. */
export async function selectNotebook(notebook: Notebook): Promise<void> {
  const previousMemo = getWorkspaceMemoState().selectedMemo;
  const previousNotebook = getWorkspaceMemoState().selectedNotebook;
  const previousDocument = captureDocumentSnapshot();
  const previousWorkColumnTarget = targetToPreserveOnNotebookSwitch(
    useWorkColumnStore.getState().navigation.target,
    previousDocument,
  );
  const clearPreviousTarget = (previousWorkColumnTarget.kind === 'memo'
    || previousWorkColumnTarget.kind === 'media'
    || previousWorkColumnTarget.kind === 'artifact')
    && previousWorkColumnTarget.notebookId !== notebook.id;
  const nextWorkColumnTarget = clearPreviousTarget
    ? EMPTY_WORK_COLUMN_TARGET
    : previousWorkColumnTarget;
  let switchedNotebook = false;
  useWorkColumnStore.getState().beginNotebookSwitch?.();

  try {
    await runNavigation(
      nextWorkColumnTarget,
      async (requestId) => {
        // Flush first. Changing the backend notebook before this point could
        // make a pending save observe the wrong notebook context. Keep the
        // document session alive so the workColumn remains visible while the
        // notebook and middle-column list change.
        await flushWorkspaceDocument();
        if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;

        await setCurrentWorkspaceNotebook(notebook);
        switchedNotebook = true;
        if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;

        getWorkspaceMemoState().setSelectedNotebook(notebook);
        await getWorkspaceMemoState().loadPathNotes({ notebookId: notebook.id });
        if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
        if (clearPreviousTarget) {
          await getWorkspaceDocumentState().clearDocument();
          if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
          getWorkspaceMemoState().setSelectedMemo(null);
        }
        commitNavigation(requestId, nextWorkColumnTarget);
      },
      () => selectNotebook(notebook),
      async (requestId) => {
        if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
        if (switchedNotebook && previousNotebook?.id) {
          await setCurrentWorkspaceNotebook(previousNotebook);
        }
        if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
        getWorkspaceMemoState().setSelectedNotebook(previousNotebook);
        getWorkspaceMemoState().setSelectedMemo(previousMemo);
        await restoreDocumentSnapshot(previousDocument);
      },
      true,
      clearPreviousTarget,
    );
  } finally {
    useWorkColumnStore.getState().endNotebookSwitch?.();
  }
}

function publishMemoTargetIfCurrent(
  requestId: number,
  memoId: string,
  path: string | null,
  history: 'push' | 'skip',
): boolean {
  const document = getWorkspaceDocumentState();
  const session = document.activeMemoSession;
  if (
    !session
    || session.memoId !== memoId
    || (path !== null && canonicalPath(session.fileIdentity.path) !== canonicalPath(path))
  ) return false;

  return commitNavigation(requestId, {
    kind: 'memo',
    memoId: session.memoId,
    path: session.fileIdentity.path,
    notebookId: session.notebookId,
    notebookPath: session.notebookPath,
    transitionId: session.transitionId,
  }, history);
}

function publishExternalTargetIfCurrent(
  requestId: number,
  path: string | null,
  scopePath: string | null,
  fileBrowser?: import('../store/file-browser-target').FileBrowserContext,
  history: 'push' | 'skip' = 'push',
): boolean {
  const document = getWorkspaceDocumentState();
  const session = document.activeExternalSession;
  if (
    !session
    || path === null
    || canonicalPath(session.fileIdentity.path) !== canonicalPath(path)
    || (scopePath !== null && session.scopePath !== canonicalPath(scopePath))
  ) return false;

  return commitNavigation(requestId, {
    kind: 'external',
    path: session.fileIdentity.path,
    ...(fileBrowser ? { fileBrowser } : {}),
    scopePath: session.scopePath,
    transitionId: session.transitionId,
  }, history);
}

export async function openMemoTarget(
  params: OpenMemoTargetParams,
): Promise<WorkspaceContentLocation | null> {
  let promotedExternalTab: BrowserColumnTab | null = null;
  const previousFocusHostId = useWorkspaceFocusStore.getState().focusedHostId;
  const memoPath = params.path ? canonicalPath(params.path) : null;
  if (memoPath) {
    const activeExternal = getWorkspaceDocumentState().activeExternalSession;
    if (activeExternal && canonicalPath(activeExternal.fileIdentity.path) === memoPath) {
      const externalIdentity = documentIdentityFromFile(ensureFileDisplayIdentity(memoPath));
      const flushed = await flushWorkspaceDocumentPath(
        externalIdentity,
        memoPath,
        activeExternal.scopePath,
      );
      if (!flushed || !await waitForWorkspaceDocumentSaves(externalIdentity)) {
        throw new Error('Memo open cancelled because the external document save did not complete');
      }
    }

    const identity: ContentIdentity = {
      kind: 'memo',
      memoId: params.memoId,
      path: memoPath,
    };
    const existing = params.destination === 'main-third'
      ? null
      : findExistingWorkspaceContent(identity);
    const openExternalTab = existing?.host === 'browser-column'
      ? useBrowserColumnStore.getState().tabs.find((tab) => tab.id === existing.tabId)
      : null;
    const isSameBrowserExternalSurface = openExternalTab?.target.kind === 'file-browser'
      && !!openExternalTab.target.activeFilePath
      && canonicalPath(openExternalTab.target.activeFilePath) === memoPath;
    if (existing && isSameBrowserExternalSurface) {
      // Flush the external editor before changing its persistence semantics.
      // Keep its tab id and path identity, but make it a Memo surface so later
      // edits use the Memo save channel and expose Memo-specific operations.
      const activated = await activateExistingWorkspaceContentAsync(identity);
      if (activated?.host === 'browser-column') {
        const runtimeIdentity = documentIdentityFromFile(
          ensureFileDisplayIdentity(memoPath),
          params.memoId,
        );
        if (!await waitForWorkspaceDocumentSaves(runtimeIdentity)) {
          throw new Error('Memo open cancelled because the external document save did not complete');
        }
        const tab = useBrowserColumnStore.getState().tabs.find(
          (candidate) => candidate.id === activated.tabId,
        );
        if (tab?.target.kind === 'file-browser'
          && tab.target.activeFilePath
          && canonicalPath(tab.target.activeFilePath) === memoPath) {
          promotedExternalTab = tab;
          useBrowserColumnStore.getState().openTab({
            ...tab,
            target: {
              kind: 'memo',
              memoId: params.memoId,
              notebookId: params.notebookId ?? params.notebook?.id ?? '',
              notebookPath: params.notebookPath ?? params.notebook?.path ?? '',
              filePath: memoPath,
            },
          }, 'focus-existing');
        }
      }
    }
  }

  const previousMemo = getWorkspaceMemoState().selectedMemo;
  const previousNotebook = getWorkspaceMemoState().selectedNotebook;
  const previousDocument = captureDocumentSnapshot();
  const notebookId = params.notebookId ?? params.notebook?.id ?? null;
  const memo = params.memo ?? null;
  let switchedNotebook = false;

  await runNavigation(
    pendingMemoTarget(params),
    async (requestId) => {
      let targetNotebook = params.notebook
        ?? getWorkspaceMemoState().notebooks.find((item) => item.id === notebookId)
        ?? null;
      const currentNotebookId = getWorkspaceMemoState().selectedNotebookId
        ?? getWorkspaceMemoState().selectedNotebook?.id
        ?? null;

      if (notebookId && currentNotebookId !== notebookId) {
        await setCurrentWorkspaceNotebook(notebookId);
        switchedNotebook = true;
        if (!isCurrentNavigation(requestId)) return;

        if (!targetNotebook) {
          await getWorkspaceMemoState().loadNotebooks();
          if (!isCurrentNavigation(requestId)) return;
          targetNotebook = getWorkspaceMemoState().notebooks.find(
            (item) => item.id === notebookId,
          ) ?? null;
        }
        if (memo && !targetNotebook) {
          throw new Error(`Notebook is unavailable: ${notebookId}`);
        }
        if (targetNotebook) {
          getWorkspaceMemoState().setSelectedNotebook(targetNotebook);
          if (!isCurrentNavigation(requestId)) return;
        }
        await getWorkspaceMemoState().loadPathNotes({ notebookId });
        if (!isCurrentNavigation(requestId)) return;
      }

      if (!isCurrentNavigation(requestId)) return;
      if (memo) {
        const latest = getWorkspaceMemoState();
        // Create already inserted its authoritative item before navigation.
        if (params.initialContent === undefined) latest.upsertMemo(memo);
        latest.setSelectedMemo(memo);
        if (!isCurrentNavigation(requestId)) return;

        // Selection and document switching used to happen in the same turn.
        // For a large outgoing document, the editor flush then occupied the
        // main thread before the selected card background got a paint. Keep
        // the selection responsive and start the document transition after
        // that visual update has actually had a chance to render.
        if (params.initialContent === undefined) await waitForSelectionPaint();
        if (!isCurrentNavigation(requestId)) return;
      }

      const {
        memo: _memo,
        notebook: _notebook,
        history: _history,
        ...documentParams
      } = params;
      if (!isCurrentNavigation(requestId)) return;
      await getWorkspaceDocumentState().openMemoDocument({
        ...documentParams,
        notebookPath: params.notebookPath ?? targetNotebook?.path ?? null,
      });

      // A newer intent may have started while the document transition was
      // queued. Its session and target must remain authoritative.
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      if (!publishMemoTargetIfCurrent(
        requestId,
        params.memoId,
        params.path,
        params.history ?? 'push',
      )) {
        throw new Error(`Memo session was not committed: ${params.memoId}`);
      }
      useWorkspaceFocusStore.getState().focusHost('main-third');
    },
    async () => {
      await openMemoTarget(params);
    },
    async (requestId) => {
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      await restoreDocumentSnapshot(previousDocument);
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      if (memo && getWorkspaceMemoState().selectedMemo?.id === memo.id) {
        getWorkspaceMemoState().setSelectedMemo(previousMemo);
      }
      if (switchedNotebook) {
        const previousNotebookId = previousNotebook?.id ?? null;
        if (previousNotebookId) await setCurrentWorkspaceNotebook(previousNotebookId);
        getWorkspaceMemoState().setSelectedNotebook(previousNotebook);
      }
      if (promotedExternalTab) {
        const currentTab = useBrowserColumnStore.getState().tabs.find(
          (candidate) => candidate.id === promotedExternalTab?.id,
        );
        if (currentTab?.target.kind === 'memo'
          && currentTab.target.memoId === params.memoId
          && canonicalPath(currentTab.target.filePath) === memoPath) {
          useBrowserColumnStore.getState().openTab(promotedExternalTab, 'focus-existing');
        }
        useWorkspaceFocusStore.getState().focusHost(previousFocusHostId);
      }
    },
  );
  return null;
}

export async function openExternalTarget(
  path: string | null,
  options?: OpenExternalTargetOptions,
): Promise<WorkspaceContentLocation | null> {
  const fileBrowser = options?.fileBrowser ?? captureFileBrowserContext(path, options?.scopePath);
  options = { ...options, fileBrowser, scopePath: options?.scopePath ?? fileBrowser.scopePath };
  const existing = path && options?.destination !== 'main-third'
    ? activateExistingContentForNavigation({ kind: 'external', path })
    : null;
  if (existing instanceof Promise) {
    const activated = await existing;
    if (activated) return activated;
  } else if (existing) {
    return existing;
  }

  const previousMemo = getWorkspaceMemoState().selectedMemo;
  const previousDocument = captureDocumentSnapshot();
  await runNavigation(
    pendingExternalTarget(path, options),
    async (requestId) => {
      getWorkspaceMemoState().setSelectedMemo(null);
      if (!isCurrentNavigation(requestId)) return;
      await getWorkspaceDocumentState().openExternalDocument(
        path,
        { scopePath: options?.scopePath },
      );
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      const scopePath = options?.scopePath ? canonicalPath(options.scopePath) : null;
      if (path === null && !getWorkspaceDocumentState().activeExternalSession) {
        commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
      } else if (!publishExternalTargetIfCurrent(
        requestId,
        path,
        scopePath,
        fileBrowser,
        options?.history ?? 'push',
      )) {
        throw new Error(`External document session was not committed: ${path}`);
      }
    },
    async () => {
      await openExternalTarget(path, options);
    },
    async (requestId) => {
      if (!isCurrentNavigation(requestId)) return;
      await restoreDocumentSnapshot(previousDocument);
      if (!isCurrentNavigation(requestId)) return;
      if (!getWorkspaceMemoState().selectedMemo) {
        getWorkspaceMemoState().setSelectedMemo(previousMemo);
      }
    },
  );
  return null;
}

/** Open an image/video as a resource surface, without creating a document session. */
export async function openMediaTarget(
  params: OpenMediaTargetParams,
): Promise<WorkspaceContentLocation | null> {
  const filePath = params.filePath.trim();
  if (!filePath || !params.notebookPath?.trim()) return null;
  const target = pendingMediaTarget({ ...params, filePath });
  const existing = params.destination === 'main-third'
    ? null
    : activateExistingContentForNavigation({ kind: 'media', path: filePath });
  if (existing instanceof Promise) {
    const activated = await existing;
    if (activated) return activated;
  } else if (existing) {
    return existing;
  }

  const previousMemo = getWorkspaceMemoState().selectedMemo;
  const previousDocument = captureDocumentSnapshot();
  await runNavigation(
    target,
    async (requestId) => {
      await flushWorkspaceDocument();
      if (!isCurrentNavigation(requestId)) return;
      await getWorkspaceDocumentState().clearDocument();
      if (!isCurrentNavigation(requestId)) return;
      getWorkspaceMemoState().setSelectedMemo(null);
      if (!commitNavigation(requestId, target, params.history ?? 'push')) return;
      useWorkspaceFocusStore.getState().focusHost('main-third');
    },
    async () => { await openMediaTarget(params); },
    async (requestId) => {
      if (!isCurrentNavigation(requestId)) return;
      await restoreDocumentSnapshot(previousDocument);
      if (!isCurrentNavigation(requestId)) return;
      getWorkspaceMemoState().setSelectedMemo(previousMemo);
    },
  );
  return null;
}

/** Open a web target in the left work column. */
export async function openWebTarget(
  url: string,
  options?: { history?: 'push' | 'skip'; destination?: 'main-third' },
): Promise<WorkspaceContentLocation | null> {
  const normalized = canonicalUrl(url);
  if (!normalized) throw new Error(`Unsupported webpage URL: ${url}`);

  const existing = options?.destination === 'main-third'
    ? null
    : activateExistingContentForNavigation({ kind: 'web', url: normalized });
  if (existing instanceof Promise) {
    const activated = await existing;
    if (activated) return activated;
  } else if (existing) {
    return existing;
  }

  const target: WorkColumnTarget = { kind: 'web', url: normalized };
  await runNavigation(
    target,
    async (requestId) => {
      await flushWorkspaceDocument();
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(requestId, target, options?.history ?? 'push');
      useWorkspaceFocusStore.getState().focusHost('main-third');
    },
    async () => { await openWebTarget(normalized, options); },
  );
  return null;
}

/**
 * Open a durable pointer-memo artifact without creating an editable memo
 * session. The host artifact service owns loading and fallback behavior; this
 * target only records which artifact the workColumn should display.
 */
export async function openArtifactTarget(
  params: OpenArtifactTargetParams,
): Promise<WorkspaceContentLocation | null> {
  const pointerMemoId = params.pointerMemoId.trim();
  if (!pointerMemoId) return null;

  const target = pendingArtifactTarget({ ...params, pointerMemoId });
  await runNavigation(
    target,
    async (requestId) => {
      // Artifact rendering is independent from the editable document session,
      // but pending edits must be durable before the workColumn leaves that
      // document surface underneath the artifact.
      await flushWorkspaceDocument();
      if (!isCurrentNavigation(requestId)) return;
      if (!commitNavigation(requestId, target, params.history ?? 'push')) return;
      selectArtifactMemo(params);
      useWorkspaceFocusStore.getState().focusHost('main-third');
    },
    async () => { await openArtifactTarget(params); },
  );
  return null;
}

/** Flush the active editable document without clearing its session or target. */
export async function flushWorkspaceDocument(): Promise<void> {
  const document = getWorkspaceDocumentState();
  let flushed = true;

  if (document.activeMemoSession) {
    flushed = await flushWorkspaceDocumentPath(
      documentIdentityFromFile(
        document.activeMemoSession.fileIdentity,
        document.activeMemoSession.memoId,
      ),
      document.activeMemoSession.fileIdentity.path,
    );
  } else if (document.activeExternalSession) {
    flushed = await flushWorkspaceDocumentPath(
      documentIdentityFromFile(document.activeExternalSession.fileIdentity),
      document.activeExternalSession.fileIdentity.path,
      document.activeExternalSession.scopePath,
    );
  }

  if (!flushed) {
    throw new Error('Document flush did not complete');
  }
}

export async function openAgentTarget(
  instanceId: string,
  options?: { history?: 'push' | 'skip'; destination?: 'main-third' },
): Promise<WorkspaceHostId | WorkspaceContentLocation> {
  const normalized = instanceId.trim();
  if (!normalized) return 'main-third';
  const existing = options?.destination === 'main-third'
    ? null
    : activateExistingContentForNavigation({
        kind: 'agent-conversation',
        instanceId: normalized,
      });
  if (existing instanceof Promise) {
    const activated = await existing;
    if (activated) return activated;
  } else if (existing) {
    return existing;
  }
  await runNavigation(
    { kind: 'agent-conversation', instanceId: normalized },
    async (requestId) => {
      await getWorkspaceDocumentState().openAgentConversation(
        normalized,
      );
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      if (getWorkspaceDocumentState().activeAgentConversationId !== normalized) {
        throw new Error(`Agent session was not committed: ${normalized}`);
      }
      getWorkspaceMemoState().setActivePluginId(null);
      getWorkspaceMemoState().setSelectedMemo(null);
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(
        requestId,
        { kind: 'agent-conversation', instanceId: normalized },
        options?.history ?? 'push',
      );
    },
    async () => {
      await openAgentTarget(normalized, options);
    },
  );
  return 'main-third';
}

export async function clearWorkspaceDocument(): Promise<void> {
  await runNavigation(
    EMPTY_WORK_COLUMN_TARGET,
    async (requestId) => {
      await getWorkspaceDocumentState().clearDocument();
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      const document = getWorkspaceDocumentState();
      if (document.activeMemoSession || document.activeExternalSession || document.activeAgentConversationId) {
        throw new Error('Document session was not cleared');
      }
      commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
    },
    () => clearWorkspaceDocument(),
  );
}

export function replaceActiveMemoPath(memoId: string, path: string): void {
  const nextPath = canonicalPath(path);
  if (!memoId || !nextPath) return;
  const current = getWorkspaceDocumentState().activeMemoSession;
  const activeMemo = current?.memoId === memoId ? current : null;
  const navigation = useWorkColumnStore.getState().navigation;
  const tabs = useBrowserColumnStore.getState().tabs;
  const previousPaths = new Set<string>();
  if (activeMemo?.fileIdentity.path) previousPaths.add(canonicalPath(activeMemo.fileIdentity.path));
  for (const target of [navigation.target, navigation.pendingTarget, navigation.previousTarget]) {
    if (target?.kind === 'memo' && target.memoId === memoId && target.path) {
      previousPaths.add(canonicalPath(target.path));
    }
  }
  for (const tab of tabs) {
    if (tab.target.kind === 'memo' && tab.target.memoId === memoId && tab.target.filePath) {
      previousPaths.add(canonicalPath(tab.target.filePath));
    }
  }

  const hasStalePath = [...previousPaths].some((previousPath) => previousPath !== nextPath);
  const activePathChanged = !!activeMemo && canonicalPath(activeMemo.fileIdentity.path) !== nextPath;
  if (!hasStalePath && !activePathChanged) {
    replaceWorkspaceMemoHistoryPath(memoId, nextPath);
    return;
  }

  const resumeDisplayIdReconciliation = suspendFileDisplayReconciliation();
  try {
    for (const previousPath of previousPaths) {
      if (previousPath === nextPath) continue;
      const displayId = activeMemo?.fileIdentity.path && canonicalPath(activeMemo.fileIdentity.path) === previousPath
        ? activeMemo.fileIdentity.displayId
        : findFileDisplayId(previousPath) ?? findFileDisplayId(nextPath);
      if (!displayId) continue;
      // A Memo rename can also have legacy file-browser/external references to
      // the same path. Rebase their shared file identity before updating tabs.
      replaceWorkspaceDocumentPath({
        kind: 'md',
        memoId,
        path: previousPath,
        displayId,
      }, nextPath);
    }

    if (activeMemo && canonicalPath(activeMemo.fileIdentity.path) !== nextPath) {
      const requestId = beginNavigation({
        kind: 'memo',
        memoId,
        path: nextPath,
        notebookId: activeMemo.notebookId,
        notebookPath: activeMemo.notebookPath,
        transitionId: null,
      }, null);
      getWorkspaceDocumentState().replaceActiveMemoPath(memoId, nextPath);
      useWorkColumnStore.getState().replaceMemoPath(memoId, nextPath);
      publishMemoTargetIfCurrent(requestId, memoId, nextPath, 'skip');
    } else if (!activeMemo) {
      getWorkspaceDocumentState().replaceActiveMemoPath(memoId, nextPath);
      useWorkColumnStore.getState().replaceMemoPath(memoId, nextPath);
    }
    useBrowserColumnStore.getState().replaceMemoPath(memoId, nextPath);
    replaceWorkspaceMemoHistoryPath(memoId, nextPath);
  } finally {
    resumeDisplayIdReconciliation();
  }
}

/** Update every live reference to an external file after an in-place rename. */
export function replaceExternalDocumentPath(
  displayId: string,
  previousPath: string,
  path: string,
): void {
  const previous = canonicalPath(previousPath);
  const next = canonicalPath(path);

  const resumeDisplayIdReconciliation = suspendFileDisplayReconciliation();
  try {
    replaceWorkspaceDocumentPath({
      kind: 'md',
      memoId: null,
      path: previous,
      displayId,
    }, next);
    useWorkColumnStore.getState().replaceExternalPath(previous, next);
    useBrowserColumnStore.getState().replaceExternalPath(previous, next);
    const restored = useWorkspaceRestoreStore.getState().desiredTarget;
    if (restored?.kind === 'external' && canonicalPath(restored.path) === previous) {
      useWorkspaceRestoreStore.getState().setDesiredTarget({
        ...restored,
        path: next,
      });
    }
  } finally {
    resumeDisplayIdReconciliation();
  }
}

export async function discardMemoDocument(memoId: string): Promise<void> {
  await runNavigation(
    EMPTY_WORK_COLUMN_TARGET,
    async (requestId) => {
      await getWorkspaceDocumentState().discardMemoDocument(memoId);
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      const document = getWorkspaceDocumentState();
      const target = useWorkColumnStore.getState().navigation.target;
      if (
        target.kind === 'memo'
        && target.memoId === memoId
        && !document.activeMemoSession
      ) {
        commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
      } else {
        commitNavigation(requestId, target);
      }
    },
    () => discardMemoDocument(memoId),
  );
}

export function closeAgentTarget(): void {
  const workspace = useWorkColumnStore.getState();
  const wasActive = !!getWorkspaceDocumentState().activeAgentConversationId
    || workspace.navigation.target.kind === 'agent-conversation';
  const requestId = wasActive ? beginNavigation(EMPTY_WORK_COLUMN_TARGET, null) : null;
  getWorkspaceDocumentState().closeAgentConversation();
  if (requestId !== null && !getWorkspaceDocumentState().activeAgentConversationId) {
    commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
  }
}

/**
 * Leave the plugin workbench target without touching the active document.
 * Artifact-tool plugins use this path because they are second-column filters
 * and must preserve whatever the third column is currently showing.
 */
export function clearPluginWorkbenchTarget(): boolean {
  const workspace = useWorkColumnStore.getState();
  if (workspace.navigation.target.kind !== 'plugin-workbench') return false;
  const requestId = beginNavigation(EMPTY_WORK_COLUMN_TARGET, null);
  commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
  return true;
}

/** Close the artifact surface while preserving any underlying document. */
export function closeArtifactTarget(): boolean {
  const workspace = useWorkColumnStore.getState();
  if (workspace.navigation.target.kind !== 'artifact') return false;
  const restoredTarget = workspace.navigation.previousTarget ?? EMPTY_WORK_COLUMN_TARGET;
  const requestId = beginNavigation(EMPTY_WORK_COLUMN_TARGET, null);
  commitNavigation(requestId, restoredTarget);
  return true;
}

/** Open a document-independent plugin workbench after the current document is flushed. */
export async function openPluginWorkbench(plugin: PluginDescriptor): Promise<void> {
  await runNavigation(
    { kind: 'plugin-workbench', plugin },
    async (requestId) => {
      await getWorkspaceDocumentState().clearDocument();
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      getWorkspaceMemoState().setSelectedMemo(null);
      getWorkspaceMemoState().setActiveFilter('all');
      getWorkspaceMemoState().setActivePluginId(plugin.manifest.id);
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(requestId, { kind: 'plugin-workbench', plugin });
    },
    () => openPluginWorkbench(plugin),
  );
}

/** Close the plugin workbench and clear the document it owns, if any. */
export async function closePluginWorkbench(): Promise<boolean> {
  const workspace = useWorkColumnStore.getState();
  const previousTarget = workspace.navigation.target;
  if (previousTarget.kind !== 'plugin-workbench') return false;
  await runNavigation(
    EMPTY_WORK_COLUMN_TARGET,
    async (requestId) => {
      await getWorkspaceDocumentState().clearDocument();
      if (!useWorkColumnStore.getState().isCurrentNavigation(requestId)) return;
      getWorkspaceMemoState().setSelectedMemo(null);
      getWorkspaceMemoState().setActivePluginId(null);
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
    },
    () => closePluginWorkbench().then(() => undefined),
  );
  return true;
}

/** Reconcile local selection after an already-confirmed notebook deletion. */
export async function reconcileDeletedNotebook(
  deletedNotebookId: string,
  notebooks: Notebook[],
): Promise<void> {
  const wasSelected = (getWorkspaceMemoState().selectedNotebookId
    ?? getWorkspaceMemoState().selectedNotebook?.id
    ?? null) === deletedNotebookId;

  if (!wasSelected) {
    getWorkspaceMemoState().setNotebooks(notebooks);
    return;
  }

  const nextNotebook = notebooks[0] ?? null;
  const reconcile = () => runNavigation(
    EMPTY_WORK_COLUMN_TARGET,
    async (requestId) => {
      // Apply the replacement list and fallback selection atomically. This
      // prevents the main-window notebook sync effect from observing a brief
      // null selection between removing the active notebook and selecting the
      // first remaining notebook.
      getWorkspaceMemoState().setNotebooks(notebooks, nextNotebook?.id ?? null);
      await getWorkspaceDocumentState().clearDocument();
      if (!isCurrentNavigation(requestId)) return;

      await setCurrentWorkspaceNotebook(nextNotebook);
      if (!isCurrentNavigation(requestId)) return;

      getWorkspaceMemoState().setSelectedNotebook(nextNotebook);
      getWorkspaceMemoState().setSelectedMemo(null);
      if (nextNotebook) {
        await getWorkspaceMemoState().loadPathNotes({ notebookId: nextNotebook.id });
        if (!isCurrentNavigation(requestId)) return;
      } else {
        getWorkspaceMemoState().setMemos([]);
      }
      commitNavigation(requestId, EMPTY_WORK_COLUMN_TARGET);
    },
    reconcile,
  );

  await reconcile();
}
