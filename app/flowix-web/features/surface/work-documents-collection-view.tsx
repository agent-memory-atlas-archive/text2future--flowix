'use client';

import { createSaveBarrier } from '@/lib/save-barrier';
import { collectionSessionKey } from '@/lib/collection-session-key';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { useNoteStore } from '@features/memo/store/note-store';
import { subscribe } from '@platform/tauri/event-bus';
import { externalDocuments, files, type CollectionChangedEvent } from '@platform/tauri/client';
import { collectionDisplayName } from '@features/collection/model';
import { renameCollectionAtPath } from '@features/collection/mutations';
import { DocumentListView } from './document-list-view';
import type { DocumentListViewContext } from './document-list-view-model';
import { findFileDisplayPath, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { toast } from '@/lib/toast';
import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';
import { WorkDocumentsLoadingSkeleton } from '@shared/ui/work-documents-loading-skeleton';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canEditWorkDocumentsFilter,
  normalizeWorkDocumentsCondition,
  parseWorkDocumentsCollection,
  serializeWorkDocumentsCollection,
  workDocumentsConditionFromFilter,
  workDocumentsFilterFromCondition,
  type WorkDocumentsDocument,
  type WorkDocumentsFilterCondition,
} from '@features/work-documents/model';

export function WorkDocumentsCollectionView({ onSurfaceLifecycleReady, reportPresentation, filePath, fileIdentity, notebookPath: rawNotebookPath, notebookId = null, expectedCollectionId, workspaceHost = 'main-third' }: {
  onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
  filePath: string;
  fileIdentity?: FileDisplayIdentity;
  notebookPath: string | null;
  notebookId?: string | null;
  expectedCollectionId?: string | null;
  workspaceHost?: 'main-third' | 'browser-column';
}) {
  const notebookPath = rawNotebookPath ? canonicalDirectoryPath(rawNotebookPath) : null;
  const sessionKey = collectionSessionKey({ filePath, fileIdentity, notebookPath, notebookId, expectedCollectionId });
  const notebooks = useNoteStore((state) => state.notebooks);
  const notebook = notebooks.find((candidate) => canonicalDirectoryPath(candidate.path) === (notebookPath ?? ''));
  const resolvedNotebookId = notebookId ?? notebook?.id ?? null;
  const displayId = fileIdentity?.displayId;
  const [renamedFilePath, setRenamedFilePath] = useState<string | null>(null);
  const currentFilePath = (displayId ? findFileDisplayPath(displayId) : null) ?? renamedFilePath ?? filePath;
  const [document, setDocument] = useState<WorkDocumentsDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [saving, setSavingState] = useState(false);
  const savingRef = useRef(false);
  const saveBarrier = useMemo(createSaveBarrier, [sessionKey]);
  const sourceContentRef = useRef<string | null>(null);
  const currentSessionKeyRef = useRef(sessionKey);
  currentSessionKeyRef.current = sessionKey;
  const setSaving = useCallback((next: boolean) => {
    saveBarrier.setSaving(next);
    savingRef.current = next;
    setSavingState(next);
  }, [saveBarrier]);
  const reportSaveFailure = useCallback(() => saveBarrier.fail(), [saveBarrier]);
  const retryLoad = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);

  useEffect(() => {
    onSurfaceLifecycleReady?.({ status: 'ready', flush: async () => {
      const saved = await saveBarrier.flush();
      return saved && currentSessionKeyRef.current === sessionKey;
    } });
    return () => onSurfaceLifecycleReady?.(null);
  }, [onSurfaceLifecycleReady, saveBarrier, sessionKey]);
  useEffect(() => () => saveBarrier.cancel(), [saveBarrier]);
  useEffect(() => setRenamedFilePath(null), [filePath]);

  const acceptContent = useCallback((content: string) => {
    if (currentSessionKeyRef.current !== sessionKey) return false;
    const next = parseWorkDocumentsCollection(content);
    const expectedId = expectedCollectionId;
    if (expectedId && next.collection.id !== expectedId) return false;
    const current = sourceContentRef.current ? parseWorkDocumentsCollection(sourceContentRef.current) : null;
    if (current && (current.collection.id !== next.collection.id || current.collection.revision > next.collection.revision)) return false;
    sourceContentRef.current = content;
    setDocument(next);
    return true;
  }, [expectedCollectionId, sessionKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (!notebookPath) {
      setError('无法确定工作文档集合所属的笔记本');
      setLoading(false);
      return;
    }
    if (savingRef.current) {
      setLoading(false);
      return;
    }
    sourceContentRef.current = null;
    void files.read(currentFilePath, notebookPath).then((source) => {
      if (cancelled) return;
      if (!source) throw new Error('无法读取工作文档集合文件');
      const parsed = parseWorkDocumentsCollection(source);
      if (expectedCollectionId && parsed.collection.id !== expectedCollectionId) throw new Error('集合身份已变化，不能打开路径中的替代文件');
      sourceContentRef.current = source;
      setDocument(parsed);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [currentFilePath, expectedCollectionId, loadAttempt, notebookPath, refreshSequence]);

  useEffect(() => {
    const refresh = (event: Partial<CollectionChangedEvent> & Pick<CollectionChangedEvent, 'notebookId'>) => {
      if (event.notebookId !== resolvedNotebookId || savingRef.current) return;
      const collectionId = document?.collection.id;
      if (event.collectionId && collectionId && event.collectionId !== collectionId) return;
      if (event.relativePath) {
        const root = canonicalDirectoryPath(notebookPath ?? '').replace(/\/$/, '');
        const changedPath = canonicalPath(`${root}/${event.relativePath}`);
        const currentPath = canonicalPath(currentFilePath);
        if (changedPath !== currentPath && event.collectionId) return;
      }
      setRefreshSequence((sequence) => sequence + 1);
    };
    const stopCollection = subscribe<CollectionChangedEvent>('collection-changed', refresh);
    const stopCatalog = subscribe<{ notebookId: string; operationId?: string; resourceKinds?: string[] }>('file-management-changed', (event) => {
      if (event.notebookId === resolvedNotebookId && !event.operationId
        && event.resourceKinds === undefined
        && !savingRef.current) setRefreshSequence((sequence) => sequence + 1);
    });
    return () => { stopCollection(); stopCatalog(); };
  }, [currentFilePath, document?.collection.id, notebookPath, resolvedNotebookId]);

  const persistMutation = useCallback(async (
    mutate: (current: WorkDocumentsDocument) => WorkDocumentsDocument,
  ): Promise<boolean> => {
    if (!document || !notebookPath || !sourceContentRef.current || savingRef.current) return false;
    setSaving(true);
    try {
      let baseline = document;
      let expectedContent = sourceContentRef.current;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const next = mutate(baseline);
        const result = await externalDocuments.write({
          filePath: currentFilePath,
          content: serializeWorkDocumentsCollection(next),
          expectedContent,
          scopePath: notebookPath,
        });
        if (result.status === 'saved') {
          sourceContentRef.current = result.content;
          setDocument(next);
          return true;
        }
        if (result.status === 'conflict') {
          const latest = parseWorkDocumentsCollection(result.diskContent);
          if (latest.collection.id !== document.collection.id) throw new Error('集合身份已变化，已取消保存');
          baseline = latest;
          expectedContent = result.diskContent;
          sourceContentRef.current = result.diskContent;
          if (attempt === 0) continue;
          setDocument(latest);
          throw new Error('工作文档集合配置再次发生变化，已载入最新版本，请重试');
        }
        throw new Error(result.status === 'error' ? result.message : '工作文档集合文件已不存在');
      }
      return false;
    } catch (reason) {
      reportSaveFailure();
      toast.error(reason instanceof Error ? reason.message : '保存工作文档集合失败');
      return false;
    } finally {
      setSaving(false);
    }
  }, [currentFilePath, document, notebookPath, reportSaveFailure, setSaving]);

  const updateFilterCondition = useCallback(async (condition: WorkDocumentsFilterCondition) => {
    if (saving) return false;
    const normalized = normalizeWorkDocumentsCondition(condition);
    const filter = workDocumentsFilterFromCondition(normalized);
    return persistMutation((current) => {
      if (!canEditWorkDocumentsFilter(current.dataset.filter)) {
        throw new Error('当前工作文档集合包含筛选面板无法完整编辑的条件，已取消保存以保留原条件');
      }
      return {
        ...current,
        collection: { ...current.collection, revision: current.collection.revision + 1, updated_at: new Date().toISOString() },
        dataset: { ...current.dataset, filter },
      };
    });
  }, [persistMutation, saving]);

  const renameCollection = useCallback(async (rawTitle: string) => {
    const title = rawTitle.trim();
    if (!title || saving || !notebookPath || !document || !resolvedNotebookId || savingRef.current) return;
    if (/[\\/]/.test(title)) { toast.error('文件名不能包含路径分隔符'); return; }
    setSaving(true);
    try {
      const result = await renameCollectionAtPath(currentFilePath, notebookPath, title, resolvedNotebookId, document.collection.id);
      if (!acceptContent(result.content)) {
        reportSaveFailure();
        return;
      }
      setRenamedFilePath(result.filePath);
    } catch (reason) {
      reportSaveFailure();
      toast.error(reason instanceof Error ? reason.message : '重命名工作文档集合失败');
    } finally {
      setSaving(false);
    }
  }, [acceptContent, currentFilePath, document, notebookPath, reportSaveFailure, resolvedNotebookId, saving, setSaving]);

  const collectionId = document?.collection.id;
  const collectionName = document ? collectionDisplayName(currentFilePath, document.collection.placement) : '工作文档';
  const condition = useMemo(() => workDocumentsConditionFromFilter(document?.dataset.filter), [document?.dataset.filter]);
  const listContext: DocumentListViewContext | null = useMemo(() => {
    if (!resolvedNotebookId || !notebookPath || !collectionId) return null;
    return {
      displayId: displayId ?? `work-documents:${resolvedNotebookId}:${collectionId}`,
      folderPath: notebookPath,
      notebookPath,
      notebookId: resolvedNotebookId,
      filters: {},
      workDocumentsFilter: condition,
    };
  }, [collectionId, condition, displayId, notebookPath, resolvedNotebookId]);

  useEffect(() => {
    if (!reportPresentation) return;
    const hasDataSelection = Object.values(condition).some(Boolean);
    if (loading || (!error && document && listContext && hasDataSelection && listLoading)) reportPresentation({ title: collectionName, state: { status: 'loading', loadingMode: 'blocking', retainContent: true } });
    else if (error) reportPresentation({ title: collectionName, state: { status: 'error', message: { key: 'error.unexpected', fallbackText: error }, actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retryLoad }] } });
    else if (document && listContext) reportPresentation({ title: collectionName, state: { status: 'ready' } });
    else reportPresentation({ title: collectionName, state: { status: 'unavailable', reason: 'missing', message: { key: 'workDocuments.unavailable' }, actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retryLoad }] } });
  }, [collectionName, condition, document, error, listContext, listLoading, loading, reportPresentation, retryLoad]);

  if (loading) return reportPresentation ? <WorkDocumentsLoadingSkeleton /> : <div className="flex h-full min-h-0 items-center justify-center text-sm text-[var(--muted-foreground)]">正在打开工作文档集合…</div>;
  if (error) return reportPresentation ? null : <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--destructive)]">{error}</div>;
  if (!document || !listContext) return reportPresentation ? null : <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">工作文档集合不可用</div>;

  return <div className="relative h-full min-h-0">
    {saving && <span className="pointer-events-none absolute right-5 top-4 z-10 text-[11px] text-[var(--muted-foreground)]">保存中…</span>}
    <DocumentListView
      key={listContext.displayId}
      listContext={listContext}
      workspaceHost={workspaceHost}
      workDocuments
      libraryName={collectionName}
      libraryFilePath={currentFilePath}
      workDocumentsFilter={condition}
      onLoadingChange={setListLoading}
      onWorkDocumentsFilterChange={updateFilterCondition}
      onRenameLibrary={renameCollection}
      libraryActionsDisabled={saving}
      refreshPaused={saving}
    />
  </div>;
}
