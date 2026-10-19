import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { files, externalDocuments } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { Plus } from 'lucide-react';
import { createMediaLibraryFile, parseMediaLibrary } from './model';
import { MediaLibraryIcon } from '@features/memo/components/file-type-icon';
import {
  closeCollectionReferencePicker,
  collectionCandidateFolderLabel,
  filterCollectionCandidates,
  isCollectionReferencePickerCurrent,
  openCollectionReferencePicker,
  useCollectionPickerListNavigation,
  type CollectionReferenceCandidate,
  type CollectionReferenceInsertRange,
  type CollectionReferencePickerAnchor,
} from '@features/collection/reference-picker';

function MediaLibraryReferencePicker({ editor, replaceRange, generation, ownerNotebookId }: {
  editor: Editor;
  replaceRange: CollectionReferenceInsertRange;
  generation: number;
  ownerNotebookId: string | null;
}) {
  const ownerNotebook = useNoteStore((state) => state.notebooks.find((notebook) => notebook.id === ownerNotebookId && !notebook.missing));
  const notebooks = useMemo(() => ownerNotebook ? [ownerNotebook] : [], [ownerNotebook]);
  const [candidates, setCandidates] = useState<CollectionReferenceCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLTextAreaElement | null>(null);
  const current = () => isCollectionReferencePickerCurrent(generation);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void Promise.all(notebooks.map(async (notebook) => {
      try {
        return { notebook, libraries: await files.listMediaLibraries(notebook.id), error: null as string | null };
      } catch (error) {
        return { notebook, libraries: [], error: error instanceof Error ? error.message : String(error) };
      }
    })).then((results) => {
      if (!active) return;
      const available = results.flatMap(({ notebook, libraries }) => libraries.map((library) => ({
        notebookId: notebook.id,
        notebookName: notebook.name,
        notebookPath: notebook.path,
        relativePath: library.relativePath,
        collectionId: library.collectionId,
        name: library.name,
      })));
      available.sort((left, right) => `${left.notebookName}/${left.relativePath}`.localeCompare(`${right.notebookName}/${right.relativePath}`));
      setCandidates(available);
      const failure = results.find((result) => result.error);
      if (available.length === 0 && failure?.error) setLoadError(`无法读取媒体库列表（${failure.notebook.name}：${failure.error}）`);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [notebooks]);

  const filtered = useMemo(() => filterCollectionCandidates(candidates, query), [candidates, query]);
  const navigation = useCollectionPickerListNavigation(filtered.length, query);
  useLayoutEffect(() => {
    const textarea = searchRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, window.innerHeight * 0.5)}px`;
  }, [query]);

  const select = async (candidate: CollectionReferenceCandidate) => {
    if (openingPath || !current()) return;
    if (candidate.notebookId !== editor.storage.attachmentLink?.getNotebookId?.()) {
      toast.warning('只能插入当前笔记本中的媒体库');
      return;
    }
    setOpeningPath(candidate.relativePath);
    try {
      const filePath = joinNotebookMemoPath(candidate.notebookPath, candidate.relativePath);
      if (!filePath) throw new Error('媒体库路径无效');
      const source = await externalDocuments.read(filePath, candidate.notebookPath);
      if (!current()) return;
      if (candidate.notebookId !== editor.storage.attachmentLink?.getNotebookId?.()) {
        setOpeningPath(null);
        return;
      }
      const document = parseMediaLibrary(source);
      if (document.collection.id !== candidate.collectionId) throw new Error('媒体库文件已更新，请重新选择');
      if (editor.isDestroyed || !editor.isEditable) {
        closeCollectionReferencePicker(generation);
        if (!editor.isDestroyed) toast.error('当前笔记为只读，无法插入媒体库引用');
        return;
      }
      const inserted = editor.chain().focus().insertContentAt(replaceRange, {
        type: 'mediaLibraryReference',
        attrs: { notebookId: candidate.notebookId, relativePath: candidate.relativePath, collectionId: candidate.collectionId },
      }).run();
      if (!inserted) throw new Error('无法在当前位置插入媒体库引用');
      closeCollectionReferencePicker(generation);
    } catch (error) {
      if (!current()) return;
      toast.error(error instanceof Error ? error.message : '读取媒体库失败');
      setOpeningPath(null);
    }
  };

  const create = async () => {
    const name = query.trim();
    if (!name || creating || !current()) return;
    if (!ownerNotebook || ownerNotebook.id !== editor.storage.attachmentLink?.getNotebookId?.()) {
      toast.error('无法确定当前笔记本');
      return;
    }
    if (editor.isDestroyed || !editor.isEditable) {
      closeCollectionReferencePicker(generation);
      if (!editor.isDestroyed) toast.error('当前笔记为只读，无法插入媒体库引用');
      return;
    }
    setCreating(true);
    try {
      const preferences = await files.getNotebookViewPreferences(ownerNotebook.path);
      const { filePath, document } = await createMediaLibraryFile(ownerNotebook.path, preferences.defaultCreateFolder, name);
      if (!current()) return;
      if (editor.storage.attachmentLink?.getNotebookId?.() !== ownerNotebook.id) {
        toast.warning('当前笔记本已切换，请在当前笔记本中重新插入媒体库');
        setCreating(false);
        return;
      }
      const root = canonicalPath(ownerNotebook.path).replace(/\/+$/, '');
      const canonicalFile = canonicalPath(filePath);
      const relativePath = canonicalFile.startsWith(`${root}/`) ? canonicalFile.slice(root.length + 1) : null;
      if (!relativePath) throw new Error('媒体库路径不在当前笔记本内');
      const inserted = editor.chain().focus().insertContentAt(replaceRange, {
        type: 'mediaLibraryReference',
        attrs: { notebookId: ownerNotebook.id, relativePath, collectionId: document.collection.id },
      }).run();
      if (!inserted) throw new Error('无法在当前位置插入媒体库引用');
      closeCollectionReferencePicker(generation);
    } catch (error) {
      if (!current()) return;
      toast.error(error instanceof Error ? error.message : '创建媒体库失败');
      setCreating(false);
    }
  };

  return <div className={`slash-menu-dropdown table-reference-picker${navigation.keyboardNavigation ? ' is-keyboard-navigation' : ''}`} role="dialog" aria-label="选择媒体库">
    <div className="table-reference-picker__search flex shrink-0 items-start gap-1">
      <textarea ref={searchRef} rows={1} value={query} onChange={(event) => {
        setQuery(event.currentTarget.value);
      }} onKeyDown={(event) => {
        navigation.onInputKeyDown(event);
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.shiftKey) {
          event.preventDefault();
          const candidate = filtered[navigation.activeIndex];
          if (candidate) void select(candidate);
          else void create();
        }
      }} placeholder="输入名称搜索 或 新建" className="min-h-8 max-h-[50vh] min-w-0 flex-1 shrink-0 resize-none overflow-y-auto border-0 bg-transparent px-2 py-2 text-sm leading-5 shadow-none focus-visible:border-0 focus-visible:ring-0" />
      {query.trim() && <button type="button" aria-label="新建媒体库" title="新建媒体库" disabled={creating} onMouseDown={(event) => event.preventDefault()} onClick={() => void create()} className="flex h-8 w-10 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"><Plus className="h-4 w-4" aria-hidden="true" /></button>}
    </div>
    <div className="slash-menu-items-frame">
      <div className="slash-menu-items" role="listbox" aria-label="媒体库列表">
        <div className="slash-menu-header" role="presentation"><span>选择已创建集合插入</span></div>
        {loading ? <div className="slash-menu-empty">正在读取媒体库…</div>
          : loadError ? <div className="slash-menu-empty text-[var(--destructive)]">{loadError}</div>
            : filtered.length === 0 ? <div className="slash-menu-empty">{candidates.length ? '没有匹配的媒体库' : '当前没有媒体库'}</div>
              : filtered.map((candidate, index) => <button key={`${candidate.notebookId}:${candidate.relativePath}`} ref={(element) => { navigation.optionRefs.current[index] = element; }} type="button" role="option" aria-selected={navigation.isSelected(index)} disabled={openingPath !== null || creating} onMouseMove={() => navigation.onOptionMouseMove(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => void select(candidate)} className={`slash-menu-item disabled:opacity-50${navigation.isSelected(index) ? ' is-selected' : ''}`}>
                <MediaLibraryIcon className="h-4 w-4 shrink-0" />
                <span className="slash-menu-item-label min-w-0 flex-1">{candidate.name}</span>
                <span className="slash-menu-item-description max-w-[42%]">{collectionCandidateFolderLabel(candidate)}</span>
                {openingPath === candidate.relativePath && <span className="text-xs text-[var(--muted-foreground)]">读取中</span>}
              </button>)}
      </div>
    </div>
  </div>;
}

export function openMediaLibraryReferencePicker(editor: Editor, replaceRange: CollectionReferenceInsertRange, anchor: CollectionReferencePickerAnchor) {
  const ownerNotebookId = editor.storage.attachmentLink?.getNotebookId?.() ?? null;
  openCollectionReferencePicker(editor, replaceRange, anchor, 'media-library', (generation) => <MediaLibraryReferencePicker
    editor={editor}
    replaceRange={replaceRange}
    generation={generation}
    ownerNotebookId={ownerNotebookId}
  />);
}
