import { useCallback, useEffect, useMemo, useState } from 'react';
import { Inbox, FileText } from 'lucide-react';
import { files, type DocTreeItem } from '@platform/tauri/client';
import { externalFileViewKind, resourceKindFromPath } from '@features/editor/public/code-file';
import { toast } from '@/lib/toast';
import { canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { memoMatchesCustomFilter, useCustomFilterStore } from '@features/memo/store/custom-filter-store';
import { memoRepository } from '@features/memo/services/memo-repository';
import { setDocumentProperties } from '@features/document/public/path-properties';
import { Dialog, DialogContent, DialogTitle } from '@shared/ui/dialog';
import { Button } from '@shared/ui/button';
import type { DocumentListSurface } from './types';
import { DOCUMENT_LIST_CREATE_REQUEST_EVENT, type DocumentListCreateRequestDetail } from './document-list-events';

async function collectDocuments(folderPath: string): Promise<DocTreeItem[]> {
  const children = await files.getDirChildren(folderPath);
  const nested = await Promise.all(children.filter((item) => item.type === 'folder').map((item) => collectDocuments(item.fullPath)));
  return [...children.filter((item) => item.type === 'document'), ...nested.flat()];
}

function formatUpdatedAgo(timestamp: number | null): string {
  if (!timestamp) return '更新时间未知';
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return '更新 刚刚';
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `更新 ${elapsedMinutes}分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `更新 ${elapsedHours}小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `更新 ${elapsedDays}天前`;
  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return `更新 ${elapsedMonths}个月前`;
  return `更新 ${Math.floor(elapsedMonths / 12)}年前`;
}

function DocumentCard({ item, notebookPath, onOpen }: { item: DocTreeItem; notebookPath: string; onOpen: () => Promise<void> }) {
  const kind = externalFileViewKind(item.fullPath);
  const [preview, setPreview] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    const request = kind === 'image'
      ? files.readImage(item.fullPath, notebookPath)
      : Promise.resolve(null);
    void request.then((value) => { if (!cancelled) setPreview(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [item.fullPath, kind, notebookPath]);
  return <button type="button" disabled={opening} aria-busy={opening} onClick={() => {
    setOpening(true);
    void onOpen().finally(() => setOpening(false));
  }} className="group flex h-[210px] min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] text-left transition-[background-color,border-color] hover:border-[color-mix(in_oklch,var(--border)_94%,var(--foreground)_6%)] hover:bg-[color-mix(in_oklch,var(--card)_98%,var(--foreground)_2%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-wait disabled:opacity-70">
    <span className="flex h-[148px] w-full shrink-0 items-center justify-center overflow-hidden border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_97%,var(--foreground)_3%)] transition-colors group-hover:bg-[color-mix(in_oklch,var(--card)_96%,var(--foreground)_4%)]">
      {kind === 'image' && preview
        ? <img src={preview} alt="" loading="lazy" className="h-full w-full object-cover" />
        : <FileText
            className="h-9 w-9 text-[var(--muted-foreground)]"
            style={{ opacity: 0.5 }}
            strokeWidth={1.25}
            aria-hidden="true"
          />}
    </span>
    <span className="flex min-h-0 flex-1 items-start gap-2 px-3 py-2.5">
      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-1 block text-[13px] font-semibold leading-5 text-[var(--foreground)]">{item.name.replace(/\.[^.]+$/, '')}</span>
        <span className="mt-0.5 block truncate text-[11px] leading-4 text-[var(--muted-foreground)]">{formatUpdatedAgo(item.modifiedMs)}</span>
      </span>
    </span>
  </button>;
}

export function DocumentListView({ surface }: { surface: DocumentListSurface }) {
  const loadNotebookFilters = useCustomFilterStore((state) => state.loadNotebookFilters);
  const customFilter = useCustomFilterStore((state) => (
    state.filtersByNotebook[surface.notebookId]?.find((filter) => filter.id === surface.filters.customFilterId) ?? null
  ));
  const [items, setItems] = useState<DocTreeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const handleCreateRequest = (event: Event) => {
      const detail = (event as CustomEvent<DocumentListCreateRequestDetail>).detail;
      if (detail?.displayId === surface.displayId) setCreateOpen(true);
    };
    window.addEventListener(DOCUMENT_LIST_CREATE_REQUEST_EVENT, handleCreateRequest);
    return () => window.removeEventListener(DOCUMENT_LIST_CREATE_REQUEST_EVENT, handleCreateRequest);
  }, [surface.displayId]);
  useEffect(() => {
    void loadNotebookFilters(surface.notebookId);
  }, [loadNotebookFilters, surface.notebookId]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    void Promise.all([
      collectDocuments(surface.folderPath),
      customFilter?.documentType === 'note' && surface.notebookId
        ? memoRepository.listAllByPath(surface.notebookId)
        : Promise.resolve(null),
    ]).then(([documents, notes]) => {
      if (cancelled) return;
      if (!customFilter) {
        setItems(documents);
        return;
      }
      if (customFilter.documentType === 'image' || customFilter.documentType === 'video') {
        setItems(documents.filter((item) => (item.resourceKind ?? resourceKindFromPath(item.fullPath)) === customFilter.documentType));
        return;
      }
      if (!notes) {
        setItems(documents);
        return;
      }
      const matchingPaths = new Set(notes
        .filter((note) => memoMatchesCustomFilter(note, customFilter))
        .map((note) => canonicalPath(joinNotebookMemoPath(surface.notebookPath, note.relativePath) ?? '')));
      setItems(documents.filter((item) => matchingPaths.has(canonicalPath(item.fullPath))));
    }).catch(() => {
      if (!cancelled) setError(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [customFilter, revision, surface.folderPath, surface.notebookId, surface.notebookPath]);
  const visibleItems = useMemo(() => items.filter((item) => {
    const kind = item.resourceKind ?? resourceKindFromPath(item.fullPath);
    return !surface.filters.resourceKinds?.length || surface.filters.resourceKinds.includes(kind);
  }).sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0)), [items, surface.filters.resourceKinds]);
  const createNote = useCallback(async () => {
    const title = newTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      let customFilterForCreation = customFilter;
      if (surface.notebookId && surface.filters.customFilterId && !customFilterForCreation) {
        await loadNotebookFilters(surface.notebookId);
        customFilterForCreation = useCustomFilterStore.getState().filtersByNotebook[surface.notebookId]
          ?.find((filter) => filter.id === surface.filters.customFilterId) ?? null;
      }
      let path: string;
      if (surface.notebookId) {
        const { memoRepository } = await import('@features/memo/services/memo-repository');
        const root = canonicalPath(surface.notebookPath).replace(/\/$/, '');
        const folder = canonicalPath(surface.folderPath).replace(/\/$/, '');
        const relative = folder === root ? '' : folder.slice(root.length + 1);
        const created = await memoRepository.create(undefined, surface.notebookId, relative, title);
        path = created.path;
        if (customFilterForCreation?.documentType === 'note') {
          const saved = await setDocumentProperties(path, {
            [customFilterForCreation.key]: customFilterForCreation.value,
          });
          if (!saved) throw new Error('Failed to apply the active custom view to the new note');
        }
      } else {
        const created = await files.createDocument(surface.folderPath, title.endsWith('.md') ? title : `${title}.md`);
        path = created.fullPath;
      }
      setCreateOpen(false);
      setNewTitle('');
      setRevision((value) => value + 1);
      const { openExternalTarget } = await import('@features/workspace/use-cases/workspace-navigation');
      await openExternalTarget(path, { destination: 'main-third', scopePath: surface.notebookPath });
    } catch {
      toast.error('新建笔记失败');
    } finally {
      setCreating(false);
    }
  }, [creating, customFilter, loadNotebookFilters, newTitle, surface.filters.customFilterId, surface.folderPath, surface.notebookId, surface.notebookPath]);
  const openItem = useCallback(async (item: DocTreeItem) => {
    try {
      const { openExternalTarget, openMediaTarget } = await import('@features/workspace/use-cases/workspace-navigation');
      const kind = item.resourceKind ?? resourceKindFromPath(item.fullPath);
      if (kind === 'image' || kind === 'video') {
        await openMediaTarget({ filePath: item.fullPath, notebookId: surface.notebookId, notebookPath: surface.notebookPath, resourceKind: kind });
      } else {
        await openExternalTarget(item.fullPath, { destination: 'main-third', scopePath: surface.notebookPath });
      }
    } catch {
      toast.error('打开文件失败');
    }
  }, [surface.notebookId, surface.notebookPath]);
  return <section className="flex h-full min-h-0 flex-col bg-transparent text-[var(--foreground)]">
    <div className="min-h-0 flex-1 overflow-auto px-5 pb-4 pt-2">
      {error ? <p className="text-sm text-[var(--muted-foreground)]">无法读取文件夹。请检查文件夹后重试。</p>
        : !loading && visibleItems.length === 0
        ? <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">
              <div className="flex flex-col items-center text-center">
                <Inbox className="mb-3 h-10 w-10 opacity-50" strokeWidth={1.25} aria-hidden="true" />
                <span>列表内容为空</span>
              </div>
            </div>
          : <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] items-stretch gap-3.5">{visibleItems.map((item) => <DocumentCard key={item.fullPath} item={item} notebookPath={surface.notebookPath} onOpen={() => openItem(item)} />)}</div>}
    </div>
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-w-sm"><DialogTitle>新建笔记</DialogTitle><form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void createNote(); }}><input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="笔记标题" className="h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]" /><div className="flex justify-end gap-2"><Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => setCreateOpen(false)}>取消</Button><Button type="submit" size="sm" className="rounded-lg" disabled={!newTitle.trim() || creating}>创建</Button></div></form></DialogContent></Dialog>
  </section>;
}
