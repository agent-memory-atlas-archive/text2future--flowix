import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { toast } from '@/lib/toast';
import { displayTitleFromFilename } from '@/lib/utils';
import { collectionDisplayName } from '@features/collection/model';
import { mutateCollectionFile } from '@features/collection/mutations';
import { useTitleEditCaret } from '@shared/hooks/use-title-edit-caret';
import type { useTableSession } from './use-table-session';

const TABLE_TITLE_VISIBILITY_STORAGE_KEY = 'flowix:multidimensional-table:title-visible';
const TABLE_TITLE_VISIBILITY_EVENT = 'flowix:multidimensional-table:title-visibility-changed';
const logger = createLogger('table-title');

interface Options {
  session: Pick<ReturnType<typeof useTableSession>, 'document' | 'saving' | 'setSaving' | 'reportSaveFailure' | 'setNotes' | 'resolvedNotebookId' | 'acceptContent' | 'loadSequenceRef' | 'isCurrentSession'>;
  filePath: string;
  setFilePath: (path: string) => void;
  notebookPath: string | null;
  editable: boolean;
  onFilePathChange?: (path: string) => void;
}

export function useTableTitle({ session, filePath: currentFilePath, setFilePath: setCurrentFilePath, notebookPath, editable, onFilePathChange }: Options) {
  const { t } = useI18n();
  const { document, saving, setSaving, reportSaveFailure, setNotes, resolvedNotebookId, acceptContent, loadSequenceRef, isCurrentSession } = session;
  const [showTableTitle, setShowTableTitle] = useState(true);
  useEffect(() => {
    const readVisibility = () => {
      try {
        setShowTableTitle(window.localStorage.getItem(TABLE_TITLE_VISIBILITY_STORAGE_KEY) !== 'false');
      } catch {
        setShowTableTitle(true);
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === TABLE_TITLE_VISIBILITY_STORAGE_KEY || event.key === null) readVisibility();
    };
    readVisibility();
    window.addEventListener('storage', handleStorage);
    window.addEventListener(TABLE_TITLE_VISIBILITY_EVENT, readVisibility);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(TABLE_TITLE_VISIBILITY_EVENT, readVisibility);
    };
  }, []);
  const toggleTableTitleVisibility = useCallback(() => {
    const next = !showTableTitle;
    setShowTableTitle(next);
    try {
      window.localStorage.setItem(TABLE_TITLE_VISIBILITY_STORAGE_KEY, String(next));
      window.dispatchEvent(new Event(TABLE_TITLE_VISIBILITY_EVENT));
    } catch {
      // Keep the visibility toggle usable when local storage is unavailable.
    }
  }, [showTableTitle]);
  const [editingTableName, setEditingTableName] = useState(false);
  const [tableNameDraft, setTableNameDraft] = useState('');
  const [renamingTable, setRenamingTable] = useState(false);
  const { inputRef: tableNameInputRef, captureCaret: captureTableTitleCaret } = useTitleEditCaret(editingTableName);
  const commitTableTitle = useCallback(async (rawTitle: string) => {
    setEditingTableName(false);
    const title = rawTitle.trim();
    const currentTitle = document ? collectionDisplayName(currentFilePath, document.collection.placement) : displayTitleFromFilename(currentFilePath);
    if (!editable || saving || renamingTable || !notebookPath || !title || title === currentTitle) return;
    if (/[\\/]/.test(title)) {
      toast.error('文件名不能包含路径分隔符');
      return;
    }
    const sequence = loadSequenceRef.current;
    setSaving(true);
    setRenamingTable(true);
    try {
      if (!document || !resolvedNotebookId) throw new Error('集合尚未加载完成');
      const result = await mutateCollectionFile({
        notebookId: resolvedNotebookId, notebookPath, collectionId: document.collection.id,
        expectedRevision: document.collection.revision, newName: title,
      });
      if (!isCurrentSession(sequence) || !acceptContent(result.content)) return;
      if (result.directoryMove) {
        const oldPrefix = `${result.directoryMove.previousRelativePath}/`;
        const nextPrefix = `${result.directoryMove.relativePath}/`;
        setNotes((current) => current.map((note) => {
          const path = note.relativePath.replace(/\\/g, '/');
          return path.startsWith(oldPrefix) ? { ...note, relativePath: nextPrefix + path.slice(oldPrefix.length) } : note;
        }));
      }
      setCurrentFilePath(result.filePath);
      onFilePathChange?.(result.filePath);
      if (result.errorCode) { logger.warn('collection follow-up failed', { code: result.errorCode }); toast.error(t('errors.friendly.collectionPartial')); };
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableRename'));
    } finally {
      setRenamingTable(false);
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [acceptContent, currentFilePath, document, editable, notebookPath, onFilePathChange, renamingTable, resolvedNotebookId, saving, reportSaveFailure, setNotes, setSaving, isCurrentSession, loadSequenceRef, t]);
  const beginEditTableTitle = () => {
    if (!editable || saving || renamingTable || !notebookPath) return;
    setTableNameDraft(document ? collectionDisplayName(currentFilePath, document.collection.placement) : displayTitleFromFilename(currentFilePath));
    setEditingTableName(true);
  };
  return { showTableTitle, toggleTableTitleVisibility, editingTableName, setEditingTableName,
    tableNameDraft, setTableNameDraft, renamingTable, tableNameInputRef, captureTableTitleCaret,
    commitTableTitle, beginEditTableTitle };
}
