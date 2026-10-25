import { DownloadSimpleIcon, FileIcon, FolderSimplePlusIcon, PlusIcon } from '@phosphor-icons/react';
import { GalleryHorizontalEnd, Table2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSubmenu } from '@shared/ui/context-menu';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';
import { MEMO_CREATE_VIEW_OPTIONS } from './memo-create-view-options';
import { WorkDocumentsIcon } from './work-documents-icon';

const MENU_ITEM_CLASS =
  'group h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';

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
          <ContextMenuItem key={type} onClick={() => onCreateTable(type)} className={MENU_ITEM_CLASS}>
            {type === 'table' ? <Table2 className="mr-2 h-4 w-4" aria-hidden="true" /> : <span className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />}
            {t(labelKey)}
            <span className="ml-auto text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)]">{t('memo.create.note')}</span>
          </ContextMenuItem>
        ))}
        <ContextMenuItem onClick={onCreateMediaLibrary} className={MENU_ITEM_CLASS}>
          <GalleryHorizontalEnd className="mr-2 h-4 w-4" aria-hidden="true" />
          <span>{t('memo.create.mediaLibrary')}</span>
          <span className="ml-auto text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)]">
            {t('memo.create.mediaImageShort')}/{t('memo.create.mediaVideoShort')}
          </span>
        </ContextMenuItem>
        {onCreateWorkDocuments && <ContextMenuItem onClick={onCreateWorkDocuments} className={MENU_ITEM_CLASS}>
          <WorkDocumentsIcon className="mr-2 h-4 w-4 opacity-100" />
          <span>{t('memo.create.workDocuments')}</span>
          <span className="ml-auto text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)]">
            {t('memo.create.workDocumentsTypes')}
          </span>
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
