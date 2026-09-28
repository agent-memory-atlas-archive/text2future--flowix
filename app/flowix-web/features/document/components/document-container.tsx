'use client';

import { getDocumentSession } from '../store/document-runtime-session';
import { rebaseWorkspaceDocumentPath } from '../public/workspace-api';

import { useEffect, useCallback, useRef, useMemo } from 'react';
import { useMemoStore } from '@features/memo/store/memo-store';
import {
  applyLoadedDocumentContent,
  captureLatestDocumentContent,
  hasDocumentUnsavedChanges,
} from '@features/document/store/document-session-service';
import { useDocumentMetricsStore } from '@features/document/store/document-metrics-store';
import { useDocumentStore } from '@features/document/store/document-store';
import {
  setDocumentEditorMode,
  useDocumentEditorMode,
} from '@features/document/store/document-editor-view-store';
import {
  documentIdentityFromFile,
  documentPropertyTargetId,
} from '@features/document/store/document-identity';
import { canonicalPath, fileNameFromPath } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { product } from '@platform/tauri/client/desktop';
import { localDocumentOperations } from '@features/document/use-cases/local-document-operations';
import { memoDocumentOperations } from '@features/document/use-cases/memo-document-operations';
import { openPath } from '@platform/tauri/opener';
import {
  initialDocumentContainerState,
  type DocumentContainerProps,
} from '@features/document/components/session/types';
import {
  countTextUnits,
  extractBodyContent,
} from '@features/document/components/session/document-utils';
import { useDocumentContent } from '@features/document/components/session/use-document-content';
import { useDocumentAutosave } from '@features/document/components/session/use-document-autosave';
import { useExternalDocumentChangeWatch } from '@features/document/components/session/use-external-document-change-watch';
import { useMemoDocumentChangeWatch } from '@features/document/components/session/use-memo-document-change-watch';
import {
  LazyDocumentEditor,
  preloadDocumentEditor,
} from '@features/document/components/lazy-document-editor';
import { LazyCodeEditor } from '@features/document/components/lazy-code-editor';
import { MemoDocumentHeader } from '@features/document/components/memo-document-header';
import type {
  MemoTitleBodyNavigation,
  MemoTitleEditorHandle,
} from '@features/document/components/memo-title-editor';
import type { RenameDocumentTitle } from '@features/document/components/memo-title-session';
import type { MarkdownEditorHandle } from '@features/editor/markdown-editor';
import type { ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import { useI18n } from '@/lib/i18n';
import { CenteredLoadingSpinner } from '@shared/ui/centered-loading-spinner';
import { WorkspaceEmptyState } from '@shared/ui/workspace-empty-state';
import {
  clearWorkspaceDocument,
  replaceExternalDocumentPath,
} from '@features/workspace/use-cases/workspace-navigation';
import { removeBrowserColumnTabsByMemoId } from '@features/workspace/use-cases/browser-column-navigation';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { getBuffer, subscribeDocumentBufferChanges } from '@features/document/store/buffer-registry';
import { documentIdentityKey } from '@features/document/store/document-identity';
import {
  beginExternalDocumentRename,
  expectExternalDocumentWrite,
  isExternalDocumentRenameInProgress,
} from '@features/document/store/external-document-operation';
import { rebaseActiveDocumentPath } from '@features/document/store/document-session-service';
import { syncMemoPathAfterLocalWrite } from '@features/document/use-cases/sync-memo-path-after-local-write';
import type { Editor } from '@tiptap/core';

function externalMarkdownTitleParts(path: string): { title: string; extension: string } {
  const filename = fileNameFromPath(path);
  const extensionMatch = filename.match(/(\.markdown|\.md)$/i);
  const extension = extensionMatch?.[0] ?? '';
  return {
    title: extension ? filename.slice(0, -extension.length) : filename,
    extension,
  };
}

export function DocumentContainer({
  fileIdentity,
  memoId = null,
  notebookPath = null,
  transitionId = null,
  onMetainfoData,
  isExternalDocument = false,
  externalScopePath = null,
  externalEditorMode = 'code',
  searchPanelOpen = false,
  onSearchPanelOpenChange,
  toolbarCollapsed = false,
  onToolbarCollapsedChange,
  documentSessionMode = 'main',
  readOnly: forcedReadOnly = false,
  initialFocus,
  onEditorReady,
  onFlushReady,
}: DocumentContainerProps) {
  const filePath = fileIdentity.path;
  const displayId = fileIdentity.displayId;
  const { t } = useI18n();
  const hostId = documentSessionMode === 'isolated' ? 'browser-column' : 'main-third';
  const focusedHostId = useWorkspaceFocusStore((store) => store.focusedHostId);
  const readOnly = forcedReadOnly || focusedHostId !== hostId;
  const containerRef = useRef<HTMLDivElement>(null);
  const resolvedExternalDisplayId = isExternalDocument ? displayId : null;
  const documentInstanceKey = useMemo(
    () => `md:${displayId}`,
    [displayId]
  );
  const documentIdentity = getDocumentSession(
    documentIdentityFromFile({ path: filePath, displayId }, memoId ?? null),
  ).identity;
  const propertyTargetId = documentPropertyTargetId(displayId);
  const editorMode = useDocumentEditorMode(hostId, documentIdentity);
  // Rich/source mode belongs to the open Markdown file identity. Non-Markdown
  // external files retain their independent CodeMirror presentation setting.
  const usesCodeEditor = isExternalDocument
    ? externalEditorMode === 'code' || editorMode === 'source'
    : editorMode === 'source';
  const loadedDocumentInstanceKeyRef = useRef<string | null>(null);
  const editorHandleRef = useRef<MarkdownEditorHandle | null>(null);
  const titleEditorRef = useRef<MemoTitleEditorHandle | null>(null);
  const memoFilename = fileNameFromPath(filePath);
  const renameInProgressRef = useRef(false);
  const getCurrentFilePath = useCallback(() => documentIdentity.path, [documentIdentity]);
  const {
    state,
    setState,
    reloadDocument,
  } = useDocumentContent({
    identity: documentIdentity,
    memoId,
    notebookPath,
    isExternalDocument,
    externalScopePath,
    transitionId,
    isolatedSession: documentSessionMode === 'isolated',
  });

  useEffect(() => {
    if (usesCodeEditor) onEditorReady?.(null);
    return () => onEditorReady?.(null);
  }, [onEditorReady, usesCodeEditor]);

  useEffect(() => {
    if (
      transitionId === null
      || usesCodeEditor
    ) {
      return;
    }
    preloadDocumentEditor();
  }, [transitionId, usesCodeEditor]);
  const flushPendingEditorChanges = useCallback(() => {
    return editorHandleRef.current?.flushPendingChanges() ?? null;
  }, []);
  const handleEditorScroll = useCallback((scrollTop: number) => {
    const isScrolled = scrollTop > 90;
    setState((prev) => (
      prev.isScrolled === isScrolled
        ? prev
        : { ...prev, isScrolled }
    ));
  }, [setState]);

  const handleMoveTitleToBody = useCallback(({
    trailingContent,
    insertEmptyLine,
  }: MemoTitleBodyNavigation) => {
    if (!insertEmptyLine) {
      editorHandleRef.current?.focusStart?.();
      return;
    }
    const moveToBody = () => editorHandleRef.current?.moveTitleToBody?.(trailingContent ?? '');
    if (isExternalDocument) requestAnimationFrame(moveToBody);
    else moveToBody();
  }, [isExternalDocument]);

  const handlePasteTitleContentToBody = useCallback((snapshot: ClipboardSnapshot) => {
    editorHandleRef.current?.pasteToBody?.(snapshot);
  }, []);

  const handleToggleEditorMode = useCallback(() => {
    if (isExternalDocument && externalEditorMode !== 'markdown') return;
    captureLatestDocumentContent(documentIdentity, hostId);
    setDocumentEditorMode(
      hostId,
      documentIdentity,
      editorMode === 'source' ? 'rich' : 'source',
    );
  }, [documentIdentity, editorMode, externalEditorMode, hostId, isExternalDocument]);

  // The title editor owns file-scoped draft/IME state. The cache ID only
  // updates legacy memo metadata when it is available; the rename address is the path.
  const renameDocumentTitle = useCallback(async (title: string, expectedFilename: string) => {
    if (title === displayTitleFromFilename(expectedFilename)) return expectedFilename;
    {
      const result = await memoDocumentOperations.renameTitle({
        path: getCurrentFilePath(),
        title,
        expectedFilename,
        expectedContent: state.fullContent,
      });
      rebaseWorkspaceDocumentPath(documentIdentity, result.path);
      if (result.memo) useMemoStore.getState().handleMemoUpdated(result.memo);
      if (memoId) syncMemoPathAfterLocalWrite(memoId, result.path);
      return result.filename;
    }
  }, [displayId, documentIdentity, memoId, state.fullContent]);


  const {
    clearSaveTimer,
    flushDocument,
    discardDocument,
    handleChange,
    handleDirty,
  } = useDocumentAutosave({
    filePath,
    getCurrentFilePath,
    identity: documentIdentity,
    memoId,
    isExternalDocument,
    externalScopePath,
    setState,
    reloadDocument,
    flushPendingContent: flushPendingEditorChanges,
    hostId,
    isActive: () => !forcedReadOnly && useWorkspaceFocusStore.getState().focusedHostId === hostId,
    isolatedSession: documentSessionMode === 'isolated',
  });

  const commitExternalTitle = useCallback(async (
    requestedTitle: string,
    expectedFilename: string,
    options?: { expectBodyMutation?: boolean },
  ): Promise<string | null> => {
    if (
      renameInProgressRef.current
      || (resolvedExternalDisplayId && isExternalDocumentRenameInProgress(resolvedExternalDisplayId))
      || !isExternalDocument
      || externalEditorMode !== 'markdown'
      || !externalScopePath
      || !resolvedExternalDisplayId
    ) return null;

    const currentPath = getCurrentFilePath();
    const currentFilename = fileNameFromPath(currentPath);
    if (currentFilename !== expectedFilename) {
      throw new Error(t('document.save.externalChanged'));
    }

    const current = externalMarkdownTitleParts(currentPath);
    let nextTitle = requestedTitle.trim();
    if (current.extension && nextTitle.toLowerCase().endsWith(current.extension.toLowerCase())) {
      nextTitle = nextTitle.slice(0, -current.extension.length).trimEnd();
    }
    if (!nextTitle || nextTitle === '.' || nextTitle === '..') return null;
    if (nextTitle === current.title) {
      if (options?.expectBodyMutation) expectExternalDocumentWrite(currentPath);
      return currentFilename;
    }

    renameInProgressRef.current = true;
    let renameOperation: ReturnType<typeof beginExternalDocumentRename> | null = null;
    try {
      if (
        getCurrentFilePath() !== currentPath
        || isExternalDocumentRenameInProgress(resolvedExternalDisplayId)
      ) return null;

      // Keep editing live. Saves started during the filesystem rename wait for
      // this operation and then resolve the new path before writing.
      renameOperation = beginExternalDocumentRename(resolvedExternalDisplayId);
      const cancelExpectedDelete = renameOperation.expectSourceDelete(currentPath);
      let newPath: string;
      try {
        ({ path: newPath } = await localDocumentOperations.rename({
          path: currentPath,
          name: `${nextTitle}${current.extension}`,
          scopePath: externalScopePath,
        }));
      } catch (error) {
        cancelExpectedDelete();
        throw error;
      }
      const normalizedNewPath = canonicalPath(newPath);
      if (options?.expectBodyMutation) {
        // Boundary edits continue the rename by writing the changed body at
        // the new path. A plain filename edit does not reserve this event.
        renameOperation.expectFollowupWrite(normalizedNewPath);
      }
      // Publish the new path synchronously for editor callbacks created by the
      // previous render. React/store propagation can complete afterwards.
      replaceExternalDocumentPath(resolvedExternalDisplayId, currentPath, normalizedNewPath);
      return fileNameFromPath(normalizedNewPath);
    } finally {
      renameOperation?.finish();
      renameInProgressRef.current = false;
    }
  }, [
    clearSaveTimer,
    documentIdentity,
    externalEditorMode,
    externalScopePath,
    flushDocument,
    isExternalDocument,
    resolvedExternalDisplayId,
    t,
  ]);

  useEffect(() => {
    const key = documentIdentityKey(documentIdentity);
    const sync = () => {
      const buffer = getBuffer(documentIdentity);
      if (!buffer) return;
      const content = buffer.content;
      const textUnits = countTextUnits(extractBodyContent(content));
      const tokenCount = Math.ceil(textUnits / 4);
      setState((prev) => (
        prev.fullContent === content
        && prev.charCount === textUnits
        && prev.tokenCount === tokenCount
          ? prev
          : {
              ...prev,
              fullContent: content,
              charCount: textUnits,
              tokenCount,
            }
      ));
    };
    const unsubscribeBuffer = subscribeDocumentBufferChanges((identity) => {
      if (documentIdentityKey(identity) === key) sync();
    });
    const unsubscribeFocus = useWorkspaceFocusStore.subscribe((next, previous) => {
      if (previous.focusedHostId === hostId && next.focusedHostId !== hostId) {
        // Finish composition and publish the outgoing editor before React
        // enables the incoming surface. Disk persistence remains debounced.
        const active = document.activeElement;
        if (active instanceof HTMLElement && containerRef.current?.contains(active)) active.blur();
        captureLatestDocumentContent(documentIdentity, hostId);
      }
    });
    return () => {
      unsubscribeBuffer();
      unsubscribeFocus();
    };
  }, [documentIdentity, flushPendingEditorChanges, hostId, setState]);

  useEffect(() => {
    onFlushReady?.(flushDocument, discardDocument);
    return () => onFlushReady?.(null, null);
  }, [discardDocument, flushDocument, onFlushReady]);
  useEffect(() => {
    if (!filePath) {
      useDocumentMetricsStore.getState().clear(documentInstanceKey);
      return;
    }
    useDocumentMetricsStore.getState().setCharCount(documentInstanceKey, state.charCount);
  }, [documentInstanceKey, filePath, state.charCount]);

  useEffect(() => () => {
    useDocumentMetricsStore.getState().clear(documentInstanceKey);
  }, [documentInstanceKey]);

  useEffect(() => {
    if (!memoId) return;

    const handleVersionRestored = (event: Event) => {
      const detail = (event as CustomEvent<{
        memoId: string;
        path: string;
        content: string;
      }>).detail;

      if (!detail || detail.memoId !== memoId) return;

      clearSaveTimer();
      const body = extractBodyContent(detail.content);
      const textUnits = countTextUnits(body);
      applyLoadedDocumentContent(documentIdentity, detail.path, detail.content, {
        preservePending: false,
      });
      setState((prev) => ({
        ...prev,
        fullContent: detail.content,
        isLoaded: true,
        isLoading: false,
        error: null,
        isScrolled: false,
        charCount: textUnits,
        tokenCount: Math.ceil(textUnits / 4),
      }));
    };

    window.addEventListener('flowix:memo-version-restored', handleVersionRestored);
    return () => {
      window.removeEventListener('flowix:memo-version-restored', handleVersionRestored);
    };
  }, [clearSaveTimer, documentIdentity, memoId, setState]);

  useEffect(() => {
    if (!filePath) {
      setState(initialDocumentContainerState);
      return;
    }

    const loadedDocumentInstanceKey = loadedDocumentInstanceKeyRef.current;
    const instanceKeyChanged = loadedDocumentInstanceKey !== documentInstanceKey;
    loadedDocumentInstanceKeyRef.current = documentInstanceKey;

    // A path is an attribute of this session, never an editor lifecycle key.
    // Actual external content changes arrive through the content watchers.
    if (!instanceKeyChanged) {
      rebaseActiveDocumentPath(documentIdentity, filePath);
      if (documentSessionMode !== 'isolated' && transitionId !== null) {
        useDocumentStore.getState().finishDocumentTransition(transitionId);
      }
      return;
    }

    reloadDocument(filePath, {
      // A second surface for the same identity shares this buffer. Preserve
      // its live draft instead of replacing it with the disk snapshot.
      preservePending: hasDocumentUnsavedChanges(documentIdentity),
      showLoading: true,
    });
  }, [filePath, documentIdentity, documentInstanceKey, documentSessionMode, isExternalDocument, memoId, reloadDocument, clearSaveTimer]);

  useExternalDocumentChangeWatch({
    filePath,
    identity: documentIdentity,
    scopePath: externalScopePath,
    clearSaveTimer,
    reloadDocument,
  });

  useMemoDocumentChangeWatch({
    filePath,
    identity: documentIdentity,
    clearSaveTimer,
    reloadDocument,
  });

  const metaInfo = useMemo(() => {
    return {
      charCount: state.charCount,
      tokenCount: state.tokenCount,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      memoPath: memoId ?? null,
      memoContent: state.fullContent,
      isFavorited: state.isFavorited,
      frontmatterMeta: state.frontmatterMeta,
    };
  }, [state.charCount, state.tokenCount, state.createdAt, state.updatedAt, state.fullContent, state.isFavorited, state.frontmatterMeta, memoId]);

  useEffect(() => {
    if (filePath) {
      onMetainfoData?.(metaInfo);
    }
  }, [filePath, metaInfo, onMetainfoData]);

  if (!filePath) {
    return <WorkspaceEmptyState tone="document" message={t('shell.emptyDocument')} />;
  }

  if (state.error) {
    // 物理文件丢失场景: memo index 还有这条 entry, 但磁盘上 .md 没了。
    // 之前的兜底只有一行 "读取失败" 文字, 用户没有任何方式主动清掉这个
    // 幽灵 entry。 现在加一个 "删除当前笔记" 按钮 ── 直接走 store 的
    // deleteMemo, 后端 ops::delete_memo 在 file 不存在时会落进 ghost 分支
    // (ops.rs:411-414) 只清 memo index, 然后 emit MemoEvent::Deleted。
    // store 收到事件把 memos 数组里这一项 filter 掉, 列表幽灵消失;
    // 同步调 clearDocument() 把当前打开的 ghost 文档也清掉, 避免下次
    // 切回时再次尝试 readDocument 同一个 path。
    //
    // 不走 flowix:request-delete-memo 弹窗 ── 用户在错误态点按钮本身
    // 已经是"我接受清掉这条"的明确意图, 多一层 dialog 反而干扰恢复流。
    const handleDeleteCurrent = async () => {
      if (!memoId) return;
      try {
        const success = await useMemoStore.getState().deleteMemo(memoId);
        if (success) {
          removeBrowserColumnTabsByMemoId(memoId);
          if (documentSessionMode !== 'isolated') await clearWorkspaceDocument();
          toast.success(t('document.ghost.removed'));
        } else {
          toast.error(t('document.ghost.deleteFailed'));
        }
      } catch {
        toast.error(t('document.ghost.deleteFailed'));
      }
    };
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--muted-foreground)]">
        <span className="text-sm">{state.error}</span>
        {!isExternalDocument && memoId && (
          <button
            type="button"
            onClick={handleDeleteCurrent}
            className="inline-flex items-center h-7 px-2.5 text-xs rounded-lg bg-transparent border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-transparent hover:border-[var(--destructive)] hover:text-[var(--destructive)]"
          >
            {t('document.ghost.deleteButton')}
          </button>
        )}
      </div>
    );
  }

  const hasMarkdownTitle = (!isExternalDocument && Boolean(memoId))
    || (isExternalDocument && externalEditorMode === 'markdown');
  const renameTitle: RenameDocumentTitle = isExternalDocument
    ? commitExternalTitle
    : renameDocumentTitle;
  const documentHeader = hasMarkdownTitle ? (
    <MemoDocumentHeader
      titleRef={titleEditorRef}
      displayId={displayId}
      filename={memoFilename}
      renameTitle={renameTitle}
      updatedAt={!isExternalDocument ? state.updatedAtDate : null}
      editable={
        !readOnly
        && (!isExternalDocument || Boolean(externalScopePath))
      }
      autoFocus={initialFocus === 'title'}
      sourceMode={usesCodeEditor}
      showPropertiesToggle
      allowReadOnlyBoundaryNavigation
      onMoveToBody={handleMoveTitleToBody}
      onPasteToBody={handlePasteTitleContentToBody}
      editorMode={editorMode}
      onToggleEditorMode={handleToggleEditorMode}
    />
  ) : null;

  return (
    <div
      ref={containerRef}
      data-document-session-mode={documentSessionMode}
      onFocusCapture={() => useWorkspaceFocusStore.getState().focusHost(hostId)}
      onPointerDownCapture={() => useWorkspaceFocusStore.getState().focusHost(hostId)}
      className="document-container h-full w-full min-w-0 flex flex-col bg-transparent relative overflow-hidden"
    >
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {state.isLoading && (
          <CenteredLoadingSpinner className="h-full w-full" />
        )}
        {!state.isLoading && usesCodeEditor && (
          <LazyCodeEditor
            ref={editorHandleRef}
            key={documentInstanceKey}
            filePath={filePath}
            content={state.fullContent}
            editable={!readOnly}
            onChange={handleChange}
            autoFocus={initialFocus === 'body'}
            onEditorScroll={handleEditorScroll}
            onEditingFinished={flushPendingEditorChanges}
            scrollHeader={documentHeader ?? undefined}
            searchPanelOpen={searchPanelOpen}
            onSearchPanelOpenChange={onSearchPanelOpenChange}
          />
        )}
        {!state.isLoading && state.isLoaded && !usesCodeEditor && (
          <LazyDocumentEditor
            memoId={memoId ?? undefined}
            propertyTargetId={propertyTargetId}
            onViewSourceMode={handleToggleEditorMode}
            transitionId={transitionId}
            ref={editorHandleRef}
            key={documentInstanceKey}
            content={state.fullContent}
            header={documentHeader}
            editable={!readOnly}
            onDirty={handleDirty}
            onChange={(content) => {
              handleChange(content);
            }}
            className=""
            onEditorScroll={handleEditorScroll}
            onEditingFinished={() => {
              flushPendingEditorChanges();
            }}
            onFocusTitle={() => {
              titleEditorRef.current?.focusEnd();
            }}
            onAppendToTitle={(title) => {
              return titleEditorRef.current?.appendBodyLine(title) ?? false;
            }}
            autoFocus={initialFocus === 'body'}
            searchPanelOpen={searchPanelOpen}
            onSearchPanelOpenChange={onSearchPanelOpenChange}
            onBeforeCreate={(editor: Editor) => onEditorReady?.(editor)}
            toolbarCollapsed={toolbarCollapsed}
            onToolbarCollapsedChange={onToolbarCollapsedChange}
          />
        )}
      </div>
    </div>
  );
}

export function UnavailableFileView({
  filePath,
  openContainingFolder = false,
}: {
  filePath: string;
  openContainingFolder?: boolean;
}) {
  const { t } = useI18n();
  const filename = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
  const parentPath = filePath.replace(/[\\/][^\\/]*$/, '') || (filePath.startsWith('/') ? '/' : filePath);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-sm text-[var(--muted-foreground)]">
      <span className="max-w-full truncate text-[var(--foreground)]" title={filename}>{filename}</span>
      <span>{t('document.file.unavailable')}</span>
      <button
        type="button"
        onClick={() => {
          const action = openContainingFolder
            ? openPath(parentPath)
            : product.revealInFileManager(filePath);
          void action.catch(() => {
            toast.error(t('memo.fileTree.openFailed'));
          });
        }}
        className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
      >
        {t(openContainingFolder ? 'document.file.openContainingFolder' : 'document.file.reveal')}
      </button>
    </div>
  );
}
