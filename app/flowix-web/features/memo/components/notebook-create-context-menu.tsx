import { DownloadSimpleIcon, FileIcon, FolderSimplePlusIcon, PlusIcon } from '@phosphor-icons/react';
import { GalleryHorizontalEnd, Table2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSubmenu } from '@shared/ui/context-menu';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';
import { MEMO_CREATE_VIEW_OPTIONS } from './memo-create-view-options';
import { WorkDocumentsIcon } from './work-documents-icon';

const MENU_ITEM_CLASS =
  'group h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';
const VIEW_MENU_ITEM_CLASS =
  'memo-navigation-submenu-item mention-note-item !grid !grid-cols-[minmax(0,1fr)_auto] !gap-3 !h-7 !min-h-7 !rounded-lg !py-0 !pl-[6px] !pr-2 hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none';

export function NotebookCreateContextMenuItems({
  onCreateNote,
  onCreateFolder,
  onCreateTable,
  onCreateMediaLibrary,
  onCreateWorkDocuments,
  onImportFiles,
  onImportFolder,
}: {
  onCreateNote: () => void;
  onCreateFolder: () => void;
  onCreateTable: (viewType?: TableViewType) => void;
  onCreateMediaLibrary: () => void;
  onCreateWorkDocuments?: () => void;
  onImportFiles?: () => void;
  onImportFolder?: () => void;
}) {
  const { t } = useI18n();

  return (
    <>
      <ContextMenuItem onClick={onCreateNote} className={MENU_ITEM_CLASS}>
        <FileIcon className="mr-2 h-4 w-4" aria-hidden="true" />
        {t('memo.fileTree.newNote')}
      </ContextMenuItem>
      <ContextMenuItem onClick={onCreateFolder} className={MENU_ITEM_CLASS}>
        <FolderSimplePlusIcon className="mr-2 h-4 w-4" aria-hidden="true" />
        {t('memo.fileTree.newFolder')}
      </ContextMenuItem>
      <ContextMenuSubmenu label={t('memo.create.newView')} icon={<PlusIcon className="h-4 w-4" aria-hidden="true" />}>
        {MEMO_CREATE_VIEW_OPTIONS.map(({ type, labelKey }) => (
          <ContextMenuItem key={type} onClick={() => onCreateTable(type)} className={VIEW_MENU_ITEM_CLASS}>
            <span className="flex min-w-0 items-center gap-2">
              {type === 'table' ? <Table2 className="h-4 w-4 shrink-0" aria-hidden="true" /> : <span className="h-4 w-4 shrink-0" aria-hidden="true" />}
              <span className="mention-note-title">{t(labelKey)}</span>
            </span>
            <span className="mention-note-notebook justify-self-end text-right opacity-50">{t('memo.create.note')}</span>
          </ContextMenuItem>
        ))}
        <ContextMenuItem onClick={onCreateMediaLibrary} className={VIEW_MENU_ITEM_CLASS}>
          <span className="flex min-w-0 items-center gap-2">
            <GalleryHorizontalEnd className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="mention-note-title">{t('memo.create.mediaLibraryMenuLabel')}</span>
          </span>
          <span className="mention-note-notebook justify-self-end text-right opacity-50">{t('memo.create.mediaLibraryShort')}</span>
        </ContextMenuItem>
        {onCreateWorkDocuments && <ContextMenuItem onClick={onCreateWorkDocuments} className={VIEW_MENU_ITEM_CLASS}>
          <span className="flex min-w-0 items-center gap-2">
            <WorkDocumentsIcon className="h-5 w-5 shrink-0 opacity-100" />
            <span className="mention-note-title">{t('memo.create.workDocumentsMenuLabel')}</span>
          </span>
          <span className="mention-note-notebook justify-self-end text-right opacity-50">{t('memo.create.workDocumentsTypes')}</span>
        </ContextMenuItem>}
      </ContextMenuSubmenu>
      {(onImportFiles || onImportFolder) && <ContextMenuSubmenu label={t('memo.fileTree.import')} icon={<DownloadSimpleIcon className="h-4 w-4" aria-hidden="true" />}>
        {onImportFiles && <ContextMenuItem onClick={onImportFiles} className={MENU_ITEM_CLASS}>{t('memo.fileTree.importFiles')}</ContextMenuItem>}
        {onImportFolder && <ContextMenuItem onClick={onImportFolder} className={MENU_ITEM_CLASS}>{t('memo.fileTree.importFolder')}</ContextMenuItem>}
      </ContextMenuSubmenu>}
      <ContextMenuSeparator />
    </>
  );
}
