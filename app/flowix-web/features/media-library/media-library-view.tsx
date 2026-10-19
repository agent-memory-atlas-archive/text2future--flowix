'use client';

import { createSaveBarrier } from '@/lib/save-barrier';
import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';

import { resolveDatasetFilterForLocation } from '@features/collection/dataset-filter-location';
import { collectionSessionKey } from '@/lib/collection-session-key';
import { reuseCollectionValue } from '@features/collection/content-equality';
import { FolderCollectionSwitchConfirmDialog } from '@features/collection/public/folder-api';
import { collectionDisplayName, isLegacyCollectionSource } from '@features/collection/model';
import { collectionDisplayDescriptor } from '@/lib/collection-display-registry';
import { subscribe } from '@platform/tauri/event-bus';
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { externalDocuments, files, notebooks as notebookClient, type CollectionChangedEvent } from '@platform/tauri/client';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { useNoteStore } from '@features/memo/store/note-store';
import { useNotebookMediaMaintenanceStore } from '@features/memo/store/notebook-media-maintenance-store';
import { DocumentListView } from '@features/surface/document-list-view';
import type { DocumentListViewContext } from '@features/surface/document-list-view-model';
import { findFileDisplayPath, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { displayTitleFromFilename } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { canEditMediaLibraryFilter, hasMediaDatasetFilter, mediaCollectionFilterForSave, mediaLibraryDefaultView, mediaLibraryFileCondition, parseMediaLibrary, serializeMediaLibrary, type MediaLibraryDocument, type MediaLibraryFileCondition, type MediaLibraryKind } from './model';
import { renameMediaLibrary } from './rename-media-library';
import { useMediaLibraryActions } from './use-media-library-actions';
import { useMediaLibraryRefresh } from './use-media-library-refresh';
import { MediaLibraryLoadingSkeleton } from '@shared/ui/media-library-loading-skeleton';

export function MediaLibraryView({ onSurfaceLifecycleReady, reportPresentation, filePath, fileIdentity, notebookPath: rawNotebookPath, notebookId = null, expectedCollectionId, workspaceHost = 'main-third' }: { onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void; reportPresentation?: (update: SurfacePresentationUpdate) => void; filePath: string; fileIdentity?: FileDisplayIdentity; notebookPath: string | null; notebookId?: string | null; expectedCollectionId?: string | null; workspaceHost?: 'main-third' | 'browser-column' }) {
  const notebookPath = rawNotebookPath ? canonicalDirectoryPath(rawNotebookPath) : null;
  const sessionKey = collectionSessionKey({ filePath, fileIdentity, notebookPath, notebookId, expectedCollectionId });
  const { t } = useI18n();
  const notebooks = useNoteStore((state) => state.notebooks);
  const notebook = notebooks.find((candidate) => canonicalDirectoryPath(candidate.path) === (notebookPath ?? ''));
  const resolvedNotebookId = notebookId ?? notebook?.id ?? null;
  const mediaMaintenance = useNotebookMediaMaintenanceStore((state) => resolvedNotebookId ? state.statuses[resolvedNotebookId] : undefined);
  const [renamedFilePath, setRenamedFilePath] = useState<string | null>(null);
  const [document, setDocument] = useState<MediaLibraryDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSavingState] = useState(false);
  const [retryingMaintenance, setRetryingMaintenance] = useState(false);
  const savingStateRef = useRef(false);
  const saveBarrier = useMemo(createSaveBarrier, [sessionKey]);
  const setSaving = useCallback((action: SetStateAction<boolean>) => {
    const next = typeof action === 'function' ? action(savingStateRef.current) : action;
    saveBarrier.setSaving(next);
    savingStateRef.current = next;
    setSavingState(next);
  }, [saveBarrier]);
  const retryMediaMaintenance = useCallback(async () => {
    if (!resolvedNotebookId || retryingMaintenance) return;
    setRetryingMaintenance(true);
    try {
      await notebookClient.retryMediaMaintenance(resolvedNotebookId);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : t('mediaLibrary.maintenanceRetryFailed'));
    } finally {
      setRetryingMaintenance(false);
    }
  }, [resolvedNotebookId, retryingMaintenance, t]);
  const reportSaveFailure = useCallback(() => saveBarrier.fail(), [saveBarrier]);
  const [confirmFolderSwitch, setConfirmFolderSwitch] = useState(false);
  const sourceContentRef = useRef<string | null>(null);
  const saveInFlightRef = useRef(false);
  const displayId = fileIdentity?.displayId;
  const currentFilePath = (displayId ? findFileDisplayPath(displayId) : null) ?? renamedFilePath ?? filePath;

  const currentSessionKeyRef = useRef(sessionKey);
  currentSessionKeyRef.current = sessionKey;
  const retryLoad = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);
  useEffect(() => {
    onSurfaceLifecycleReady?.({ status: 'ready', flush: async () => {
      const saved = await saveBarrier.flush();
      return saved && currentSessionKeyRef.current === sessionKey;
    } });
    return () => {
      onSurfaceLifecycleReady?.(null);
    };
  }, [onSurfaceLifecycleReady, saveBarrier, sessionKey]);
  useEffect(() => () => saveBarrier.cancel(), [saveBarrier]);
  const acceptContent = useCallback((content: string) => {
    if (currentSessionKeyRef.current !== sessionKey) return false;
    const next = parseMediaLibrary(content);
    const current = sourceContentRef.current ? parseMediaLibrary(sourceContentRef.current) : null;
    const expectedId = expectedCollectionId ?? (displayId ? collectionDisplayDescriptor(displayId)?.collectionId : null);
    if ((expectedId && next.collection.id !== expectedId) || (current && (current.collection.id !== next.collection.id
      || current.collection.revision > next.collection.revision))) return false;
    sourceContentRef.current = content;
    setDocument((current) => current ? { ...next,
      dataset: { ...next.dataset, records: reuseCollectionValue(current.dataset.records, next.dataset.records) },
      views: reuseCollectionValue(current.views, next.views),
    } : next);
    return true;
  }, [displayId, expectedCollectionId, sessionKey]);
  const { error: refreshError, refreshContent, retryRefresh } = useMediaLibraryRefresh({
    sessionKey, notebookPath, currentFilePath, saving, saveInFlightRef, acceptContent,
  });

  useEffect(() => setRenamedFilePath(null), [filePath]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (saveInFlightRef.current) {
      setLoading(false);
      return;
    }
    if (!notebookPath) {
      setError('无法确定媒体库所属的笔记本');
      setLoading(false);
      return;
    }
    sourceContentRef.current = null;
    void files.read(currentFilePath, notebookPath).then(async (source) => {
      if (cancelled) return;
      if (!source) throw new Error('无法读取媒体库文件');
      let parsed = parseMediaLibrary(source);
      const expectedId = expectedCollectionId ?? (displayId ? collectionDisplayDescriptor(displayId)?.collectionId : null);
      if (expectedId && parsed.collection.id !== expectedId) throw new Error('集合身份已变化，不能打开路径中的替代文件');
      let currentSource = source;
      if (isLegacyCollectionSource(source)) {
        const migration = await externalDocuments.write({ filePath: currentFilePath, content: serializeMediaLibrary(parsed), expectedContent: source, scopePath: notebookPath });
        if (migration.status === 'saved') currentSource = migration.content;
        else if (migration.status === 'conflict') {
          const latest = parseMediaLibrary(migration.diskContent);
          if (latest.collection.id !== parsed.collection.id) throw new Error('集合身份已变化，无法迁移旧格式');
          parsed = latest;
          currentSource = migration.diskContent;
        } else if (migration.status === 'error') throw new Error(migration.message);
      }
      sourceContentRef.current = currentSource;
      setDocument(parsed);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [displayId ?? currentFilePath, expectedCollectionId, loadAttempt, notebookPath]);

  useEffect(() => {
    const refresh = (event: Partial<CollectionChangedEvent> & Pick<CollectionChangedEvent, 'notebookId'>) => {
      const collectionId = document?.collection.id;
      if (event.notebookId !== (notebookId ?? notebook?.id) || !collectionId || !notebookPath) return;
      const root = canonicalDirectoryPath(notebookPath);
      let movedPath: string | null = null;
      if (event.directoryMove) {
        const previous = canonicalPath(`${root}/${event.directoryMove.previousRelativePath}`);
        const next = canonicalPath(`${root}/${event.directoryMove.relativePath}`);
        const current = canonicalPath(currentFilePath);
        if (current === previous || current.startsWith(`${previous}/`)) {
          movedPath = `${next}${current.slice(previous.length)}`;
        } else if (current === next || current.startsWith(`${next}/`)) {
          movedPath = current;
        }
      }
      if (event.collectionId && event.collectionId !== collectionId && !movedPath) return;
      const eventPath = event.relativePath
        ? `${root}/${event.relativePath}`
        : (displayId ? findFileDisplayPath(displayId) : null) ?? currentFilePath;
      const path = movedPath ?? eventPath;
      // Events with an authoritative path can replace a queued readiness refresh.
      refreshContent(path, Boolean(event.relativePath));
    };
    const stopCollection = subscribe<CollectionChangedEvent>('collection-changed', refresh);
    const stopCatalog = subscribe<{ notebookId: string; operationId?: string }>('file-management-changed', (event) => {
      if (!event.operationId) refresh(event);
    });
    return () => { stopCollection(); stopCatalog(); };
  }, [currentFilePath, displayId, document?.collection.id, notebook?.id, notebookId, notebookPath, refreshContent, sessionKey]);

  const persistMutation = useCallback(async (
    mutate: (current: MediaLibraryDocument) => MediaLibraryDocument,
    targetPath = currentFilePath,
    lockAlreadyHeld = false,
    initialDocument?: MediaLibraryDocument,
  ): Promise<boolean> => {
    if (!document || !notebookPath || !sourceContentRef.current
      || (saveInFlightRef.current && !lockAlreadyHeld)) return false;
    if (!lockAlreadyHeld) {
      saveInFlightRef.current = true;
      setSaving(true);
    }
    try {
      let baseline = initialDocument ?? document;
      let expectedContent = sourceContentRef.current;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (baseline.collection.id !== document.collection.id) throw new Error('集合身份已变化，已取消保存');
        const next = mutate(baseline);
        const result = await externalDocuments.write({
          filePath: targetPath,
          content: serializeMediaLibrary(next),
          expectedContent,
          scopePath: notebookPath,
        });
        if (result.status === 'saved') {
          sourceContentRef.current = result.content;
          setDocument(next);
          return true;
        }
        if (result.status === 'conflict') {
          const latest = parseMediaLibrary(result.diskContent);
          if (latest.collection.id !== baseline.collection.id) throw new Error('集合身份已变化，已取消保存');
          expectedContent = result.diskContent;
          sourceContentRef.current = result.diskContent;
          if (attempt === 0) {
            baseline = latest;
            continue;
          }
          setDocument(latest);
          reportSaveFailure();
          toast.error('媒体库配置再次发生变化，已载入最新版本，请重试');
          return false;
        }
        throw new Error(result.status === 'error' ? result.message : '媒体库文件已不存在');
      }
      reportSaveFailure();
      return false;
    } catch (reason) {
      reportSaveFailure();
      toast.error(reason instanceof Error ? reason.message : '保存媒体库配置失败');
      return false;
    } finally {
      if (!lockAlreadyHeld) {
        saveInFlightRef.current = false;
        setSaving(false);
      }
    }
  }, [currentFilePath, document, notebookPath, reportSaveFailure, setSaving]);

  const updateFilterCondition = useCallback(async (fileCondition: MediaLibraryFileCondition) => {
    if (saving || !notebookPath) return false;
    if (document && !canEditMediaLibraryFilter(document)) {
      toast.error('当前媒体库包含编辑器不支持的筛选，未保存以保留原条件');
      return false;
    }
    return persistMutation((current) => ({
      ...current,
      collection: {
        ...current.collection,
        revision: current.collection.revision + 1,
        updated_at: new Date().toISOString(),
      },
      dataset: { ...current.dataset, filter: mediaCollectionFilterForSave(current, fileCondition, currentFilePath, notebookPath) },
      views: { ...current.views, items: current.views.items.map((view) => view.id === current.views.default_id
        ? { ...view, filter: { all: [], any: [] } } : view) },
    }));
  }, [currentFilePath, document, notebookPath, persistMutation, saving]);

  const renameLibrary = useCallback(async (rawTitle: string) => {
    const title = rawTitle.trim();
    const previousPath = canonicalPath(displayId ? findFileDisplayPath(displayId) ?? currentFilePath : currentFilePath);
    const isFolderCollection = document?.collection.placement === 'folder';
    const currentTitle = isFolderCollection
      ? previousPath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '').split(/[\\/]/).pop() ?? ''
      : displayTitleFromFilename(previousPath);
    if (!title || title === currentTitle || saving || !notebookPath || !document || saveInFlightRef.current) return;
    if (/[\\/]/.test(title)) {
      toast.error('文件名不能包含路径分隔符');
      return;
    }
    try {
      saveInFlightRef.current = true;
      setSaving(true);
      const result = await renameMediaLibrary({
        notebookPath, notebookId: notebookId ?? notebook?.id,
        collectionId: document.collection.id, title,
      });
      if (!acceptContent(result.content)) { reportSaveFailure(); return; }
      setRenamedFilePath(result.filePath);
      if (result.errorCode) toast.error(`集合已更新，后续操作待恢复：${result.errorCode}`);
    } catch (reason) {
      reportSaveFailure();
      toast.error(reason instanceof Error ? reason.message : '重命名媒体库失败');
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [acceptContent, currentFilePath, displayId, document, notebook?.id, notebookId, notebookPath, reportSaveFailure, saving, setSaving]);

  const { addMedia, deleteMedia } = useMediaLibraryActions({
    document, setDocument, notebookPath, notebookId: notebookId ?? notebook?.id ?? null, currentFilePath, saving, setSaving,
    sourceContentRef, saveInFlightRef, persistMutation, reportSaveFailure, t,
  });

  const selectedKind = document ? mediaLibraryFileCondition(document).file_type : undefined;
  const resourceKinds = useMemo<MediaLibraryKind[]>(() => selectedKind ? [selectedKind] : ['image', 'video'], [selectedKind]);
  const activeCollectionId = document?.collection.id;
  const libraryDisplayName = document ? collectionDisplayName(currentFilePath, document.collection.placement) : '媒体库';
  useEffect(() => {
    if (!reportPresentation) return;
    if (loading) {
      reportPresentation({ title: libraryDisplayName, state: {
        status: 'loading', loadingMode: 'blocking', retainContent: true,
      } });
    } else if (error) {
      reportPresentation({ title: libraryDisplayName, state: {
        status: 'error',
        message: { key: 'error.unexpected', fallbackText: error },
        actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retryLoad }],
      } });
    } else if (document) {
      reportPresentation({ title: libraryDisplayName, state: { status: 'ready' } });
    } else {
      reportPresentation({ title: libraryDisplayName, state: {
        status: 'unavailable', reason: 'missing', message: { key: 'mediaLibrary.unavailable' },
        actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retryLoad }],
      } });
    }
  }, [document, error, libraryDisplayName, loading, reportPresentation, retryLoad]);
  const mediaScope = useMemo(() => {
    if (!document || !notebookPath) return undefined;
    const source = document.dataset.source;
    if (!source || source.scope === 'notebook') return undefined;
    if (source.scope === 'folder') return { relativePath: source.path ?? '', depth: source.depth };
    const root = canonicalDirectoryPath(notebookPath).replace(/\/$/, '');
    const folder = canonicalDirectoryPath(currentFilePath.replace(/[\\/][^\\/]*$/, '')).replace(/\/$/, '');
    if (folder === root) return { relativePath: '', depth: source.depth };
    if (!folder.startsWith(`${root}/`)) return undefined;
    return { relativePath: folder.slice(root.length + 1).replace(/\\/g, '/'), depth: source.depth };
  }, [currentFilePath, document?.dataset.source.scope, document?.dataset.source.path, document?.dataset.source.depth, notebookPath]);
  const mediaLibraryRecords = useMemo(() => {
    const records = document?.dataset.records.include ?? [];
    if (!mediaScope) return records;
    const base = mediaScope.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return records.filter((record) => {
      const path = record.relative_path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!base) return mediaScope.depth === 'descendants' || !path.includes('/');
      if (!path.startsWith(`${base}/`)) return false;
      return mediaScope.depth === 'descendants' || !path.slice(base.length + 1).includes('/');
    });
  }, [document?.dataset.records.include, mediaScope]);
  const mediaLibraryExcludedPaths = useMemo(() => (document?.dataset.records.exclude ?? [])
    .map((record) => record.relative_path)
    .filter((path): path is string => typeof path === 'string'), [document?.dataset.records.exclude]);
  const listContext: DocumentListViewContext | null = useMemo(() => {
    const resolvedNotebookId = notebookId ?? notebook?.id;
    if (!resolvedNotebookId || !notebookPath || !activeCollectionId) return null;
    const libraryIdentity = `media-library:${resolvedNotebookId}:${activeCollectionId}`;
    const browseCondition = mediaLibraryFileCondition(document);
    return {
      displayId: displayId ?? libraryIdentity,
      folderPath: notebookPath,
      notebookPath,
      notebookId: resolvedNotebookId,
      filters: { resourceKinds },
      ...(mediaScope ? { mediaScope } : {}),
      ...((mediaScope || hasMediaDatasetFilter(document?.dataset.filter)
        || browseCondition.path_scope === 'all' || browseCondition.path_contains
        || browseCondition.file_name_contains || browseCondition.file_type)
        ? { mediaDatasetActive: true } : {}),
    };
  }, [activeCollectionId, displayId, document?.dataset.filter, mediaScope, notebook?.id, notebookId, notebookPath, resourceKinds]);

  if (loading) return reportPresentation ? <MediaLibraryLoadingSkeleton /> : <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">正在打开媒体库…</div>;
  if (error) return reportPresentation ? null : <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--destructive)]">{error}</div>;
  if (!document && reportPresentation) return null;
  if (!document || !listContext) return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">媒体库不可用</div>;

  return <div className="relative h-full min-h-0">
    {saving && <span className="pointer-events-none absolute right-5 top-4 z-10 text-[11px] text-[var(--muted-foreground)]">保存中…</span>}
    {refreshError && <div role="alert" className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 px-3 py-2 text-xs text-[var(--foreground)]">
      <span className="min-w-0 truncate">{t('mediaLibrary.refreshFailed')}: {refreshError}</span>
      <button type="button" onClick={retryRefresh} className="shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--hover-bg)]">
        {t('error.retry')}
      </button>
    </div>}
    {mediaMaintenance?.state === 'failed' && <div role="alert" className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 px-3 py-2 text-xs text-[var(--foreground)]">
      <span className="min-w-0 truncate">{mediaMaintenance.message || t('mediaLibrary.maintenanceFailed')}</span>
      <button type="button" disabled={retryingMaintenance} onClick={() => void retryMediaMaintenance()} className="shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--hover-bg)] disabled:opacity-50">
        {retryingMaintenance ? t('mediaLibrary.maintenanceRunning') : t('error.retry')}
      </button>
    </div>}
    {(mediaMaintenance?.state === 'queued' || mediaMaintenance?.state === 'running') && <div role="status" className="mx-4 mt-3 rounded-lg bg-[var(--muted)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
      {mediaMaintenance.state === 'queued' ? t('mediaLibrary.maintenanceQueued') : t('mediaLibrary.maintenanceRunning')}
    </div>}
    <DocumentListView
      key={listContext.displayId}
      listContext={listContext}
      workspaceHost={workspaceHost}
      mediaLibrary
      libraryName={libraryDisplayName}
      libraryFilePath={currentFilePath}
      mediaLibraryFolderPath={document.collection.placement === 'folder'
        ? mediaScope?.relativePath || notebook?.name || ''
        : undefined}
      mediaLibraryFilter={mediaLibraryFileCondition(document)}
      mediaLibraryRecords={mediaLibraryRecords}
      mediaLibraryExcludedPaths={mediaLibraryExcludedPaths}
      mediaLibraryDatasetFilter={resolveDatasetFilterForLocation(document.dataset.filter, document.collection.placement, currentFilePath, notebookPath)}
      mediaLibraryViewFilter={mediaLibraryDefaultView(document).filter}
      onAddMedia={addMedia}
      onDeleteMedia={deleteMedia}
      libraryActionsDisabled={saving}
      refreshPaused={saving}
      onMediaLibraryFilterChange={updateFilterCondition}
      onRenameLibrary={renameLibrary}
      onSwitchToTable={document.collection.placement === 'folder' ? () => setConfirmFolderSwitch(true) : undefined}
    />
    <FolderCollectionSwitchConfirmDialog open={confirmFolderSwitch} onOpenChange={setConfirmFolderSwitch} confirmDisabled={saving} onConfirm={() => {
      setConfirmFolderSwitch(false);
      const resolvedNotebookId = notebookId ?? notebook?.id;
      if (!notebookPath || !resolvedNotebookId) return;
      window.dispatchEvent(new CustomEvent('flowix:request-switch-folder-collection-type', {
        detail: { filePath: currentFilePath, notebookPath, notebookId: resolvedNotebookId, type: 'table' },
      }));
    }} />
  </div>;
}
