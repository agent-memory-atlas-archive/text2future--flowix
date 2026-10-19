import { resolveDatasetFilterForLocation } from '@features/collection/dataset-filter-location';
import { NotePropertyImageValue, propertyImagePaths as imagePaths, selectPropertyImage } from '@features/document/properties/image-value-input';
import { DateValueInput } from '@features/document/components/note-properties/date-value-input';
import { ColorValueInput } from '@features/document/properties/color-value-input';
import { IconValueInput } from '@features/document/properties/icon-value-input';
import { MultiSelectValueInput } from '@features/document/properties/multi-select-value-input';
import { SelectValueInput } from '@features/document/properties/select-value-input';
import { countPresetTableReferences, deletePresetEverywhere, ensureTableFieldPreset, migrateNotePropertyKey, updatePresetFromTable } from '@features/properties/property-preset-service';
import { usePropertyPresetStore } from '@features/properties/property-preset-store';
import { DeletePresetDialog } from '@features/properties/delete-preset-dialog';
import { PROPERTY_TYPES_KEY, readPropertyTypes } from '@features/document/properties/property-type-metadata';
import { NoteCreatePicker } from './note-create-picker';
import { collectionSessionKey } from '@/lib/collection-session-key';
import { MultidimensionalTableLoadingSkeleton } from '@shared/ui/multidimensional-table-loading-skeleton';
'use client';

import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';

import { mutateCollectionFile } from '@features/collection/mutations';
import { FolderCollectionSwitchConfirmDialog } from '@features/collection/public/folder-api';
import { reviseCollection, type CollectionSource } from '@features/collection/model';
import { resolveCollectionSaveDirectory } from '@features/collection/save-location';
import { collectionFilterUsesField, type DatasetFilter } from '@features/collection/rule-filter';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, Plus, MousePointerClick, Table2 } from 'lucide-react';
import { DotsThreeIcon, EyeIcon, EyeSlashIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import { collections, notes as notesClient, windows, type NoteEntry } from '@platform/tauri/client';
import { NOTE_COLOR_HEX } from '@features/memo/store';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath, notebookRelativeDirectoryPath, parentDirectoryPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { canonicalizePropertyKey, isSystemPropertyKey } from '@features/properties/property-key';
import type { PropertyFieldConfig } from '@/lib/constants';
import { compareAndPatchDocumentProperties, removeDocumentProperty, setDocumentProperties } from '@features/document/public/path-properties';
import { PROPERTY_URL_RE } from '@features/document/properties/property-type';
import { assetUrl, decodeStorageKey } from '@features/editor/extensions/attachment-link/utils';
import { getAllPresets, resolvePropertyPreset, resolvePropertyDisplayName, type PropertyPreset } from '@features/document/properties/presets';
import { usePropertyPresets } from '@features/properties/public-api';
import { createFileBrowserTarget } from '@features/workspace/public/browser-column-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { replaceExternalDocumentPath } from '@features/workspace/use-cases/workspace-navigation';
import { NotebookTreeResourceIcon } from '@features/memo/components/file-type-icon';
import { renameMarkdownTitle } from '@features/document/use-cases/local-document-operations';
import { ensureFileDisplayIdentity, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { displayTitleFromFilename } from '@/lib/utils';
import { collectionDisplayName } from '@features/collection/model';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { useTitleEditCaret } from '@shared/hooks/use-title-edit-caret';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { ADDABLE_TABLE_PROPERTY_KINDS, getPropertyTypeDefinition, type PropertyKind, type PropertyIconKind } from '@/lib/property-types';
import {
  createUuidV7,
  addKanbanView,
  addCalendarDateView,
  addTableView,
  findKanbanStatusField,
  type MultidimensionalTableDocument,
  type TableField,
  type TableView,
  type TableRecord,
  type TableFieldType,
  type TableFieldOption,
  type TableAutoCollectCondition,
  type TableAutoCollectConfig,
  tableAutoCollectConfig,
  withTableAutoCollect,
  canEditTableAutoCollectFilter,
} from './model';
import {
  BUILTIN_TABLE_FIELDS,
  NOTE_CREATED_AT_FIELD_ID,
  NOTE_UPDATED_AT_FIELD_ID,
  NOTE_CALENDAR_DATE_FIELD_ID,
  builtinPresetValue,
  builtinPresetTableField,
  isBuiltinTableFieldId,
  builtinTableFieldValue,
  builtinTableFieldLabel,
} from './builtin-fields';
import { groupRecordsByValue, KANBAN_UNASSIGNED_GROUP_ID } from './view-index';
import { noteMatchesCollectionFilter } from './record-filter';
import { applyTableView } from './view-records';
import { planTableNoteDrop, type TableNoteDropPreview, type TableNoteDropRejection } from './table-note-drop';
import { useTableImages } from './use-table-images';
import { useTableScrollLoading } from './use-table-scroll-loading';
import { TableCalendarView, TableGalleryView, TableKanbanView } from './table-secondary-views';
import { TableNoteDropOverlay } from './table-note-drop-overlay';
import { useTableNoteDropTarget, type TableNoteDropTargetRejection } from './use-table-note-drop-target';
import { TableSortButton, cycleTableSort, tableSortDirection } from './table-sort-button';
import { TableDatasetMenu } from './table-dataset-menu';
import { sortFields } from './field-order';
import { useAutoContentColumnWidths, type AutoColumnContent } from './use-auto-content-column-widths';
import { TableFieldList } from './table-field-list';
import { TableBooleanInput, TableNumberInput, TableRecordRow } from './table-record-row';
import { TableTagValueInput } from './table-tag-value-input';
import { TableTextValueInput } from './table-text-value-input';
import { applyFieldMigrations, migratedOptionValue, planFieldMigrations, type FieldValueMigration } from './table-field-migration';
import { bindTableField, presetFromTableField, retireTablePreset, tableFieldFromPreset } from './table-preset-bindings';
import { NOTE_CALENDAR_DATE_FIELDS, useCalendarController } from './use-calendar-controller';
import type { NoteListItem } from '@/types/note-item';
import { TableFieldEditorForm, TableFieldHeader, TablePresetMenu } from './table-field-header';
import { useTableSession } from './use-table-session';
import { useTableCellWriter, type TableCellSaveStatus } from './use-table-cell-writer';
import { useTableViewSelection } from './use-table-view-selection';
import { removeTableView, resolveTableView } from './view-selection';
import { isMarkdownNoteDragResource, type NotebookNoteDragResource } from '@features/memo/public/drag-resource-api';
import { addPresetField, addTableField, toggleDatasetTableFieldVisibility, changeFieldType as changeFieldTypeInDocument, removeBuiltinField as removeBuiltinTableField, removeField, removePresetField, viewsRequiringField } from './table-commands';

const TABLE_TITLE_VISIBILITY_STORAGE_KEY = 'flowix:multidimensional-table:title-visible';
const TABLE_TITLE_VISIBILITY_EVENT = 'flowix:multidimensional-table:title-visibility-changed';

export interface TableDocumentViewProps {
  onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
  filePath: string;
  /** Stable runtime identity for the table file; survives a rename. */
  fileIdentity?: FileDisplayIdentity;
  notebookPath: string | null;
  notebookId: string | null;
  expectedCollectionId?: string | null;
  initialViewId?: string | null;
  onActiveViewChange?: (viewId: string) => void;
  editable?: boolean;
  canCreateFields?: boolean;
  canCreateRecords?: boolean;
  /** Show the explicit “关联笔记” entry independently from generic record creation controls. */
  showAssociateNoteAction?: boolean;
  canDeleteViews?: boolean;
  /** The table is rendered as a node inside the Markdown editor. */
  embeddedInEditor?: boolean;
  /** Removes the reference node when an embedded table cannot be loaded. */
  onRemoveReference?: () => void;
  /** Renders title bar actions and receives the table dataset action. */
  trailingActions?: (datasetAction: ReactNode) => ReactNode;
  /** Called after the table file has been renamed. */
  onFilePathChange?: (filePath: string) => void;
}

const FIELD_TYPE_CHOICES: TableFieldType[] = ADDABLE_TABLE_PROPERTY_KINDS.filter((kind) => kind !== 'Note');
const SCROLL_PAGE_SIZE = 50;
const EMBEDDED_TABLE_PAGE_SIZE = 10;
const EMBEDDED_GALLERY_PAGE_SIZE = 14;

function noteInCollectionSource(
  notePath: string,
  source: CollectionSource | undefined,
  collectionFilePath: string,
  notebookPath: string | null,
): boolean {
  if (!notePath) return true;
  if (!source || source.scope === 'notebook') return true;
  let base = source.path ?? '';
  if (source.scope === 'containing_folder') {
    if (!notebookPath) return false;
    const root = canonicalDirectoryPath(notebookPath).replace(/\/$/, '');
    const parent = canonicalDirectoryPath(collectionFilePath.replace(/[\\/][^\\/]*$/, '')).replace(/\/$/, '');
    if (parent === root) base = '';
    else if (parent.startsWith(`${root}/`)) base = parent.slice(root.length + 1);
    else return false;
  }
  const normalized = notePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const prefix = base.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!prefix) return source.depth === 'descendants' || !normalized.includes('/');
  if (!normalized.startsWith(`${prefix}/`)) return false;
  const remainder = normalized.slice(prefix.length + 1);
  return source.depth === 'descendants' || !remainder.includes('/');
}
const TABLE_ACTION_COLUMN_MIN_WIDTH = 120;

/** Resolve the table YAML's folder as the second choice for notes created from its rows. */
function resolveTableNoteParentRelativePath(filePath: string, notebookPath: string | null): string | undefined {
  if (!filePath || !notebookPath) return undefined;
  const notebookRoot = canonicalDirectoryPath(notebookPath);
  const tableDirectory = parentDirectoryPath(filePath, notebookRoot);
  const relativePath = notebookRelativeDirectoryPath(notebookRoot, tableDirectory);
  return relativePath ?? undefined;
}

// Default column widths are selected by type and applied through the colgroup.
const TABLE_FIELD_WIDTHS: Record<TableFieldType, number> = {
  primary: 240,
  Text: 120,
  Boolean: 120,
  Number: 120,
  Date: 120,
  URL: 120,
  Select: 120,
  MultiSelect: 120,
  Tag: 120,
  Color: 120,
  Icon: 120,
  Image: 120,
};
function IncompatibleViewEmptyState({ title, description, titleAction }: { title: string; description: string; titleAction?: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
    <div className="flex items-center justify-center gap-3">
      <div className="text-sm font-medium text-[var(--foreground)]">{title}</div>
      {titleAction}
    </div>
    <p className="max-w-md text-sm leading-6 text-[var(--muted-foreground)]">{description}</p>
  </div>;
}

function valueMatchesFieldType(value: unknown, type: TableFieldType, options: TableField['options'] = [], multiple = false): boolean {
  if (value == null || value === '') return true;
  switch (type) {
    case 'primary': case 'Text': case 'Icon': return typeof value === 'string';
    case 'URL': return typeof value === 'string' && PROPERTY_URL_RE.test(value);
    case 'Boolean': return typeof value === 'boolean';
    case 'Number': return typeof value === 'number' && Number.isFinite(value);
    case 'Date': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'Select': return typeof value === 'string' && options.some((option) => option.id === value || option.label === value);
    case 'MultiSelect': return Array.isArray(value) && value.every((item) => typeof item === 'string' && options.some((option) => option.id === item || option.label === item));
    case 'Tag': case 'Color': return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'Image': return multiple
      ? Array.isArray(value) && value.every((item) => typeof item === 'string')
      : typeof value === 'string';
  }
  return false;
}

function fieldTypeLabel(type: PropertyKind | 'primary', t: (key: I18nKey) => string): string {
  return t(getPropertyTypeDefinition(type === 'primary' ? 'Note' : type).labelKey);
}

function fieldTypeIconKind(type: TableFieldType): PropertyIconKind {
  return type === 'primary' ? 'note' : getPropertyTypeDefinition(type).iconKind;
}

function fieldLabel(
  field: TableField,
  propertyFields: ReturnType<typeof usePropertyPresets>['fields'],
  t: (key: I18nKey) => string,
): string {
  if (field.type === 'primary') return '笔记名称';
  // A user preset's key IS its display name; only system presets resolve a
  // separate localized label.
  return resolvePropertyDisplayName(field.property_key ?? '', propertyFields, t);
}

/** Move a property key in an in-memory note (rename keeps values and its type declaration). */
function renameNoteProperty(
  note: NoteEntry,
  previousKey: string,
  nextKey: string,
  field: TableField,
  nextOptions: TableFieldOption[] | undefined,
  propertyFields: readonly PropertyFieldConfig[],
): NoteEntry {
  if (!Object.prototype.hasOwnProperty.call(note.properties, previousKey)) return note;
  const previousValue = note.properties[previousKey];
  const update = nextOptions ? migratedOptionValue(field, nextOptions, previousValue) : null;
  const properties = { ...note.properties };
  delete properties[previousKey];
  if (!update || !update.remove) properties[nextKey] = update ? update.value : previousValue;
  const types = readPropertyTypes(properties[PROPERTY_TYPES_KEY]);
  if (Object.prototype.hasOwnProperty.call(types, previousKey)) {
    types[nextKey] = types[previousKey];
    delete types[previousKey];
  }
  if (update?.remove || resolvePropertyPreset(nextKey, propertyFields)) delete types[nextKey];
  else if (field.type !== 'primary') types[nextKey] = field.type;
  if (Object.keys(types).length) properties[PROPERTY_TYPES_KEY] = types;
  else delete properties[PROPERTY_TYPES_KEY];
  return { ...note, properties };
}

function noteThumbnailUrl(thumbnail: string | null | undefined): string | null {
  if (!thumbnail) return null;
  const storageKey = decodeStorageKey(thumbnail);
  return storageKey ? assetUrl(storageKey) : thumbnail;
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function calendarDateKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(value)?.[1] ?? null;
}

function calendarDateTimeForTimestamp(timestamp: number | undefined): string | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return `${isoDate(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function noteKeyForRecord(record: TableRecord): string {
  return record.note_path;
}

function upsertTableRecord(records: TableRecord[], nextRecord: TableRecord): TableRecord[] {
  if (!records.some((record) => record.id === nextRecord.id)) return [...records, nextRecord];
  return records.map((record) => record.id === nextRecord.id ? nextRecord : record);
}

function notePropertyEditorValue(note: NoteEntry | undefined, field: TableField): unknown {
  if (field.type === 'primary') return note?.relativePath ?? null;
  const propertyKey = field.property_key ?? '';
  const value = note && Object.prototype.hasOwnProperty.call(note.properties, propertyKey)
    ? note.properties[propertyKey]
    : null;
  if (field.type === 'Select') {
    return field.options?.find((option) => option.label === value)?.id
      ?? field.options?.find((option) => option.id === value)?.id
      ?? value
      ?? '';
  }
  if (field.type === 'MultiSelect' && Array.isArray(value)) {
    return value.map((entry) => field.options?.find((option) => option.label === entry)?.id
      ?? field.options?.find((option) => option.id === entry)?.id
      ?? String(entry));
  }
  return value;
}

function calendarCreatePropertyValue(field: TableField, value: unknown): { include: boolean; value: unknown } {
  if (field.type === 'Boolean') return { include: true, value: Boolean(value) };
  if (field.type === 'Number') {
    const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    return { include: Number.isFinite(number) && String(value ?? '').trim() !== '', value: number };
  }
  if (field.type === 'Select') {
    const option = field.options?.find((item) => item.id === value);
    return { include: Boolean(option), value: option?.label ?? null };
  }
  if (field.type === 'MultiSelect') {
    const ids = Array.isArray(value) ? value.map(String) : [];
    const labels = ids.map((id) => field.options?.find((item) => item.id === id)?.label ?? id);
    return { include: labels.length > 0, value: labels };
  }
  if (field.type === 'Tag' || field.type === 'Color' || (field.type === 'Image' && field.multiple)) {
    const values = Array.isArray(value) ? value.map(String) : String(value ?? '').split(',');
    const normalized = values.map((item) => item.trim()).filter(Boolean);
    return { include: normalized.length > 0, value: normalized };
  }
  const normalized = String(value ?? '').trim();
  return { include: Boolean(normalized), value: normalized || null };
}

function isCalendarCreateWritableField(field: TableField): boolean {
  return field.type !== 'primary'
    && Boolean(field.property_key)
    && field.id !== NOTE_CREATED_AT_FIELD_ID
    && field.id !== NOTE_UPDATED_AT_FIELD_ID;
}

const EMPTY_CELL_STATUSES: ReadonlyMap<string, TableCellSaveStatus> = new Map();

export function TableDocumentView(props: TableDocumentViewProps) {
  const sessionKey = collectionSessionKey(props);
  return <TableDocumentViewSession key={sessionKey} {...props} />;
}

function TableDocumentViewSession({ onSurfaceLifecycleReady, reportPresentation, filePath, fileIdentity, notebookPath, notebookId, expectedCollectionId, initialViewId, onActiveViewChange, editable = true, canCreateFields = true, canCreateRecords = true, showAssociateNoteAction = canCreateRecords, canDeleteViews = true, embeddedInEditor = false, onRemoveReference, trailingActions, onFilePathChange }: TableDocumentViewProps) {
  const tablePageSize = embeddedInEditor ? EMBEDDED_TABLE_PAGE_SIZE : SCROLL_PAGE_SIZE;
  const galleryPageSize = embeddedInEditor ? EMBEDDED_GALLERY_PAGE_SIZE : SCROLL_PAGE_SIZE;
  const [currentFilePath, setCurrentFilePath] = useState(filePath);
  useEffect(() => setCurrentFilePath(filePath), [filePath]);
  const { t } = useI18n();
  const { fields: propertyFields } = usePropertyPresets();
  const tablePresets = useMemo(() => {
    const presets = getAllPresets(propertyFields, (key) => t(key));
    return {
      custom: presets.filter((preset) => preset.source === 'custom'),
      system: presets.filter((preset) => preset.source === 'builtin'),
    };
  }, [propertyFields, t]);
  const {
    document, loadError, saving, saveFailed, setSaving, reportSaveFailure, notes, setNotes, resolvedNotebookId,
    notesLoadError, load, acceptContent, save: saveSession, flush: flushSession, loadSequenceRef, loadGeneration, isCurrentSession, pendingNotePropertiesRef,
  } = useTableSession({ filePath: currentFilePath, fileIdentity, notebookPath, notebookId, expectedCollectionId });
  const latestDocumentRef = useRef(document);
  latestDocumentRef.current = document;
  useEffect(() => {
    if (!embeddedInEditor || !expectedCollectionId || !notebookId || !notebookPath || !onFilePathChange) return;
    const pathIsUnusable = Boolean(loadError)
      || Boolean(document && document.collection.id !== expectedCollectionId);
    if (!pathIsUnusable) return;

    let active = true;
    void collections.resolve(notebookId, expectedCollectionId).then((indexedTable) => {
      if (!active) return;
      if (indexedTable.identityConflict || indexedTable.parseState !== 'valid') return;
      const indexedPath = joinNotebookMemoPath(notebookPath, indexedTable.relativePath);
      if (!indexedPath || canonicalPath(indexedPath) === canonicalPath(currentFilePath)) return;
      onFilePathChange(indexedPath);
    }).catch(() => undefined);

    return () => { active = false; };
  }, [document, embeddedInEditor, expectedCollectionId, currentFilePath, loadError, notebookId, notebookPath, onFilePathChange]);
  const save = useCallback(async (...args: Parameters<typeof saveSession>) => {
    if (!editable) return false;
    return saveSession(...args);
  }, [editable, saveSession]);
  const { activeViewId, activeView, activateView, selectView } = useTableViewSelection({
    document, initialViewId, editable, saving, save, onActiveViewChange,
  });
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [editingViewName, setEditingViewName] = useState('');
  const [editingViewWidth, setEditingViewWidth] = useState(48);
  const [managingViewId, setManagingViewId] = useState<string | null>(null);
  const [managingViewName, setManagingViewName] = useState('');
  const [viewPendingDelete, setViewPendingDelete] = useState<TableView | null>(null);
  const [showTableTitle, setShowTableTitle] = useState(true);
  const manageRenameCancelledRef = useRef(false);
  const deletingViewRef = useRef(false);
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
      if (result.errorCode) toast.error(`集合已更新，后续操作待恢复：${result.errorCode}`);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '重命名多维表格失败');
    } finally {
      setRenamingTable(false);
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [acceptContent, currentFilePath, document, editable, notebookPath, onFilePathChange, renamingTable, resolvedNotebookId, saving, reportSaveFailure, setNotes, setSaving, isCurrentSession, loadSequenceRef]);
  const editingViewInputRef = useRef<HTMLInputElement | null>(null);
  const editingViewMeasureRef = useRef<HTMLSpanElement | null>(null);
  const [viewAddOpen, setViewAddOpen] = useState(false);
  const viewTabsScrollerRef = useRef<HTMLDivElement | null>(null);
  const [viewTabsOverflow, setViewTabsOverflow] = useState({ left: false, right: false });
  useLayoutEffect(() => {
    const scroller = viewTabsScrollerRef.current;
    if (!scroller) return;

    const updateOverflow = () => {
      const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
      setViewTabsOverflow((current) => {
        const left = scroller.scrollLeft > 1;
        const right = maxScrollLeft - scroller.scrollLeft > 1;
        return current.left === left && current.right === right ? current : { left, right };
      });
    };

    updateOverflow();
    scroller.addEventListener('scroll', updateOverflow, { passive: true });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateOverflow);
    resizeObserver?.observe(scroller);
    if (scroller.firstElementChild) resizeObserver?.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener('scroll', updateOverflow);
      resizeObserver?.disconnect();
    };
  }, [document?.views.items, editingViewName]);
  const [folderMediaSwitchConfirmOpen, setFolderMediaSwitchConfirmOpen] = useState(false);
  const [fieldPanelHeaderId, setFieldPanelHeaderId] = useState<string | null>(null);
  const [pendingKanbanOption, setPendingKanbanOption] = useState<TableFieldOption | null>(null);
  const [matchingOpen, setMatchingOpen] = useState(false);
  const [datasetFilterOpen, setDatasetFilterOpen] = useState(false);
  const [viewAddStep, setViewAddStep] = useState<'kind' | 'field' | 'manage'>('kind');
  const [pendingViewType, setPendingViewType] = useState<'calendar' | 'kanban' | null>(null);
  const [configuringViewId, setConfiguringViewId] = useState<string | null>(null);
  const [viewFieldPickerAnchorRect, setViewFieldPickerAnchorRect] = useState<DOMRect | null>(null);
  const [calendarCursor, setCalendarCursor] = useState(() => new Date());
  const [calendarCreatePropertyValues, setCalendarCreatePropertyValues] = useState<Record<string, unknown>>({});
  const [calendarEditingRecord, setCalendarEditingRecord] = useState<TableRecord | null>(null);
  const calendarPendingCreatedNoteRef = useRef<{ title: string; entry: NoteEntry } | null>(null);
  const [tablePage, setTablePage] = useState(0);
  const [galleryPage, setGalleryPage] = useState(0);
  const recordsScrollerRef = useRef<HTMLDivElement | null>(null);
  const tableDropAreaRef = useRef<HTMLDivElement | null>(null);
  const tableDropTargetId = useId();
  const [tableDropPreview, setTableDropPreview] = useState<TableNoteDropPreview | null>(null);
  const loadMoreRecordsRef = useRef<HTMLDivElement | null>(null);
  const [pendingTablePageRecordId, setPendingTablePageRecordId] = useState<string | null>(null);
  const { cellStatusesByRecord, updateCell, flush: flushCells } = useTableCellWriter({
    enabled: Boolean(document) && !saving && editable,
    loadGeneration,
    notebookPath,
    loadSequenceRef,
    setNotes,
    pendingNotePropertiesRef,
  });
  useEffect(() => {
    onSurfaceLifecycleReady?.({ status: 'ready', flush: async () => {
      const [sessionSaved, cellsSaved] = await Promise.all([flushSession(), flushCells()]);
      return sessionSaved && cellsSaved;
    } });
    return () => onSurfaceLifecycleReady?.(null);
  }, [flushCells, flushSession, onSurfaceLifecycleReady]);
  const onRemoveReferenceRef = useRef(onRemoveReference);
  onRemoveReferenceRef.current = onRemoveReference;
  const removeReferenceForPresentation = useCallback(() => { onRemoveReferenceRef.current?.(); }, []);
  const hasRemoveReference = Boolean(onRemoveReference);
  useEffect(() => {
    if (!reportPresentation) return;
    const title = document ? collectionDisplayName(currentFilePath, document.collection.placement) : displayTitleFromFilename(currentFilePath);
    if (loadError) {
      const actions = [
        { id: 'retry', label: { key: 'error.retry' }, enabled: true, run: () => load() },
        ...(embeddedInEditor && hasRemoveReference ? [{
          id: 'remove-reference', label: { key: 'multidimensionalTable.removeReference' }, enabled: editable,
          run: removeReferenceForPresentation,
        }] : !embeddedInEditor && document?.collection.placement !== 'folder' ? [{
          id: 'delete-table', label: { key: 'multidimensionalTable.deleteTableFile' }, enabled: editable,
          run: () => { window.dispatchEvent(new CustomEvent('flowix:request-delete-external-file', { detail: { filePath: currentFilePath, notebookPath } })); },
        }] : []),
      ];
      reportPresentation({ title, state: {
        status: 'error',
        message: { key: 'error.unexpected', fallbackText: loadError },
        actions,
      } });
    } else if (!document) {
      reportPresentation({ title, state: {
        status: 'loading', loadingMode: 'blocking', retainContent: true,
      } });
    } else if (expectedCollectionId && document.collection.id !== expectedCollectionId) {
      reportPresentation({ title, state: {
        status: 'unavailable', reason: 'stale-context',
        message: { key: 'multidimensionalTable.referenceIdentityChanged' },
        actions: embeddedInEditor && hasRemoveReference ? [{
          id: 'remove-reference', label: { key: 'multidimensionalTable.removeReference' }, enabled: editable,
          run: removeReferenceForPresentation,
        }] : [],
      } });
    } else {
      reportPresentation({ title, state: { status: 'ready' } });
    }
  }, [currentFilePath, document, editable, embeddedInEditor, expectedCollectionId, hasRemoveReference, load, loadError, notebookPath, removeReferenceForPresentation, reportPresentation]);
  const [newFieldOpen, setNewFieldOpen] = useState(false);
  const [newFieldAnchor, setNewFieldAnchor] = useState<{ rect: DOMRect; align: 'start' | 'end' } | null>(null);
  const [newFieldPropertyKey, setNewFieldPropertyKey] = useState('');
  const [newFieldType, setNewFieldType] = useState<TableFieldType>('Text');
  const [newFieldTypeMenuOpen, setNewFieldTypeMenuOpen] = useState(false);
  const [newFieldPresetMenuOpen, setNewFieldPresetMenuOpen] = useState(false);
  const skipNewFieldSaveOnCloseRef = useRef(false);
  const [datasetPresetMenuOpen, setDatasetPresetMenuOpen] = useState(false);
  const [newFieldOptions, setNewFieldOptions] = useState<TableFieldOption[]>([]);
  const [headerMenuFieldId, setHeaderMenuFieldId] = useState<string | null>(null);
  const [pendingDeleteTarget, setPendingDeleteTarget] = useState<{ field: TableField; preset: PropertyFieldConfig } | null>(null);
  const [pendingDeleteTableCount, setPendingDeleteTableCount] = useState(0);
  const [deletingFieldBusy, setDeletingFieldBusy] = useState(false);
  const [rowActionRecordId, setRowActionRecordId] = useState<string | null>(null);
  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const [notePickerAnchorRect, setNotePickerAnchorRect] = useState<DOMRect | null>(null);
  const [notePickerRecordId, setNotePickerRecordId] = useState<string | null>(null);
  const [notePickerCalendarDate, setNotePickerCalendarDate] = useState<{ fieldId: string; date: string } | null>(null);
  const [newNoteTitle, setNewNoteTitle] = useState('');
  const [autoOpenPrimaryRecordId, setAutoOpenPrimaryRecordId] = useState<string | null>(null);
  const conditionRecordIdsRef = useRef(new Map<string, string>());

  useEffect(() => {
    setTablePage(0);
    setGalleryPage(0);
  }, [loadGeneration]);

  useLayoutEffect(() => {
    if (!editingViewId) return;
    const input = editingViewInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editingViewId]);

  useLayoutEffect(() => {
    if (!editingViewId) return;
    const measuredWidth = editingViewMeasureRef.current?.getBoundingClientRect().width;
    if (measuredWidth) setEditingViewWidth(Math.max(40, Math.ceil(measuredWidth + 2)));
  }, [editingViewId, editingViewName, activeViewId]);

  const noteField = document?.dataset.schema.fields[0];
  const noteByKey = useMemo(() => new Map(notes.map((note) => [note.relativePath.replace(/\\/g, '/'), note])), [notes]);
  const calendarController = useCalendarController({ document, activeView, editable, saving, save });
  const {
    dateFieldId: calendarDateFieldId,
    dateMetadata: calendarDateMetadata,
    weekStart: calendarWeekStart,
    isReadOnly: calendarReadOnly,
    updateWeekStart: updateCalendarWeekStart,
    updateDateField: updateCalendarDateField,
    addDialog: calendarAddDialog,
    openAddDialog: openCalendarAddDialog,
    closeAddDialog: closeCalendarAddPopover,
    setAddDialogOpen: setCalendarAddOpen,
    setTitle: setCalendarAddTitle,
  } = calendarController;
  const calendarField = calendarDateFieldId && !calendarDateMetadata
    ? document?.dataset.schema.fields.find((field) => field.id === calendarDateFieldId) ?? builtinPresetTableField(calendarDateFieldId) ?? undefined
    : undefined;
  const { open: calendarAddOpen, anchorRect: calendarAddAnchorRect, date: calendarAddDate, title: calendarAddTitle } = calendarAddDialog;
  const calendarCreateFields = useMemo(() => {
    if (!document) return [];
    const schemaFields = [...document.dataset.schema.fields];
    for (const fieldId of document.dataset.schema.preset_fields) {
      const presetField = builtinPresetTableField(fieldId);
      if (presetField && !schemaFields.some((field) => field.id === presetField.id)) schemaFields.push(presetField);
    }
    return sortFields(schemaFields.filter(isCalendarCreateWritableField), (field) => field.id, document.dataset.schema.field_order);
  }, [document]);
  const openCalendarNotePopover = useCallback((date: string, anchorRect: DOMRect, fieldId: string) => {
    calendarPendingCreatedNoteRef.current = null;
    setCalendarEditingRecord(null);
    setCalendarCreatePropertyValues(Object.fromEntries(calendarCreateFields.map((field) => [
      field.id,
      field.type === 'Date' && field.id === fieldId ? date
        : field.type === 'Boolean' ? false
          : field.type === 'MultiSelect' || field.type === 'Tag' || field.type === 'Color' || (field.type === 'Image' && field.multiple) ? []
            : '',
    ])));
    openCalendarAddDialog(date, anchorRect, fieldId);
  }, [calendarCreateFields, openCalendarAddDialog]);
  const calendarDays = useMemo(() => {
    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const startOffset = (first.getDay() - calendarWeekStart + 7) % 7;
    const endOffset = (calendarWeekStart + 6 - last.getDay() + 7) % 7;
    const start = new Date(year, month, 1 - startOffset);
    return Array.from({ length: startOffset + last.getDate() + endOffset }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return { date, iso: isoDate(date), inMonth: date.getMonth() === month };
    });
  }, [calendarCursor, calendarWeekStart]);
  const noteForRecord = useCallback((record: TableRecord) => {
    const key = noteKeyForRecord(record);
    return key ? noteByKey.get(key.replace(/\\/g, '/')) : undefined;
  }, [noteByKey]);
  const calendarNoteColorForRecord = useCallback((record: TableRecord) => {
    const color = noteForRecord(record)?.colors[0];
    return color ? NOTE_COLOR_HEX[color] : undefined;
  }, [noteForRecord]);
  const noteIconForRecord = useCallback((record: TableRecord) => noteForRecord(record)?.icon ?? null, [noteForRecord]);
  const noteStatusForRecord = useCallback((record: TableRecord) => {
    const noteKey = noteKeyForRecord(record);
    const note = noteKey ? noteByKey.get(noteKey.replace(/\\/g, '/')) : undefined;
    return !noteKey ? 'draft' as const : note ? 'linked' as const : notesLoadError ? 'unknown' as const : 'missing' as const;
  }, [noteByKey, notesLoadError]);
  const conditionRecords = useMemo(() => {
    if (!document || !noteField) return [];
    const datasetFilter = resolveDatasetFilterForLocation(document.dataset.filter, document.collection.placement, currentFilePath, notebookPath);
    if (datasetFilter == null) return [];

    const linkedPaths = new Set(document.dataset.records.include.map((record) => record.note_path.replace(/\\/g, '/')).filter(Boolean));
    const excludedPaths = new Set([
      ...document.dataset.records.exclude.map((record) => record.note_path),
    ].map((path) => path.replace(/\\/g, '/')));
    return notes.flatMap((note) => {
      const notePath = note.relativePath.replace(/\\/g, '/');
      if (linkedPaths.has(notePath) || excludedPaths.has(notePath)
        || !noteInCollectionSource(notePath, document.dataset.source, currentFilePath, notebookPath)
        || !noteMatchesCollectionFilter(note, document.dataset.schema.fields, noteField.id, datasetFilter)) return [];
      let id = conditionRecordIdsRef.current.get(notePath);
      if (!id) {
        id = `rec_${createUuidV7()}`;
        conditionRecordIdsRef.current.set(notePath, id);
      }
      return [{
        id,
        updated_at: new Date(note.updatedAt).toISOString(),
        note_path: notePath,
      }];
    });
  }, [currentFilePath, document, noteField, notebookPath, notes]);
  const conditionRecordIds = useMemo(() => new Set(conditionRecords.map((record) => record.id)), [conditionRecords]);
  const scopedExplicitRecords = useMemo(() => document
    ? document.dataset.records.include.filter((record) => noteInCollectionSource(record.note_path, document.dataset.source, currentFilePath, notebookPath))
    : [], [currentFilePath, document, notebookPath]);
  const datasetRecords = useMemo(() => [...scopedExplicitRecords, ...conditionRecords], [conditionRecords, scopedExplicitRecords]);
  const visibleRecords = useMemo(() => document
    ? applyTableView(datasetRecords, activeView, document.dataset.schema.fields, document.dataset.schema.primary_field_id, noteForRecord)
    : datasetRecords, [activeView, datasetRecords, document, noteForRecord]);
  useEffect(() => {
    if (activeView?.layout !== 'table') return;
    if (!pendingTablePageRecordId) return;
    const recordIndex = visibleRecords.findIndex((record) => record.id === pendingTablePageRecordId);
    if (recordIndex < 0) return;
    setTablePage((page) => embeddedInEditor
      ? Math.floor(recordIndex / tablePageSize)
      : Math.max(page, Math.floor(recordIndex / tablePageSize)));
    setPendingTablePageRecordId(null);
  }, [activeView?.layout, embeddedInEditor, pendingTablePageRecordId, tablePageSize, visibleRecords]);
  const tableElementRef = useRef<HTMLTableElement | null>(null);
  const columnSizingRecords = useMemo(() => {
    const pageCount = Math.max(1, Math.ceil(visibleRecords.length / tablePageSize));
    const page = Math.min(tablePage, pageCount - 1);
    return visibleRecords.slice(embeddedInEditor ? page * tablePageSize : 0, (page + 1) * tablePageSize);
  }, [embeddedInEditor, tablePage, tablePageSize, visibleRecords]);
  const autoSizedColumns = useMemo<AutoColumnContent[]>(() => {
    if (!document || activeView?.layout !== 'table') return [];
    const visibleIds = activeView.config.visible_fields as string[];
    const fields = [
      ...document.dataset.schema.fields.filter((field) => visibleIds.includes(field.id)),
      ...BUILTIN_TABLE_FIELDS.filter((field) => visibleIds.includes(field.id)).flatMap((field) => {
        const preset = builtinPresetTableField(field.id);
        return [preset ?? { id: field.id, name: field.label, type: field.type, property_key: field.propertyKey ?? field.id }];
      }),
    ];
    return fields.flatMap<AutoColumnContent>((field) => {
      const label = fieldLabel(field, propertyFields, t);
      if (field.type === 'Tag') return [{
        id: field.id,
        label,
        type: 'tags' as const,
        isNoteTags: canonicalizePropertyKey(field.property_key ?? '') === 'tags',
        itemGapWidth: 4.8,
        values: columnSizingRecords.map((record) => {
          const note = noteForRecord(record);
          const value = builtinPresetTableField(field.id) ? builtinPresetValue(field.id, note) : notePropertyEditorValue(note, field);
          return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : [];
        }),
      }];
      if (field.type === 'primary') return [{
        id: field.id,
        label,
        type: 'primary' as const,
        textValues: columnSizingRecords.map((record) => {
          const note = noteForRecord(record);
          const text = note
            ? displayTitleFromFilename(note.relativePath)
            : !record.note_path ? '笔记不存在' : `未找到笔记 ${displayTitleFromFilename(record.note_path)}`;
          return { text, extraWidth: note ? 24 + (conditionRecordIds.has(record.id) ? 15 : 0) : 0 };
        }),
      }];
      if (field.type === 'Select' || field.type === 'MultiSelect') return [{
        id: field.id,
        label,
        type: 'chips' as const,
        extraWidth: 22,
        itemGapWidth: 4,
        values: columnSizingRecords.map((record) => {
          const note = noteForRecord(record);
          const value = builtinPresetTableField(field.id)
            ? builtinPresetValue(field.id, note)
            : notePropertyEditorValue(note, field);
          const optionLabel = (item: unknown) => field.options?.find((option) => option.id === item || option.label === item)?.label ?? String(item);
          if (field.type === 'Select') return value == null || value === '' ? [] : [optionLabel(value)];
          const selected = Array.isArray(value)
            ? value
            : typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
          return selected.map(optionLabel);
        }),
      }];
      return [{
        id: field.id,
        label,
        type: 'text' as const,
        textValues: columnSizingRecords.map((record) => {
          const note = noteForRecord(record);
          const builtinPreset = builtinPresetTableField(field.id);
          const value = builtinPreset
            ? builtinPresetValue(field.id, note)
            : isBuiltinTableFieldId(field.id)
              ? builtinTableFieldValue(field.id, note, notebookPath)
              : notePropertyEditorValue(note, field);
          if (field.type === 'Boolean') return { text: '', extraWidth: 16 };
          if (field.type === 'Icon') return { text: '', extraWidth: value ? 48 : 20 };
          if (field.type === 'Color') {
            const colors = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
            const count = colors.map(String).filter(Boolean).length;
            return { text: '', extraWidth: count ? count * 15 - 6 : 0 };
          }
          if (field.type === 'Image') {
            const hasImage = imagePaths(value).length > 0;
            return { text: hasImage ? '' : t('document.properties.selectImage'), extraWidth: hasImage ? 36 : 0 };
          }
          return {
            text: value == null ? '' : String(value),
            extraWidth: field.type === 'Number'
              ? isBuiltinTableFieldId(field.id) ? 0 : 24
              : field.type === 'Date' && value && !isBuiltinTableFieldId(field.id) ? 20 : 0,
          };
        }),
      }];
    });
  }, [conditionRecordIds, document, activeView, columnSizingRecords, noteForRecord, notebookPath, propertyFields, t]);
  const autoColumnWidths = useAutoContentColumnWidths(tableElementRef, autoSizedColumns);
  const secondaryViewRecords = useMemo(() => activeView?.layout === 'table'
    ? visibleRecords
    : visibleRecords.filter((record) => record.note_path.trim().length > 0), [activeView?.layout, visibleRecords]);
  const linkedNoteKeys = useMemo(() => new Set(visibleRecords
    .map((record) => noteKeyForRecord(record))
    .filter((key): key is string => key !== null)), [visibleRecords]);
  const availableNotes = useMemo(() => notes.filter((note) => !linkedNoteKeys.has(note.relativePath.replace(/\\/g, '/'))), [linkedNoteKeys, notes]);
  const availableNotesRef = useRef(availableNotes);
  availableNotesRef.current = availableNotes;
  const getAvailableNotes = useCallback(() => availableNotesRef.current, []);
  const availableNotesListenersRef = useRef(new Set<() => void>());
  const subscribeAvailableNotes = useCallback((listener: () => void) => {
    availableNotesListenersRef.current.add(listener);
    return () => availableNotesListenersRef.current.delete(listener);
  }, []);
  useEffect(() => {
    for (const listener of availableNotesListenersRef.current) listener();
  }, [availableNotes]);
  useEffect(() => {
    setTablePage(0);
    setGalleryPage(0);
  }, [activeViewId, embeddedInEditor]);

  const pageCount = Math.max(1, Math.ceil(visibleRecords.length / tablePageSize));
  const currentPage = Math.min(tablePage, pageCount - 1);
  const galleryPageCount = Math.max(1, Math.ceil(secondaryViewRecords.length / galleryPageSize));
  const galleryCurrentPage = Math.min(galleryPage, galleryPageCount - 1);
  const visibleTableRecords = useMemo(() => visibleRecords.slice(
    embeddedInEditor ? currentPage * tablePageSize : 0, (currentPage + 1) * tablePageSize,
  ), [visibleRecords, embeddedInEditor, currentPage, tablePageSize]);
  const nextTableRecordId = visibleRecords[(embeddedInEditor ? currentPage * tablePageSize : 0) + visibleTableRecords.length]?.id ?? null;
  const renderedTableRecords = tableDropPreview?.records ?? visibleTableRecords;
  const visibleGalleryRecords = useMemo(() => secondaryViewRecords.slice(
    embeddedInEditor ? galleryCurrentPage * galleryPageSize : 0, (galleryCurrentPage + 1) * galleryPageSize,
  ), [secondaryViewRecords, embeddedInEditor, galleryCurrentPage, galleryPageSize]);
  const scrollPageCount = activeView?.layout === 'gallery' ? galleryPageCount : pageCount;
  const scrollPage = activeView?.layout === 'gallery' ? galleryCurrentPage : currentPage;
  const loadMoreRecords = useCallback(() => {
    const setPage = activeView?.layout === 'gallery' ? setGalleryPage : setTablePage;
    setPage((page) => Math.min(page + 1, scrollPageCount - 1));
  }, [activeView?.layout, scrollPageCount]);
  useTableScrollLoading({
    enabled: !embeddedInEditor && (activeView?.layout === 'table' || activeView?.layout === 'gallery'),
    scrollerRef: recordsScrollerRef, sentinelRef: loadMoreRecordsRef,
    page: scrollPage, pageCount: scrollPageCount, onLoadMore: loadMoreRecords,
  });

  const imageReferences = useMemo(() => {
    if (!document) return [];
    const active = resolveTableView(document, activeViewId ?? initialViewId);
    if (active?.layout !== 'table' && active?.layout !== 'gallery') return [];
    const visibleFields = active.config.visible_fields as string[];
    const imageFields = document.dataset.schema.fields.filter((field) => field.type === 'Image'
      && (active.layout === 'table' || visibleFields.includes(field.id)));
    const viewRecords = active.layout === 'gallery' ? visibleGalleryRecords : visibleTableRecords;
    return viewRecords.flatMap((record) => {
      const noteKey = noteKeyForRecord(record);
      const note = noteKey ? noteByKey.get(noteKey) : undefined;
      return imageFields.flatMap((field) =>
        imagePaths(notePropertyEditorValue(note, field)).map((path) => ({ key: `${record.id}:${field.id}:${path}`, path })));
    });
  }, [activeViewId, initialViewId, document, noteByKey, visibleGalleryRecords, visibleTableRecords]);

  const imageUrls = useTableImages(imageReferences, notebookPath, loadGeneration);

  const saveAutoCollectCondition = useCallback(async (field: TableField, condition: TableAutoCollectCondition): Promise<boolean> => {
    if (!document || saving || field.type !== 'primary') return false;
    if (!canEditTableAutoCollectFilter(document)) {
      toast.error('当前数据集包含编辑器不支持的规则，未保存以保留原筛选');
      return false;
    }
    const previous = tableAutoCollectConfig(document);
    const resolveFieldId = (fieldName: string) => {
      const normalizedName = fieldName.trim();
      return document.dataset.schema.fields.find((item) => item.id === normalizedName
        || item.property_key === normalizedName
        || (item.type === 'primary' && ['笔记名称', '名称'].includes(normalizedName))
        || (item.type !== 'primary' && fieldLabel(item, propertyFields, t) === normalizedName))?.id ?? normalizedName;
    };
    const propertyConditions = (condition.property_conditions ?? []).map((item) => ({
      ...item,
      field_id: resolveFieldId(item.field_id),
      value: item.value.trim(),
    })).filter((item) => item.field_id && item.value);
    const fileCondition = Object.fromEntries(Object.entries({
      file_name_contains: condition.file_condition?.file_name_contains?.trim() ?? '',
      file_type: condition.file_condition?.file_type?.trim().replace(/^\./, '') ?? '',
    }).filter(([, value]) => value)) as TableAutoCollectCondition['file_condition'];
    const hasPropertyCriteria = propertyConditions.length > 0;
    const hasFileCriteria = Object.keys(fileCondition ?? {}).length > 0;
    const rawPath = condition.path === undefined ? previous?.condition.path ?? null : condition.path;
    const path = typeof rawPath === 'string' ? rawPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : null;
    const nextCondition: TableAutoCollectCondition = {
      match: condition.match ?? (condition.property_match === 'intersection' ? 'all' : condition.property_match === 'union' ? 'any' : previous?.condition.match ?? 'all'),
      path,
      ...(hasPropertyCriteria ? { property_conditions: propertyConditions } : {}),
      ...(hasFileCriteria ? { file_condition: fileCondition } : {}),
    };
    const hasActiveCriteria = hasFileCriteria || hasPropertyCriteria || path !== null;
    if (previous && hasActiveCriteria && JSON.stringify(previous.condition) === JSON.stringify(nextCondition)) return true;
    if (!previous && !hasActiveCriteria && document.dataset.filter == null) return true;
    const nextAutoCollect: TableAutoCollectConfig | null = hasActiveCriteria
      ? {
        condition: nextCondition,
      }
      : null;
    const next = { ...withTableAutoCollect(document, nextAutoCollect), collection: reviseCollection(document.collection) };
    return save(next);
  }, [document, propertyFields, save, saving, t]);

  const saveAutoCollectPath = useCallback(async (path: string | null): Promise<boolean> => {
    if (!document || saving) return false;
    if (document.collection.placement === 'folder') return false;
    if (!canEditTableAutoCollectFilter(document)) {
      toast.error('当前数据集包含编辑器不支持的规则，未保存以保留原筛选');
      return false;
    }
    const previous = tableAutoCollectConfig(document);
    const nextPath = path === null ? '' : path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || null;
    if ((previous?.condition.path ?? null) === nextPath) return true;
    const condition: TableAutoCollectCondition = {
      ...(previous?.condition ?? {}),
      match: previous?.condition.match ?? 'all',
      path: nextPath,
    };
    const hasConditions = Boolean(condition.property_conditions?.length
      || condition.file_condition?.file_name_contains?.trim()
      || condition.file_condition?.file_type);
    const next = withTableAutoCollect(document, nextPath !== null || hasConditions ? { condition } : null);
    return save({ ...next, collection: reviseCollection(document.collection) });
  }, [document, save, saving]);

  const retryNoteLookup = useCallback(() => { void load(); }, [load]);
  const displayFieldValue = (record: TableRecord, field: TableField): string => {
    if (field.type === 'primary') {
      const note = noteForRecord(record);
      if (note) return note.title || displayTitleFromFilename(note.relativePath);
      if (!record.note_path) return '笔记不存在';
      return notesLoadError ? `无法确认关联：${record.note_path}` : `未找到笔记 ${displayTitleFromFilename(record.note_path)}`;
    }
    const value = notePropertyEditorValue(noteForRecord(record), field);
    if (field.type === 'Select') return field.options?.find((option) => option.id === value)?.label
      ?? (value == null || value === '' ? '—' : String(value));
    if (field.type === 'MultiSelect') return Array.isArray(value)
      ? value.map((id) => field.options?.find((option) => option.id === id)?.label ?? id).join(', ')
      : '—';
    if (Array.isArray(value)) return value.map(String).join(', ');
    return value == null || value === '' ? '—' : String(value);
  };

  const openNotePicker = useCallback((anchorRect: DOMRect, recordId: string | null, calendarDate: { fieldId: string; date: string } | null = null) => {
    setNotePickerAnchorRect(anchorRect);
    setNotePickerRecordId(recordId);
    setNotePickerCalendarDate(calendarDate);
    setNewNoteTitle('');
    setNotePickerOpen(true);
  }, []);

  const addDraftRecordAndOpenNoteSelector = useCallback(async () => {
    if (!editable || !document || !noteField || saving) return;
    const sequence = loadSequenceRef.current;
    const record: TableRecord = {
      id: `rec_${createUuidV7()}`,
      updated_at: new Date().toISOString(),
      note_path: '',
    };
    const records = [...document.dataset.records.include, record];
    setSaving(true);
    try {
      const saved = await save({
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } },
      }, true, sequence);
      if (!saved || !isCurrentSession(sequence)) return;
      setPendingTablePageRecordId(record.id);
      setAutoOpenPrimaryRecordId(record.id);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '新增空行失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [document, editable, isCurrentSession, loadSequenceRef, noteField, save, saving, setSaving, reportSaveFailure]);

  const applyCalendarDateToNote = useCallback(async (note: NoteEntry, calendarDate: { fieldId: string; date: string } | null): Promise<NoteEntry> => {
    if (!calendarDate) return note;
    if (!editable) throw new Error('当前引用为只读，无法修改笔记属性');
    const field = document?.dataset.schema.fields.find((item) => item.id === calendarDate.fieldId)
      ?? builtinPresetTableField(calendarDate.fieldId) ?? undefined;
    if (field?.type !== 'Date' || !field.property_key) return note;
    const path = notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
    if (!path) throw new Error('无法确定笔记路径，未能设置日期');
    if (!await setDocumentProperties(path, { [field.property_key]: calendarDate.date }, { [field.property_key]: 'Date' })) {
      throw new Error('笔记日期未能保存');
    }
    return { ...note, updatedAt: Date.now(), properties: { ...note.properties, [field.property_key]: calendarDate.date } };
  }, [document, editable, notebookPath]);

  const createNoteInNotebook = useCallback(async (title?: string) => {
    if (!editable) throw new Error('当前引用为只读，无法新建笔记');
    if (!resolvedNotebookId) throw new Error('无法确定当前笔记本');
    if (!document || !notebookPath) throw new Error('无法确定当前多维表路径');
    const directory = resolveCollectionSaveDirectory({
      filePath: currentFilePath, notebookPath, placement: document.collection.placement,
      source: document.dataset.source,
      configuredFolder: tableAutoCollectConfig(document)?.condition.path || undefined,
      defaultDirectory: parentDirectoryPath(currentFilePath, notebookPath),
    });
    const parentRelativePath = notebookRelativeDirectoryPath(notebookPath, directory) ?? undefined;
    return notesClient.create(resolvedNotebookId, undefined, parentRelativePath, title);
  }, [currentFilePath, document, editable, notebookPath, resolvedNotebookId]);

  const createViewForField = useCallback(async (field: TableField | string) => {
    if (!document || !pendingViewType || saving) return;
    const sequence = loadSequenceRef.current;
    const fieldId = typeof field === 'string' ? field : field.id;
    if ((pendingViewType === 'calendar' && typeof field !== 'string' && field.type !== 'Date')
      || (pendingViewType === 'kanban' && (typeof field === 'string' || field.type !== 'Select'))) return;
    try {
      const added = pendingViewType === 'calendar' && fieldId === NOTE_CALENDAR_DATE_FIELD_ID
        ? addCalendarDateView(document)
        : addTableView(document, pendingViewType, fieldId);
      if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
        activateView(added.view.id);
        setViewAddOpen(false);
        setViewAddStep('kind');
        setPendingViewType(null);
        setViewFieldPickerAnchorRect(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建视图失败');
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, pendingViewType, save, saving]);

  const saveConfiguredViewField = useCallback(async (
    viewId: string,
    viewType: 'calendar' | 'kanban',
    fieldId: string,
    dataset = document?.dataset,
  ) => {
    if (!document || !dataset || saving) return false;
    const sequence = loadSequenceRef.current;
    const configKey = viewType === 'calendar' ? 'date_field' : 'group_by';
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      dataset,
      views: { ...document.views, items: document.views.items.map((view) => view.id === viewId
        ? { ...view, config: { ...view.config, [configKey]: fieldId } }
        : view) },
    };
    return await save(next, false, sequence) && isCurrentSession(sequence);
  }, [document, isCurrentSession, loadSequenceRef, save, saving]);

  const selectViewField = useCallback(async (field: TableField | string) => {
    if (!configuringViewId) return createViewForField(field);
    if (!document || !pendingViewType || saving) return;
    let fieldId = typeof field === 'string' ? field : field.id;
    let dataset = document.dataset;
    try {
      if (pendingViewType === 'calendar' && fieldId === NOTE_CALENDAR_DATE_FIELD_ID) {
        const added = addCalendarDateView(document);
        fieldId = added.view.config.date_field as string;
        dataset = added.document.dataset;
      }
      if (await saveConfiguredViewField(configuringViewId, pendingViewType, fieldId, dataset)) {
        setViewAddOpen(false);
        setViewAddStep('kind');
        setPendingViewType(null);
        setConfiguringViewId(null);
        setViewFieldPickerAnchorRect(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新视图字段失败');
    }
  }, [configuringViewId, createViewForField, document, pendingViewType, saveConfiguredViewField, saving]);

  const createKanbanViewForStatus = useCallback(async () => {
    if (!document || pendingViewType !== 'kanban' || saving) return;
    const sequence = loadSequenceRef.current;
    try {
      const added = addKanbanView(document);
      if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
        activateView(added.view.id);
        setViewAddOpen(false);
        setViewAddStep('kind');
        setPendingViewType(null);
        setViewFieldPickerAnchorRect(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建看板失败');
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, pendingViewType, save, saving]);

  const chooseKanbanStatusField = useCallback(async () => {
    if (!configuringViewId) return createKanbanViewForStatus();
    if (!document || saving) return;
    try {
      const added = addKanbanView(document);
      if (await saveConfiguredViewField(configuringViewId, 'kanban', added.field.id, added.document.dataset)) {
        setViewAddOpen(false);
        setViewAddStep('kind');
        setPendingViewType(null);
        setConfiguringViewId(null);
        setViewFieldPickerAnchorRect(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新看板分组字段失败');
    }
  }, [configuringViewId, createKanbanViewForStatus, document, saveConfiguredViewField, saving]);

  const createGalleryView = useCallback(async () => {
    if (!document || saving) return;
    const sequence = loadSequenceRef.current;
    const added = addTableView(document, 'gallery');
    if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
      activateView(added.view.id);
      setViewAddOpen(false);
      setViewAddStep('kind');
      setPendingViewType(null);
      setViewFieldPickerAnchorRect(null);
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, save, saving]);

  const createDataTableView = useCallback(async () => {
    if (!document || saving) return;
    const sequence = loadSequenceRef.current;
    const added = addTableView(document, 'table');
    if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
      activateView(added.view.id);
      setViewAddOpen(false);
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, save, saving]);

  const toggleTableFieldVisibility = useCallback(async (fieldId: string) => {
    if (!editable || !document || saving) return;
    const next = toggleDatasetTableFieldVisibility(document, fieldId);
    if (next !== document) await save(next);
  }, [document, editable, save, saving]);
  const hideTableField = useCallback(async (fieldId: string) => {
    const currentDocument = latestDocumentRef.current;
    if (!editable || !currentDocument || saving) return;
    const next = toggleDatasetTableFieldVisibility(currentDocument, fieldId);
    if (next !== currentDocument) await save(next);
  }, [editable, save, saving]);

  const toggleColumnSort = useCallback(async (fieldId: string) => {
    if (!editable || !document || saving) return;
    const view = document.views.items.find((item) => item.id === activeViewId && item.layout === 'table');
    if (!view) return;
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      views: { ...document.views, items: document.views.items.map((item) => item.id === view.id
        ? { ...item, sort: cycleTableSort(item.sort, fieldId) } : item) },
    };
    if (await save(next)) setTablePage(0);
  }, [activeViewId, document, editable, save, saving]);

  const beginRenameView = useCallback((view: TableView) => {
    setEditingViewName(view.name);
    setEditingViewId(view.id);
  }, []);

  const renameView = useCallback(async (view: TableView, rawName: string) => {
    setEditingViewId(null);
    if (!document || saving) return;
    const trimmedName = rawName.trim();
    if (!trimmedName) {
      toast.error(t('multidimensionalTable.view.nameRequired'));
      return;
    }
    if (trimmedName === view.name) return;
    if (document.views.items.some((item) => item.id !== view.id && item.name === trimmedName)) {
      toast.error(t('multidimensionalTable.view.nameExists'));
      return;
    }
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      views: { ...document.views, items: document.views.items.map((item) => item.id === view.id ? { ...item, name: trimmedName } : item) },
    };
    await save(next, false, loadSequenceRef.current);
  }, [document, loadSequenceRef, save, saving, t]);

  const manageViewRenameInputRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (!managingViewId) return;
    manageViewRenameInputRef.current?.focus();
    manageViewRenameInputRef.current?.select();
  }, [managingViewId]);

  const beginManageViewRename = useCallback((view: TableView) => {
    manageRenameCancelledRef.current = false;
    setManagingViewName(view.name);
    setManagingViewId(view.id);
  }, []);

  const finishManageViewRename = useCallback((view: TableView, rawName: string) => {
    setManagingViewId(null);
    void renameView(view, rawName);
  }, [renameView]);

  const deleteView = useCallback(async (view: TableView) => {
    if (!editable || !canDeleteViews || !document || saving || document.views.items.length <= 1 || deletingViewRef.current) return;
    deletingViewRef.current = true;
    try {
      const sequence = loadSequenceRef.current;
      const next = removeTableView(document, view.id);
      if (next === document) return;
      if (await save(next, false, sequence) && isCurrentSession(sequence) && activeViewId === view.id) {
        const fallback = resolveTableView(next);
        if (fallback) activateView(fallback.id);
      }
    } finally {
      deletingViewRef.current = false;
    }
  }, [activeViewId, activateView, canDeleteViews, document, editable, isCurrentSession, loadSequenceRef, save, saving]);

  const requestDeleteView = useCallback((view: TableView) => {
    if (!editable || !canDeleteViews || !document || saving || document.views.items.length <= 1 || deletingViewRef.current) return;
    setViewPendingDelete(view);
  }, [canDeleteViews, document, editable, saving]);

  const confirmDeleteView = useCallback(() => {
    if (!viewPendingDelete || deletingViewRef.current) return;
    const view = viewPendingDelete;
    setViewPendingDelete(null);
    void deleteView(view);
  }, [deleteView, viewPendingDelete]);

  const linkSelectedNote = useCallback(async (selectedNoteKey: string) => {
    if (!editable || !document || document.collection.placement === 'folder' || !noteField || !selectedNoteKey || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const selectedNote = availableNotesRef.current.find((note) => note.relativePath.replace(/\\/g, '/') === selectedNoteKey);
      const updatedNote = selectedNote ? await applyCalendarDateToNote(selectedNote, notePickerCalendarDate) : null;
      if (!isCurrentSession(sequence)) return;
      if (updatedNote && notePickerCalendarDate) {
        const field = document.dataset.schema.fields.find((item) => item.id === notePickerCalendarDate.fieldId)
          ?? builtinPresetTableField(notePickerCalendarDate.fieldId);
        if (field?.type === 'Date' && field.property_key) {
          setNotes((current) => current.map((note) => note.relativePath.replace(/\\/g, '/') === selectedNoteKey ? updatedNote : note));
        }
      }
      const now = new Date().toISOString();
      const targetRecord = notePickerRecordId ? visibleRecords.find((record) => record.id === notePickerRecordId) : undefined;
      const linkedRecord = targetRecord
        ? { ...targetRecord, updated_at: now, note_path: selectedNoteKey }
        : { id: `rec_${createUuidV7()}`, updated_at: now, note_path: selectedNoteKey };
      const records = upsertTableRecord(document.dataset.records.include, linkedRecord);
      const next: MultidimensionalTableDocument = { ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } };
      setNotePickerOpen(false);
      setNotePickerRecordId(null);
      setNotePickerCalendarDate(null);
      const saved = await save(next, true, sequence);
      if (saved && isCurrentSession(sequence) && activeView?.layout === 'table' && (!targetRecord || !targetRecord.note_path)) setPendingTablePageRecordId(linkedRecord.id);
      if (!saved && updatedNote && notePickerCalendarDate) toast.error('笔记日期已修改，但表格关联未保存，请重试关联');
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '关联笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [activeView?.layout, applyCalendarDateToNote, document, editable, isCurrentSession, loadSequenceRef, noteField, notePickerCalendarDate, notePickerRecordId, save, saving, setNotes, setSaving, visibleRecords, reportSaveFailure]);

  const replaceLinkedNote = useCallback((recordId: string, noteKey: string) => {
    if (!document || document.collection.placement === 'folder' || !noteField || saving) return;
    const now = new Date().toISOString();
    const targetRecord = visibleRecords.find((record) => record.id === recordId);
    if (!targetRecord) return;
    const records = upsertTableRecord(document.dataset.records.include, { ...targetRecord, updated_at: now, note_path: noteKey });
    void save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } })
      .then((saved) => {
        if (saved && !targetRecord.note_path) setPendingTablePageRecordId(recordId);
      });
  }, [document, noteField, save, saving, visibleRecords]);

  const createAndLinkRecordNote = useCallback(async (recordId: string, title: string): Promise<boolean> => {
    const noteTitle = title.trim();
    if (!editable || !document || !noteField || !resolvedNotebookId || !noteTitle || saving) return false;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(noteTitle);
      if (!isCurrentSession(sequence)) return false;
      const note = created.entry;
      const noteKey = note.relativePath.replace(/\\/g, '/');
      const now = new Date().toISOString();
      const targetRecord = visibleRecords.find((record) => record.id === recordId);
      if (!targetRecord) return false;
      const records = upsertTableRecord(document.dataset.records.include, { ...targetRecord, updated_at: now, note_path: noteKey });
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      const saved = await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } }, true, sequence);
      if (saved && isCurrentSession(sequence) && !targetRecord.note_path) setPendingTablePageRecordId(recordId);
      return saved && isCurrentSession(sequence);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '新建并关联笔记失败');
      return false;
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [createNoteInNotebook, document, editable, isCurrentSession, loadSequenceRef, noteField, resolvedNotebookId, save, saving, visibleRecords, reportSaveFailure, setSaving]);

  const handleAutoOpenHandled = useCallback(() => setAutoOpenPrimaryRecordId(null), []);

  const createAndLinkNote = useCallback(async () => {
    const title = newNoteTitle.trim();
    if (!editable || !document || !noteField || !resolvedNotebookId || !title || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(title);
      if (!isCurrentSession(sequence)) return;
      const note = await applyCalendarDateToNote(created.entry, notePickerCalendarDate);
      const noteKey = note.relativePath.replace(/\\/g, '/');
      const now = new Date().toISOString();
      const targetRecord = notePickerRecordId ? visibleRecords.find((record) => record.id === notePickerRecordId) : undefined;
      const linkedRecord = targetRecord
        ? { ...targetRecord, updated_at: now, note_path: noteKey }
        : { id: `rec_${createUuidV7()}`, updated_at: now, note_path: noteKey };
      const records = upsertTableRecord(document.dataset.records.include, linkedRecord);
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      setNotePickerOpen(false);
      setNotePickerRecordId(null);
      setNotePickerCalendarDate(null);
      setNewNoteTitle('');
      const saved = await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } }, false, sequence);
      if (saved && isCurrentSession(sequence) && activeView?.layout === 'table' && (!targetRecord || !targetRecord.note_path)) setPendingTablePageRecordId(linkedRecord.id);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '新建并关联笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [activeView?.layout, applyCalendarDateToNote, createNoteInNotebook, document, editable, isCurrentSession, loadSequenceRef, newNoteTitle, noteField, notePickerCalendarDate, notePickerRecordId, resolvedNotebookId, save, saving, visibleRecords, reportSaveFailure, setSaving]);

  const persistCalendarNote = useCallback(async (note: NoteEntry, calendarDate: { fieldId: string; date: string } | null, sequence: number) => {
    if (!editable || !document || !noteField || !isCurrentSession(sequence)) return false;
    const datedNote = await applyCalendarDateToNote(note, calendarDate);
    if (!isCurrentSession(sequence)) return false;
    const noteKey = datedNote.relativePath.replace(/\\/g, '/');
    const now = new Date().toISOString();
    const record: TableRecord = { id: `rec_${createUuidV7()}`, updated_at: now, note_path: noteKey };
    const records = upsertTableRecord(document.dataset.records.include, record);
    setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), datedNote]);
    const saved = await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } }, true, sequence);
    if (saved && isCurrentSession(sequence)) {
      closeCalendarAddPopover();
    }
    return saved;
  }, [applyCalendarDateToNote, closeCalendarAddPopover, document, editable, isCurrentSession, noteField, save, setNotes]);

  const planExternalNoteDrop = useCallback((
    draggedNotes: NotebookNoteDragResource[], beforeRecordId: string | null,
  ) => {
    if (!document || (activeView?.layout !== 'gallery' && activeView?.layout !== 'table') || !notebookPath || !resolvedNotebookId) {
      return { reason: 'unavailable' as const };
    }
    const uniqueNotes = [...new Map(draggedNotes.map((note) => [canonicalPath(note.relativePath), note])).values()];
    const resolved: NoteEntry[] = [];
    for (const draggedNote of uniqueNotes) {
      if (!isMarkdownNoteDragResource(draggedNote) || draggedNote.notebookId !== resolvedNotebookId) {
        return { reason: 'unavailable' as const };
      }
      const relativePath = canonicalPath(draggedNote.relativePath).replace(/^\/+/, '');
      const note = notes.find((item) => item.relativePath.replace(/\\/g, '/') === relativePath);
      if (!note || !noteInCollectionSource(relativePath, document.dataset.source, currentFilePath, notebookPath)) {
        return { reason: 'unavailable' as const };
      }
      resolved.push(note);
    }
    return planTableNoteDrop({
      explicitRecords: document.dataset.records.include,
      automaticRecords: conditionRecords,
      draggedNotes: resolved,
      beforeRecordId,
      view: activeView,
      fields: document.dataset.schema.fields,
      primaryFieldId: document.dataset.schema.primary_field_id,
      noteForRecord,
      isInSource: (path) => noteInCollectionSource(path, document.dataset.source, currentFilePath, notebookPath),
    });
  }, [activeView, conditionRecords, currentFilePath, document, noteForRecord, notes, notebookPath, resolvedNotebookId]);

  const previewExternalGalleryDrop = useCallback((
    draggedNotes: NotebookNoteDragResource[], beforeRecordId: string | null,
  ): TableNoteDropPreview | TableNoteDropRejection => {
    const plan = planExternalNoteDrop(draggedNotes, beforeRecordId);
    if ('reason' in plan) return plan;
    const index = plan.records.findIndex((record) => plan.draggedPaths.includes(record.note_path.replace(/\\/g, '/')));
    const page = embeddedInEditor
      ? Math.floor(index / galleryPageSize)
      : Math.max(galleryCurrentPage, Math.floor(index / galleryPageSize));
    return {
      records: plan.records.slice(embeddedInEditor ? page * galleryPageSize : 0, (page + 1) * galleryPageSize),
      draggedPaths: plan.draggedPaths,
    };
  }, [embeddedInEditor, galleryCurrentPage, galleryPageSize, planExternalNoteDrop]);

  const persistExternalNotesToTableView = useCallback(async (
    draggedNotes: NotebookNoteDragResource[],
    beforeRecordId: string | null,
    layout: 'table' | 'gallery',
  ) => {
    if (!editable || !document || !noteField || saving || activeView?.layout !== layout) return;
    const plan = planExternalNoteDrop(draggedNotes, beforeRecordId);
    const filteredMessage = layout === 'gallery'
      ? 'multidimensionalTable.galleryDropFiltered' : 'multidimensionalTable.tableDropFiltered';
    const unsupportedMessage = layout === 'gallery'
      ? 'memo.fileTree.galleryDropUnsupported' : 'memo.fileTree.tableDropUnsupported';
    const failedMessage = layout === 'gallery'
      ? 'multidimensionalTable.galleryDropFailed' : 'multidimensionalTable.tableDropFailed';
    if ('reason' in plan) {
      toast.warning(t(plan.reason === 'filtered' ? filteredMessage : unsupportedMessage));
      return;
    }
    const sequence = loadSequenceRef.current;
    if (!isCurrentSession(sequence)) return;
    setSaving(true);
    try {
      const records = plan.includedRecords.map((record) => record.id.startsWith('drop-note:')
        ? { ...record, id: `rec_${createUuidV7()}` } : record);
      const next: MultidimensionalTableDocument = {
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: {
          ...document.dataset.records,
          include: records,
          exclude: document.dataset.records.exclude.filter((record) => !plan.draggedPaths.includes(record.note_path.replace(/\\/g, '/'))),
        } },
      };
      if (!await save(next, true, sequence)) {
        if (isCurrentSession(sequence)) toast.error(t(failedMessage));
        return;
      }
      if (!isCurrentSession(sequence)) return;
      const index = plan.records.findIndex((record) => plan.draggedPaths.includes(record.note_path.replace(/\\/g, '/')));
      const pageSize = layout === 'gallery' ? galleryPageSize : tablePageSize;
      const setPage = layout === 'gallery' ? setGalleryPage : setTablePage;
      setPage((page) => embeddedInEditor
        ? Math.floor(index / pageSize)
        : Math.max(page, Math.floor(index / pageSize)));
    } catch (error) {
      if (isCurrentSession(sequence)) toast.error(error instanceof Error ? error.message : t(failedMessage));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [activeView?.layout, document, editable, embeddedInEditor, galleryPageSize, isCurrentSession, loadSequenceRef, noteField, planExternalNoteDrop, save, saving, setSaving, t, tablePageSize]);

  const addExternalNotesToGallery = useCallback((draggedNotes: NotebookNoteDragResource[], beforeRecordId: string | null) => (
    persistExternalNotesToTableView(draggedNotes, beforeRecordId, 'gallery')
  ), [persistExternalNotesToTableView]);

  const previewExternalTableDrop = useCallback((
    draggedNotes: NotebookNoteDragResource[], beforeRecordId: string | null,
  ): TableNoteDropPreview | TableNoteDropRejection => {
    const plan = planExternalNoteDrop(draggedNotes, beforeRecordId);
    if ('reason' in plan) return plan;
    const index = plan.records.findIndex((record) => plan.draggedPaths.includes(record.note_path.replace(/\\/g, '/')));
    const page = embeddedInEditor
      ? Math.floor(index / tablePageSize)
      : Math.max(currentPage, Math.floor(index / tablePageSize));
    return {
      records: plan.records.slice(embeddedInEditor ? page * tablePageSize : 0, (page + 1) * tablePageSize),
      draggedPaths: plan.draggedPaths,
    };
  }, [currentPage, embeddedInEditor, planExternalNoteDrop, tablePageSize]);

  const addExternalNotesToTable = useCallback((draggedNotes: NotebookNoteDragResource[], beforeRecordId: string | null) => (
    persistExternalNotesToTableView(draggedNotes, beforeRecordId, 'table')
  ), [persistExternalNotesToTableView]);

  const previewTableDrop = useCallback((draggedNotes: NotebookNoteDragResource[], location: { beforeRecordId: string | null }) => (
    previewExternalTableDrop(draggedNotes, location.beforeRecordId)
  ), [previewExternalTableDrop]);
  const onTableDropPreview = useCallback((preview: TableNoteDropPreview | null) => {
    setTableDropPreview((current) => current && preview
      && current.records.length === preview.records.length
      && current.records.every((record, index) => record.id === preview.records[index].id)
      && current.draggedPaths.join('\0') === preview.draggedPaths.join('\0') ? current : preview);
  }, []);
  const onTableDropReject = useCallback((reason: TableNoteDropTargetRejection) => {
    if (reason === 'unsupported-resource' || reason === 'wrong-notebook' || reason === 'unavailable') {
      toast.warning(t('memo.fileTree.tableDropUnsupported'));
    } else if (reason === 'read-only') {
      toast.warning(t('multidimensionalTable.tableDropReadOnly'));
    } else if (reason === 'filtered') {
      toast.warning(t('multidimensionalTable.tableDropFiltered'));
    }
  }, [t]);
  useTableNoteDropTarget({
    id: `table:${tableDropTargetId}`,
    active: activeView?.layout === 'table',
    notebookId: resolvedNotebookId,
    canDrop: editable && !saving,
    canHandleDrop: true,
    hitTest: ({ x, y }) => {
      const area = recordsScrollerRef.current;
      if (!area) return null;
      const bounds = area.getBoundingClientRect();
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
      const rows = [...(tableDropAreaRef.current?.querySelectorAll<HTMLElement>('tbody tr[data-table-record]') ?? [])]
        .filter((candidate) => {
          const rowBounds = candidate.getBoundingClientRect();
          return rowBounds.bottom > bounds.top && rowBounds.top < bounds.bottom;
        });
      if (!rows.length) return { beforeRecordId: null };
      const row = rows.reduce((nearest, candidate) => {
        const rowBounds = candidate.getBoundingClientRect();
        const nearestBounds = nearest.getBoundingClientRect();
        return Math.abs(y - (rowBounds.top + rowBounds.height / 2))
          < Math.abs(y - (nearestBounds.top + nearestBounds.height / 2)) ? candidate : nearest;
      });
      const index = rows.indexOf(row);
      const rowBounds = row.getBoundingClientRect();
      const insertAfter = y >= rowBounds.top + rowBounds.height / 2;
      return {
        beforeRecordId: rows[index + (insertAfter ? 1 : 0)]?.dataset.tableRecord
          ?? (insertAfter ? nextTableRecordId : null),
      };
    },
    locationKey: ({ beforeRecordId }) => beforeRecordId ?? 'end',
    preview: previewTableDrop,
    onPreview: onTableDropPreview,
    onDrop: (notes, location) => addExternalNotesToTable(notes, location.beforeRecordId),
    onReject: onTableDropReject,
    onError: (error) => toast.error(error instanceof Error ? error.message : t('multidimensionalTable.tableDropFailed')),
  });

  const addExternalNotesToCalendar = useCallback(async (
    draggedNotes: NotebookNoteDragResource[],
    date: string,
  ) => {
    if (!editable || !document || !noteField || !notebookPath || !calendarDateFieldId
      || !calendarField || calendarField.type !== 'Date' || saving) return;
    const sequence = loadSequenceRef.current;
    const uniqueNotes = [...new Map(draggedNotes.map((note) => [canonicalPath(note.relativePath), note])).values()];
    const resolved = uniqueNotes.map((draggedNote) => {
      if (!isMarkdownNoteDragResource(draggedNote) || draggedNote.notebookId !== resolvedNotebookId) return null;
      const relativePath = canonicalPath(draggedNote.relativePath).replace(/^\/+/, '');
      const note = notes.find((item) => item.relativePath.replace(/\\/g, '/') === relativePath);
      if (!note || !noteInCollectionSource(relativePath, document.dataset.source, currentFilePath, notebookPath)) return null;
      return { note, relativePath };
    });
    if (!resolved.length || resolved.some((item) => !item)) {
      toast.warning(t('memo.fileTree.calendarDropUnsupported'));
      return;
    }
    if (!isCurrentSession(sequence)) return;
    setSaving(true);
    try {
      for (const item of resolved) {
        if (!item || !isCurrentSession(sequence)) return;
        const datedNote = await applyCalendarDateToNote(item.note, { fieldId: calendarDateFieldId, date });
        if (!isCurrentSession(sequence)) return;
        setNotes((current) => current.map((note) => (
          note.relativePath.replace(/\\/g, '/') === item.relativePath ? datedNote : note
        )));
      }

      let records = [...document.dataset.records.include];
      const now = new Date().toISOString();
      for (const item of resolved) {
        if (!item) continue;
        const existing = datasetRecords.find((record) => record.note_path.replace(/\\/g, '/') === item.relativePath);
        const linkedRecord = existing
          ? { ...existing, updated_at: now, note_path: item.relativePath }
          : { id: `rec_${createUuidV7()}`, updated_at: now, note_path: item.relativePath };
        records = upsertTableRecord(records, linkedRecord);
      }
      const next: MultidimensionalTableDocument = {
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } },
      };
      if (!await save(next, true, sequence) || !isCurrentSession(sequence)) {
        toast.error('日历关联未保存，请重试');
        return;
      }
    } catch (error) {
      if (isCurrentSession(sequence)) toast.error(error instanceof Error ? error.message : '加入日历失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [applyCalendarDateToNote, calendarDateFieldId, calendarField, currentFilePath, datasetRecords, document, editable, isCurrentSession, loadSequenceRef, noteField, notes, notebookPath, resolvedNotebookId, save, saving, setNotes, setSaving, t]);

  const createCalendarNote = useCallback(async () => {
    const title = calendarAddTitle.trim();
    if (!editable || !document || !noteField || !resolvedNotebookId || !calendarAddDate || !title || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      let pending = calendarPendingCreatedNoteRef.current;
      if (!pending || pending.title !== title) {
        const created = await createNoteInNotebook(title);
        if (!isCurrentSession(sequence)) return;
        pending = { title, entry: created.entry };
        calendarPendingCreatedNoteRef.current = pending;
      }
      let note = await applyCalendarDateToNote(pending.entry, calendarAddDate);
      if (!isCurrentSession(sequence)) return;
      const properties: Record<string, unknown> = {};
      const types: Record<string, PropertyKind | null | undefined> = {};
      for (const field of calendarCreateFields) {
        if (field.type === 'primary' || !field.property_key) continue;
        const property = calendarCreatePropertyValue(field, calendarCreatePropertyValues[field.id]);
        if (!property.include) continue;
        properties[field.property_key] = property.value;
        types[field.property_key] = field.type;
      }
      if (Object.keys(properties).length) {
        const path = notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
        if (!path || !await setDocumentProperties(path, properties, types)) throw new Error('笔记属性未能保存');
        note = { ...note, updatedAt: Date.now(), properties: { ...note.properties, ...properties } };
      }
      const saved = await persistCalendarNote(note, null, sequence);
      if (saved && calendarPendingCreatedNoteRef.current?.entry.relativePath === pending.entry.relativePath) {
        calendarPendingCreatedNoteRef.current = null;
      }
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '新建并关联笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [applyCalendarDateToNote, calendarAddDate, calendarAddTitle, calendarCreateFields, calendarCreatePropertyValues, createNoteInNotebook, document, editable, isCurrentSession, loadSequenceRef, noteField, notebookPath, persistCalendarNote, resolvedNotebookId, saving, setSaving, reportSaveFailure]);

  const addField = useCallback(async (preset?: PropertyPreset) => {
    if (!document || saving) return;
    try {
      if (preset) {
        await save(addPresetField(document, preset));
        return;
      }
      const propertyKey = newFieldPropertyKey.trim();
      if (!propertyKey) return;
      const options = (newFieldType === 'Select' || newFieldType === 'MultiSelect')
        ? newFieldOptions.reduce<TableFieldOption[]>((result, option) => {
          const label = option.label.trim();
          if (label && !result.some((item) => item.label === label)) result.push({ ...option, label });
          return result;
        }, [])
        : [];
      let field: TableField = {
        id: `fld_${createUuidV7()}`,
        type: newFieldType,
        property_key: propertyKey,
        ...(options.length ? { options } : {}),
        ...(newFieldType === 'Image' ? { multiple: true } : {}),
      };
      const existing = propertyFields.find((item) => canonicalizePropertyKey(item.key).toLowerCase() === canonicalizePropertyKey(propertyKey).toLowerCase());
      if (existing) {
        if (existing.type !== field.type) throw new Error('此属性已有不同类型，请使用已有预设');
        field = tableFieldFromPreset(existing);
      } else field = { ...field, preset_pending: true };
      if (!await save(addTableField(document, field))) return;
      if (!existing) {
        try { await ensureTableFieldPreset(field); }
        catch (error) { toast.error(`当前表格已保存，预设待同步：${error instanceof Error ? error.message : '请稍后重试'}`); }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '添加属性失败');
      return;
    }
    setNewFieldOpen(false);
    setNewFieldPropertyKey('');
    setNewFieldOptions([]);
  }, [document, newFieldOptions, newFieldPropertyKey, newFieldType, propertyFields, save, saving]);

  const removePreset = useCallback((preset: PropertyPreset) => {
    if (!document || saving) return;
    try {
      void save(removePresetField(document, preset));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '移除预设属性失败');
    }
  }, [document, save, saving]);

  const deleteBuiltinField = useCallback(async (field: TableField): Promise<boolean> => {
    if (!document || saving) return false;
    try {
      return await save(removeBuiltinTableField(document, field.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '移除只读属性失败');
      return false;
    }
  }, [document, save, saving]);

  const saveHeaderFieldEdits = useCallback(async (field: TableField, nameDraft: string, optionsDraft: TableFieldOption[]): Promise<boolean> => {
    if (!document || saving || field.type === 'primary') return false;
    const expectedRevision = field.preset_revision;
    field = document.dataset.schema.fields.find((item) => item.id === field.id) ?? field;
    const name = nameDraft.trim();
    const nextOptions = field.type === 'Select' || field.type === 'MultiSelect'
      ? optionsDraft.map((option) => ({ ...option, label: option.label.trim() })).filter((option) => option.label)
      : undefined;
    if (nextOptions && new Set(nextOptions.map((option) => option.label)).size !== nextOptions.length) {
      toast.error('选项名称不能重复');
      return false;
    }
    const optionsChanged = nextOptions !== undefined
      && JSON.stringify(field.options ?? []) !== JSON.stringify(nextOptions);
    const propertyKey = field.property_key;
    if (!propertyKey || !document.dataset.schema.fields.some((item) => item.id === field.id)) return false;
    // A user preset's key IS the name typed in the header. System presets keep
    // their fixed key and only resolve a display label.
    const systemPreset = usePropertyPresetStore.getState().registry.systemFields?.some((item) => item.id === field.id)
      || isSystemPropertyKey(propertyKey);
    const keyChanged = !systemPreset && Boolean(name) && name !== propertyKey;
    if (!optionsChanged && !keyChanged) return true;
    if (keyChanged) {
      const normalized = canonicalizePropertyKey(name).toLowerCase();
      if (isSystemPropertyKey(propertyKey) || isSystemPropertyKey(name)
        || !name || ['flowix_property_types', 'flowix_plugin'].includes(normalized)) {
        toast.error('系统预设或保留名称不能修改属性名称');
        return false;
      }
      if (document.dataset.schema.fields.some((item) => item.id !== field.id && item.property_key
          && canonicalizePropertyKey(item.property_key).toLowerCase() === normalized)
        || propertyFields.some((item) => item.id !== field.id && canonicalizePropertyKey(item.key).toLowerCase() === normalized)) {
        toast.error('属性名称已存在');
        return false;
      }
    }
    if (optionsChanged && notesLoadError) { toast.error('当前表格的笔记尚未完整加载，请稍后重试'); return false; }

    const nextKey = keyChanged ? canonicalizePropertyKey(name) : propertyKey;
    let nextField: TableField = { ...field, preset_revision: expectedRevision ?? field.preset_revision, preset_pending: true };
    if (keyChanged) {
      nextField = { ...nextField, property_key: nextKey };
      delete nextField.name;
    }
    if (nextOptions !== undefined) {
      nextField = { ...nextField, options: nextOptions };
      if (nextOptions.length === 0) delete nextField.options;
    }

    const nextDocument: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      dataset: { ...document.dataset, schema: { ...document.dataset.schema, fields: document.dataset.schema.fields.map((item) => item.id === field.id ? nextField : item) } },
    };
    const sequence = loadSequenceRef.current;

    // Renaming a user preset renames its key everywhere: definition, current
    // table and every note that carries the property.
    if (keyChanged) {
      setSaving(true);
      try {
        const savedNow = await save(nextDocument, true, sequence);
        if (!savedNow) {
          reportSaveFailure(sequence);
          toast.error('当前表格未保存，可以重试');
          return false;
        }
        try { await updatePresetFromTable(nextField, presetFromTableField(nextField)); }
        catch (error) {
          toast.error(`当前表格已保存，预设待同步：${error instanceof Error ? error.message : '请稍后重试'}`);
          return true;
        }
        const transform = optionsChanged && nextOptions
          ? (value: unknown) => migratedOptionValue(field, nextOptions, value) ?? { value, remove: false }
          : undefined;
        let keyResult: { moved: number; failed: number } = { moved: 0, failed: 0 };
        try { keyResult = await migrateNotePropertyKey(propertyKey, nextKey, transform); }
        catch (error) { toast.error(error instanceof Error ? error.message : '笔记属性改名失败'); }
        if (keyResult.failed) toast.error(`${keyResult.failed} 个笔记未改名（目标属性名已存在），已保留原值`);
        if (isCurrentSession(sequence)) {
          setNotes((current) => current.map((note) => renameNoteProperty(note, propertyKey, nextKey, field, optionsChanged ? nextOptions : undefined, propertyFields)));
        }
        return savedNow;
      } finally {
        if (isCurrentSession(sequence)) setSaving(false);
      }
    }

    let migrations: FieldValueMigration[];
    try {
      migrations = planFieldMigrations(
        datasetRecords.flatMap((record) => {
          const note = noteForRecord(record);
          return note ? [note] : [];
        }), field, propertyKey, optionsChanged ? nextOptions : undefined,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '属性迁移失败');
      return false;
    }
    if (migrations.some(({ noteKey }) => {
      const pending = pendingNotePropertiesRef.current.get(noteKey);
      return pending?.has(propertyKey);
    })) {
      toast.error('该属性正在保存，请稍后重试');
      return false;
    }
    setSaving(true);
    try {
      const result = await applyFieldMigrations(migrations, async (migration) => {
        const path = notebookPath ? joinNotebookMemoPath(notebookPath, migration.noteKey) : null;
        if (!path) return false;
        if (!isCurrentSession(sequence)) return false;
        const before = {
          [propertyKey]: { exists: true, value: migration.previousValue },
        };
        const after = {
          [propertyKey]: { exists: !migration.remove, value: migration.value },
        };
        return compareAndPatchDocumentProperties(path, before, after, {
          [propertyKey]: field.type === 'primary' ? undefined : field.type,
        });
      }, () => save(nextDocument, true, sequence));
      if (result.saved) {
        try { await updatePresetFromTable(nextField, presetFromTableField(nextField)); }
        catch (error) { toast.error(error instanceof Error ? error.message : '同步用户预设失败'); }
      }
      if (result.failed.length) toast.error(`当前表格已保存，${result.failed.length} 个笔记未同步，已保留原值`);
      if (!isCurrentSession(sequence)) return result.saved;
      const applied = new Map(result.retained.map((migration) => [migration.noteKey, migration]));
      if (result.saved && applied.size) setNotes((current) => current.map((note) => {
        const update = applied.get(note.relativePath.replace(/\\/g, '/'));
        if (!update) return note;
        const properties = { ...note.properties };
        if (update.remove) delete properties[propertyKey];
        if (!update.remove) properties[propertyKey] = update.value;
        const types = readPropertyTypes(properties[PROPERTY_TYPES_KEY]);
        if (update.remove || resolvePropertyPreset(propertyKey, propertyFields)) delete types[propertyKey];
        else if (field.type !== 'primary') types[propertyKey] = field.type;
        if (Object.keys(types).length) properties[PROPERTY_TYPES_KEY] = types;
        else delete properties[PROPERTY_TYPES_KEY];
        return { ...note, properties };
      }));
      if (!result.saved) {
        reportSaveFailure(sequence);
        toast.error('当前表格未保存，可以重试');
      }
      return result.saved;
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [datasetRecords, document, isCurrentSession, loadSequenceRef, noteForRecord, notebookPath, notesLoadError, pendingNotePropertiesRef, propertyFields, reportSaveFailure, save, saving, setNotes, setSaving]);

  const headerEditsQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const latestHeaderSaverRef = useRef(saveHeaderFieldEdits);
  latestHeaderSaverRef.current = saveHeaderFieldEdits;
  const queueHeaderFieldEdits = useCallback((field: TableField, name: string, options: TableFieldOption[]) => {
    const write = headerEditsQueueRef.current.catch(() => false).then(async () => {
      // Let the previous write publish its document and release the saving state.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return latestHeaderSaverRef.current(field, name, options);
    });
    headerEditsQueueRef.current = write;
    return write;
  }, []);

  const saveFieldDefinition = useCallback(async (nextDocument: MultidimensionalTableDocument, field: TableField): Promise<boolean> => {
    const pendingDocument = { ...nextDocument, dataset: { ...nextDocument.dataset, schema: {
      ...nextDocument.dataset.schema,
      fields: nextDocument.dataset.schema.fields.map((item) => item.id === field.id ? { ...item, preset_revision: field.preset_revision ?? item.preset_revision, preset_pending: true } : item),
    } } };
    if (!await save(pendingDocument)) return false;
    const persistedField = pendingDocument.dataset.schema.fields.find((item) => item.id === field.id)!;
    try { await updatePresetFromTable(persistedField, presetFromTableField(persistedField)); }
    catch (error) { toast.error(`当前表格已保存，预设待同步：${error instanceof Error ? error.message : '请稍后重试'}`); }
    return true;
  }, [save]);

  const changeFieldType = useCallback(async (field: TableField, type: TableFieldType, optionsOverride?: TableField['options']): Promise<boolean> => {
    if (!document || saving || field.type === 'primary' || type === 'primary' || field.type === type) return false;
    if (usePropertyPresetStore.getState().registry.systemFields?.some((item) => item.id === field.id)
      || isSystemPropertyKey(field.property_key ?? '')) {
      toast.error('系统预设字段不能修改类型');
      return false;
    }
    const options = type === 'Select' || type === 'MultiSelect'
      ? optionsOverride?.length
        ? optionsOverride
        : field.options?.length
          ? field.options
        : ['选项 1', '选项 2', '选项 3'].map((label) => ({ id: `opt_${createUuidV7()}`, label }))
      : undefined;
    const multiple = type === 'Image' ? field.type === 'Image' ? Boolean(field.multiple) : true : undefined;
    const incompatibleRecords = datasetRecords.filter((record) => {
      const note = noteForRecord(record);
      const value = note && field.property_key && Object.prototype.hasOwnProperty.call(note.properties, field.property_key)
        ? note.properties[field.property_key] : null;
      return !valueMatchesFieldType(value, type, options, Boolean(multiple));
    });
    if (incompatibleRecords.length) {
      toast.error(`${incompatibleRecords.length} 条记录的现有值与目标类型不兼容，请先修改值`);
      return false;
    }
    const nextDocument = changeFieldTypeInDocument(document, field.id, type, options, multiple);
    return saveFieldDefinition(nextDocument, { ...field, type });
  }, [datasetRecords, document, noteForRecord, saveFieldDefinition, saving]);

  const applyFieldPreset = useCallback(async (field: TableField, preset: PropertyPreset): Promise<boolean> => {
    if (!document || saving || field.type === 'primary') return false;
    if (usePropertyPresetStore.getState().registry.systemFields?.some((item) => item.id === field.id)
      || isSystemPropertyKey(field.property_key ?? '')) return false;
    const propertyKey = preset.key.trim();
    const normalizedKey = canonicalizePropertyKey(propertyKey).toLocaleLowerCase();
    if (!propertyKey || normalizedKey === 'flowix_property_types'
      || document.dataset.schema.fields.some((item) => item.id !== field.id && item.property_key
        && canonicalizePropertyKey(item.property_key).toLocaleLowerCase() === normalizedKey)) {
      toast.error('属性键已存在或属于保留名称');
      return false;
    }
    const definition = propertyFields.find((item) => item.id === preset.id && item.id !== undefined)
      ?? propertyFields.find((item) => canonicalizePropertyKey(item.key).toLowerCase() === normalizedKey);
    if (!definition) { toast.error('预设尚未加载，请稍后重试'); return false; }
    const nextField = tableFieldFromPreset(definition);
    const options = nextField.options;
    const incompatibleRecords = datasetRecords.filter((record) => {
      const note = noteForRecord(record);
      const value = note && Object.prototype.hasOwnProperty.call(note.properties, propertyKey)
        ? notePropertyEditorValue(note, nextField)
        : null;
      return !valueMatchesFieldType(value, preset.kind, options, false);
    });
    if (incompatibleRecords.length) {
      toast.error(`${incompatibleRecords.length} 条记录的现有值与该属性预设不兼容，请先修改值`);
      return false;
    }
    const next = bindTableField(document, field.id, definition);
    return save({ ...next, collection: reviseCollection(document.collection) });
  }, [datasetRecords, document, noteForRecord, propertyFields, save, saving]);

  const deleteField = useCallback(async (field: TableField): Promise<boolean> => {
    if (!document || saving || field.type === 'primary' || field.id === document.dataset.schema.primary_field_id) return false;
    const registry = usePropertyPresetStore.getState().registry;
    const systemPreset = registry.systemFields?.find((item) => item.id === field.id);
    if (systemPreset) return false;
    const preset = registry.fields.find((item) => item.id === field.id);
    if (!preset) {
      const dependentViews = viewsRequiringField(document, field.id);
      if (dependentViews.length || collectionFilterUsesField(document.dataset.filter as unknown as DatasetFilter | null, field.id)) {
        toast.error('请先调整依赖此属性的视图或笔记数据集');
        return false;
      }
      return save(removeField(document, field.id));
    }
    setPendingDeleteTarget({ field, preset });
    setPendingDeleteTableCount(await countPresetTableReferences(field.id));
    return true;
  }, [document, save, saving]);

  const confirmDeleteField = useCallback(async () => {
    const target = pendingDeleteTarget;
    if (!document || !target) { setPendingDeleteTarget(null); return; }
    setDeletingFieldBusy(true);
    try {
      const savedCurrentTable = await save(retireTablePreset(document, target.preset));
      if (!savedCurrentTable) {
        toast.error('当前表格未保存，属性尚未全局删除');
        return;
      }
      const result = await deletePresetEverywhere(target.preset);
      if (result.failed) toast.error(`${result.failed} 个笔记未同步删除，稍后可重试`);
      setPendingDeleteTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除属性失败');
    } finally {
      setDeletingFieldBusy(false);
    }
  }, [document, pendingDeleteTarget, save]);

  const deleteRecord = useCallback((recordId: string) => {
    if (!document || saving) return;
    const record = visibleRecords.find((item) => item.id === recordId);
    if (!record) return;
    const primaryField = document.dataset.schema.fields[0];
    const datasetFilter = resolveDatasetFilterForLocation(document.dataset.filter, document.collection.placement, currentFilePath, notebookPath);
    let nextDocument = document;
    const note = record ? noteForRecord(record) : undefined;
    const ruleMatch = primaryField && record && note
      ? datasetFilter !== null && noteMatchesCollectionFilter(note, document.dataset.schema.fields, primaryField.id, datasetFilter)
      : false;
    if (primaryField && record && note && ruleMatch) {
      const notePath = note.relativePath.replace(/\\/g, '/');
      nextDocument = {
        ...document,
        dataset: { ...document.dataset, records: { ...document.dataset.records,
          exclude: document.dataset.records.exclude.some((item) => item.note_path === notePath)
            ? document.dataset.records.exclude
            : [...document.dataset.records.exclude, { note_path: notePath }] } },
      };
    }
    const next = {
      ...nextDocument,
      collection: reviseCollection(nextDocument.collection),
      dataset: { ...nextDocument.dataset, records: { ...nextDocument.dataset.records, include: document.dataset.records.include.filter((item) => item.id !== recordId) } },
    };
    void save(next);
  }, [currentFilePath, document, notebookPath, noteForRecord, save, saving, visibleRecords]);

  const updateRecordField = useCallback((recordId: string, fieldId: string, value: unknown) => {
    if (!document) return;
    const record = visibleRecords.find((item) => item.id === recordId);
    const field = document.dataset.schema.fields.find((item) => item.id === fieldId) ?? builtinPresetTableField(fieldId) ?? undefined;
    if (record && field) updateCell(record, noteForRecord(record), field, value);
  }, [document, noteForRecord, updateCell, visibleRecords]);

  const selectImageForCell = useCallback(async (record: TableRecord, note: NoteEntry, field: TableField) => {
    if (field.type !== 'Image' || !editable || saving) return;
    if (!notebookPath || !notebookId) {
      toast.error(t('document.properties.imageUploadFailed'));
      return;
    }
    const relativePath = await selectPropertyImage({ id: notebookId, path: notebookPath }, t);
    if (relativePath) updateCell(record, note, field, relativePath);
  }, [editable, notebookId, notebookPath, saving, t, updateCell]);

  const handleRowActionOpenChange = useCallback((open: boolean, recordId: string) => {
    setRowActionRecordId(open ? recordId : null);
  }, []);
  const handleDeleteRecord = useCallback((recordId: string) => {
    setRowActionRecordId(null);
    deleteRecord(recordId);
  }, [deleteRecord]);

  const renameLinkedNote = useCallback(async (_recordId: string, note: NoteEntry, title: string): Promise<NoteEntry | null> => {
    if (!editable || !notebookPath || saving) return null;
    const sequence = loadSequenceRef.current;
    const oldPath = joinNotebookMemoPath(notebookPath, note.relativePath);
    if (!oldPath) return null;
    const identity = ensureFileDisplayIdentity(oldPath);
    setSaving(true);
    try {
      const renamed = await renameMarkdownTitle({
        path: oldPath,
        title,
        scopePath: notebookPath,
        notebook: notebookId ? { id: notebookId, path: notebookPath } : null,
        displayId: identity.displayId,
        onPathChanged: (previousPath, nextPath) => replaceExternalDocumentPath(identity.displayId, previousPath, nextPath),
      });
      if (!renamed) {
        reportSaveFailure(sequence);
        return null;
      }
      if (!renamed.changed) return note;
      const parentPath = note.relativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      const nextRelativePath = `${parentPath ? `${parentPath}/` : ''}${renamed.filename}`;
      const updatedNote = { ...note, relativePath: nextRelativePath, title: displayTitleFromFilename(nextRelativePath) };
      if (isCurrentSession(sequence)) {
        setNotes((current) => current.map((item) => item.relativePath.replace(/\\/g, '/') === note.relativePath.replace(/\\/g, '/') ? updatedNote : item));
      }
      return updatedNote;
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '重命名笔记失败');
      return null;
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [editable, isCurrentSession, loadSequenceRef, notebookPath, saving, setNotes, reportSaveFailure, setSaving]);

  const closeCalendarNoteDialog = useCallback(() => {
    calendarPendingCreatedNoteRef.current = null;
    setCalendarEditingRecord(null);
    closeCalendarAddPopover();
  }, [closeCalendarAddPopover]);

  const openCalendarEditPopover = useCallback((recordId: string, anchorRect: DOMRect) => {
    const record = visibleRecords.find((item) => item.id === recordId);
    const note = record ? noteForRecord(record) : undefined;
    if (!record || !note) {
      toast.warning('无法找到这篇笔记');
      return;
    }
    if (!editable) {
      toast.warning('当前多维表格为只读状态');
      return;
    }
    const dateValue = calendarDateMetadata
      ? calendarDateTimeForTimestamp(note[calendarDateMetadata.timestamp])
      : calendarField ? notePropertyEditorValue(note, calendarField) : null;
    const date = calendarDateKey(dateValue) ?? isoDate(new Date());
    setCalendarEditingRecord(record);
    setCalendarCreatePropertyValues(Object.fromEntries(calendarCreateFields.map((field) => {
      const value = notePropertyEditorValue(note, field);
      return [field.id, value ?? (field.type === 'Boolean' ? false : field.type === 'MultiSelect' || field.type === 'Tag' || field.type === 'Color' || (field.type === 'Image' && field.multiple) ? [] : '')];
    })));
    openCalendarAddDialog(date, anchorRect, calendarDateFieldId ?? '');
    setCalendarAddTitle(note.title);
  }, [calendarCreateFields, calendarDateFieldId, calendarDateMetadata, calendarField, editable, noteForRecord, openCalendarAddDialog, setCalendarAddTitle, visibleRecords]);

  const saveCalendarNoteEdit = useCallback(async () => {
    const record = calendarEditingRecord;
    const initialNote = record ? noteForRecord(record) : undefined;
    const title = calendarAddTitle.trim();
    if (!record || !initialNote || !editable || !document || !title || saving) return;
    const sequence = loadSequenceRef.current;
    try {
      const note = title === initialNote.title ? initialNote : await renameLinkedNote(record.id, initialNote, title);
      if (!note || !isCurrentSession(sequence)) return;
      if (note.relativePath.replace(/\\/g, '/') !== record.note_path.replace(/\\/g, '/')) {
        setCalendarEditingRecord((current) => current?.id === record.id
          ? { ...current, note_path: note.relativePath.replace(/\\/g, '/') }
          : current);
      }
      if (!notebookPath) throw new Error('无法确定笔记路径');
      const path = joinNotebookMemoPath(notebookPath, note.relativePath);
      if (!path) throw new Error('无法确定笔记路径');
      const expected: Record<string, { exists: boolean; value?: unknown }> = {};
      const next: Record<string, { exists: boolean; value?: unknown }> = {};
      const types: Record<string, PropertyKind> = {};
      for (const field of calendarCreateFields) {
        if (!field.property_key) continue;
        const key = field.property_key;
        const property = calendarCreatePropertyValue(field, calendarCreatePropertyValues[field.id]);
        expected[key] = {
          exists: Object.prototype.hasOwnProperty.call(note.properties, key),
          value: note.properties[key],
        };
        next[key] = property.include ? { exists: true, value: property.value } : { exists: false };
        types[key] = field.type as PropertyKind;
      }
      setSaving(true);
      const saved = Object.keys(next).length
        ? await compareAndPatchDocumentProperties(path, expected, next, types)
        : true;
      if (!saved) throw new Error('笔记属性未能保存');
      if (!isCurrentSession(sequence)) return;
      const properties = { ...note.properties };
      for (const [key, state] of Object.entries(next)) {
        if (state.exists) properties[key] = state.value;
        else delete properties[key];
      }
      setNotes((current) => current.map((item) => item.relativePath.replace(/\\/g, '/') === note.relativePath.replace(/\\/g, '/')
        ? { ...note, updatedAt: Date.now(), properties }
        : item));
      closeCalendarNoteDialog();
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '编辑笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [calendarAddTitle, calendarCreateFields, calendarCreatePropertyValues, calendarEditingRecord, closeCalendarNoteDialog, document, editable, isCurrentSession, loadSequenceRef, noteForRecord, notebookPath, renameLinkedNote, reportSaveFailure, saving, setCalendarEditingRecord, setNotes, setSaving]);

  const renameKanbanRecord = useCallback(async (recordId: string, title: string) => {
    const record = visibleRecords.find((item) => item.id === recordId);
    const note = record ? noteForRecord(record) : undefined;
    if (!record || !note) return;
    // The shared rename operation updates table references and emits the collection change event.
    await renameLinkedNote(recordId, note, title);
  }, [noteForRecord, renameLinkedNote, visibleRecords]);

  const openLinkedNote = useCallback((note: NoteEntry) => {
    if (!notebookPath) return;
    const path = joinNotebookMemoPath(notebookPath, note.relativePath);
    if (path) void openWorkspaceSurface({
      host: 'browser-column',
      target: { ...createFileBrowserTarget(path, notebookPath), notebookId: resolvedNotebookId },
      options: { browserDisposition: 'open-in-column' },
    });
  }, [notebookPath, notebookId, resolvedNotebookId]);
  const openLinkedRecord = useCallback((recordId: string) => {
    const record = visibleRecords.find((item) => item.id === recordId);
    const note = record ? noteForRecord(record) : undefined;
    if (note) openLinkedNote(note);
  }, [noteForRecord, openLinkedNote, visibleRecords]);

  const createBlankGalleryNote = useCallback(async () => {
    if (!editable || !document || !noteField || !resolvedNotebookId || saving) return;
    const nextNoteNumber = datasetRecords.reduce((max, record) => {
      const title = noteForRecord(record)?.title ?? '';
      const match = /^未命名笔记\s+(\d+)$/.exec(title.trim());
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(`未命名笔记 ${nextNoteNumber}`);
      if (!isCurrentSession(sequence)) return;
      const note = created.entry;
      const noteKey = note.relativePath.replace(/\\/g, '/');
      const record: TableRecord = {
        id: `rec_${createUuidV7()}`,
        updated_at: new Date().toISOString(),
        note_path: noteKey,
      };
      const records = upsertTableRecord(document.dataset.records.include, record);
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      const saved = await save({
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } },
      }, true, sequence);
      if (saved && isCurrentSession(sequence)) {
        setTablePage(0);
      }
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '新建并关联笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [createNoteInNotebook, datasetRecords, document, editable, isCurrentSession, loadSequenceRef, noteField, noteForRecord, reportSaveFailure, resolvedNotebookId, save, saving, setNotes, setSaving]);

  const chooseGalleryData = useCallback(() => {
    setDatasetFilterOpen(false);
    setMatchingOpen(true);
  }, []);

  const requestDeleteLinkedNote = useCallback((note: NoteEntry) => {
    const targetNotebookId = resolvedNotebookId ?? notebookId;
    if (!targetNotebookId) return;
    const filename = note.relativePath.split(/[\\/]/).filter(Boolean).pop() ?? note.relativePath;
    const target: NoteListItem = {
      kind: 'path-note',
      notebookId: targetNotebookId,
      relativePath: note.relativePath,
      filename,
      title: note.title,
      preview: note.preview,
      thumbnail: note.thumbnail,
      tags: note.tags,
      todos: note.todos,
      agents: note.agents,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      favorited: note.favorited,
      icon: note.icon,
      colors: note.colors,
      properties: note.properties,
    };
    window.dispatchEvent(new CustomEvent<NoteListItem>('flowix:request-delete-memo', { detail: target }));
  }, [notebookId, resolvedNotebookId]);

  const groupFieldId = activeView?.layout === 'kanban' && typeof activeView.config.group_by === 'string' ? activeView.config.group_by : null;
  const groupField = groupFieldId ? document?.dataset.schema.fields.find((field) => field.id === groupFieldId) : undefined;
  const calendarDateFieldOptions = [
    ...NOTE_CALENDAR_DATE_FIELDS.map(({ id, label }) => ({ id, label, readOnly: true })),
    ...(document?.dataset.schema.preset_fields.includes(NOTE_CALENDAR_DATE_FIELD_ID) ? [{ id: NOTE_CALENDAR_DATE_FIELD_ID, label: '日期' }] : []),
    ...(document?.dataset.schema.fields.filter((field) => field.type === 'Date').map((field) => ({ id: field.id, label: fieldLabel(field, propertyFields, t) })) ?? []),
  ];
  const kanbanGroups = useMemo(() => document && groupField?.type === 'Select'
    ? groupRecordsByValue(secondaryViewRecords, (record) => notePropertyEditorValue(noteForRecord(record), groupField))
    : new Map<string, TableRecord[]>(), [document, groupField, noteForRecord, secondaryViewRecords]);
  const kanbanUnassignedRecords = useMemo(() => {
    if (!document || groupField?.type !== 'Select') return [];
    const assignedIds = new Set((groupField.options ?? []).flatMap((option) => kanbanGroups.get(option.id) ?? []).map((record) => record.id));
    return secondaryViewRecords.filter((record) => !assignedIds.has(record.id));
  }, [document, groupField, kanbanGroups, secondaryViewRecords]);
  const addKanbanLane = useCallback(() => {
    if (!editable || saving || groupField?.type !== 'Select') return;
    const existingLabels = new Set((groupField.options ?? []).map((option) => option.label.trim()));
    let number = 1;
    while (existingLabels.has(`选项 ${number}`)) number += 1;
    const option = { id: `opt_${createUuidV7()}`, label: `选项 ${number}` };
    setPendingKanbanOption(option);
    setMatchingOpen(true);
    setFieldPanelHeaderId(groupField.id);
  }, [editable, groupField, saving]);
  const reorderKanbanLane = useCallback(async (sourceOptionId: string, targetOptionId: string, insertAfter: boolean) => {
    if (!document || groupField?.type !== 'Select' || saving || sourceOptionId === targetOptionId) return;
    const options = [...(groupField.options ?? [])];
    const sourceIndex = options.findIndex((option) => option.id === sourceOptionId);
    if (sourceIndex < 0 || !options.some((option) => option.id === targetOptionId)) return;
    const [source] = options.splice(sourceIndex, 1);
    const targetIndex = options.findIndex((option) => option.id === targetOptionId);
    options.splice(targetIndex + (insertAfter ? 1 : 0), 0, source);
    if (options.every((option, index) => option.id === groupField.options?.[index]?.id)) return;
    const updatedField = { ...groupField, options };
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      dataset: { ...document.dataset, schema: { ...document.dataset.schema, fields: document.dataset.schema.fields.map((field) => field.id === groupField.id ? updatedField : field) } },
    };
    await save(next);
  }, [document, groupField, save, saving]);
  const addKanbanTask = useCallback(async (targetGroupId: string) => {
    if (!editable || !document || !noteField || !resolvedNotebookId || groupField?.type !== 'Select' || saving) return;
    const targetIsUnassigned = targetGroupId === KANBAN_UNASSIGNED_GROUP_ID;
    const targetOption = groupField.options?.find((option) => option.id === targetGroupId);
    if (!targetIsUnassigned && !targetOption) return;
    if (!targetIsUnassigned && !groupField.property_key) {
      toast.error('状态字段未配置属性键，无法创建任务');
      return;
    }

    const nextTaskNumber = datasetRecords.reduce((max, record) => {
      const title = noteForRecord(record)?.title ?? '';
      const match = /^未命名任务\s+(\d+)$/.exec(title.trim());
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    const title = `未命名任务 ${nextTaskNumber}`;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(title);
      if (!isCurrentSession(sequence)) return;
      let note = created.entry;
      const noteKey = note.relativePath.replace(/\\/g, '/');
      if (targetOption) {
        const path = notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
        if (!path || !await setDocumentProperties(path, { [groupField.property_key!]: targetOption.label }, { [groupField.property_key!]: 'Select' })) {
          throw new Error('任务已创建，但无法设置状态');
        }
        note = { ...note, properties: { ...note.properties, [groupField.property_key!]: targetOption.label } };
      }
      const record: TableRecord = {
        id: `rec_${createUuidV7()}`,
        updated_at: new Date().toISOString(),
        note_path: noteKey,
      };
      const records = upsertTableRecord(document.dataset.records.include, record);
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      await save({
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } },
      }, true, sequence);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '新建任务失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [createNoteInNotebook, datasetRecords, document, editable, groupField, isCurrentSession, loadSequenceRef, noteField, noteForRecord, notebookPath, reportSaveFailure, resolvedNotebookId, save, saving, setNotes, setSaving]);
  const addExternalNotesToKanban = useCallback(async (
    draggedNotes: NotebookNoteDragResource[],
    targetGroupId: string,
    beforeRecordId: string | null,
  ) => {
    if (!editable || !document || !noteField || !notebookPath || !resolvedNotebookId
      || groupField?.type !== 'Select' || saving) return;
    const targetIsUnassigned = targetGroupId === KANBAN_UNASSIGNED_GROUP_ID;
    const targetOption = groupField.options?.find((option) => option.id === targetGroupId);
    if (!targetIsUnassigned && !targetOption) return;
    if (!targetIsUnassigned && !groupField.property_key) {
      toast.error('状态字段未配置属性键，无法加入任务');
      return;
    }
    const uniqueNotes = [...new Map(draggedNotes.map((note) => [canonicalPath(note.relativePath), note])).values()];
    const resolved = uniqueNotes.map((draggedNote) => {
      if (!isMarkdownNoteDragResource(draggedNote) || draggedNote.notebookId !== resolvedNotebookId) return null;
      const relativePath = canonicalPath(draggedNote.relativePath).replace(/^\/+/, '');
      const note = notes.find((item) => item.relativePath.replace(/\\/g, '/') === relativePath);
      if (!note || !noteInCollectionSource(relativePath, document.dataset.source, currentFilePath, notebookPath)) return null;
      return { note, relativePath };
    });
    if (!resolved.length || resolved.some((item) => !item)) {
      toast.warning(t('memo.fileTree.kanbanDropUnsupported'));
      return;
    }
    const sequence = loadSequenceRef.current;
    if (!isCurrentSession(sequence)) return;
    setSaving(true);
    try {
      for (const item of resolved) {
        if (!item || !isCurrentSession(sequence)) return;
        const path = joinNotebookMemoPath(notebookPath, item.relativePath);
        if (!path) throw new Error('无法确定笔记路径');
        if (groupField.property_key) {
          const saved = targetOption
            ? await setDocumentProperties(path, { [groupField.property_key]: targetOption.label }, { [groupField.property_key]: 'Select' })
            : !Object.prototype.hasOwnProperty.call(item.note.properties, groupField.property_key)
              || await removeDocumentProperty(path, groupField.property_key);
          if (!saved) throw new Error('笔记的分组属性未能保存');
        }
        if (!isCurrentSession(sequence)) return;
        setNotes((current) => current.map((note) => {
          if (note.relativePath.replace(/\\/g, '/') !== item.relativePath) return note;
          const properties = { ...note.properties };
          if (groupField.property_key) {
            if (targetOption) properties[groupField.property_key] = targetOption.label;
            else delete properties[groupField.property_key];
          }
          return { ...note, properties };
        }));
      }

      const linkedRecords: TableRecord[] = [];
      const now = new Date().toISOString();
      for (const item of resolved) {
        if (!item) continue;
        const existing = datasetRecords.find((record) => record.note_path.replace(/\\/g, '/') === item.relativePath);
        const linkedRecord = existing
          ? { ...existing, updated_at: now, note_path: item.relativePath }
          : { id: `rec_${createUuidV7()}`, updated_at: now, note_path: item.relativePath };
        linkedRecords.push(linkedRecord);
      }
      const linkedIds = new Set(linkedRecords.map((record) => record.id));
      const recordsWithoutDropped = document.dataset.records.include.filter((record) => !linkedIds.has(record.id));
      let insertAt = beforeRecordId
        ? recordsWithoutDropped.findIndex((record) => record.id === beforeRecordId)
        : -1;
      if (insertAt < 0) {
        const targetRecords = (targetGroupId === KANBAN_UNASSIGNED_GROUP_ID
          ? kanbanUnassignedRecords
          : kanbanGroups.get(targetGroupId) ?? []).filter((record) => !linkedIds.has(record.id));
        const lastTargetRecord = targetRecords[targetRecords.length - 1];
        const lastTargetIndex = lastTargetRecord
          ? recordsWithoutDropped.findIndex((record) => record.id === lastTargetRecord.id)
          : -1;
        insertAt = lastTargetIndex >= 0 ? lastTargetIndex + 1 : recordsWithoutDropped.length;
      }
      const records = [
        ...recordsWithoutDropped.slice(0, insertAt),
        ...linkedRecords,
        ...recordsWithoutDropped.slice(insertAt),
      ];
      const next: MultidimensionalTableDocument = {
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } },
      };
      if (!await save(next, true, sequence) || !isCurrentSession(sequence)) {
        toast.error(t('multidimensionalTable.kanbanDropFailed'));
      }
    } catch (error) {
      if (isCurrentSession(sequence)) toast.error(error instanceof Error ? error.message : t('multidimensionalTable.kanbanDropFailed'));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [currentFilePath, datasetRecords, document, editable, groupField, isCurrentSession, kanbanGroups, kanbanUnassignedRecords, loadSequenceRef, noteField, notes, notebookPath, resolvedNotebookId, save, saving, setNotes, setSaving, t]);
  const dropKanbanRecord = useCallback(async (recordId: string, targetGroupId: string, beforeRecordId: string | null) => {
    if (!editable || !document || groupField?.type !== 'Select' || saving) return;
    const record = visibleRecords.find((item) => item.id === recordId);
    const targetIsUnassigned = targetGroupId === KANBAN_UNASSIGNED_GROUP_ID;
    const targetOption = groupField.options?.find((option) => option.id === targetGroupId);
    if (!record || (!targetIsUnassigned && !targetOption)) return;
    const isPersistedRecord = document.dataset.records.include.some((item) => item.id === recordId);
    const note = noteForRecord(record);
    const sourceGroupId = notePropertyEditorValue(note, groupField);
    const sourceGroupKey = groupField.options?.some((option) => option.id === sourceGroupId)
      ? String(sourceGroupId)
      : KANBAN_UNASSIGNED_GROUP_ID;
    const propertyKey = groupField.property_key;
    const recordNoteKey = record.note_path.replace(/\\/g, '/');
    const path = notebookPath && recordNoteKey ? joinNotebookMemoPath(notebookPath, record.note_path) : null;
    const updateNoteGroupValue = async () => {
      if (!propertyKey || !path) return false;
      return targetIsUnassigned
        ? removeDocumentProperty(path, propertyKey)
        : setDocumentProperties(path, { [propertyKey]: targetOption!.label }, { [propertyKey]: 'Select' });
    };
    const updateLocalNoteGroupValue = (noteKey: string) => {
      setNotes((current) => current.map((item) => {
        if (item.relativePath.replace(/\\/g, '/') !== noteKey) return item;
        const properties = { ...item.properties };
        if (targetIsUnassigned) delete properties[propertyKey!];
        else properties[propertyKey!] = targetOption!.label;
        return { ...item, properties };
      }));
    };
    if (!isPersistedRecord) {
      if (sourceGroupKey === targetGroupId) return;
      if (!propertyKey || !path) return;
      const sequence = loadSequenceRef.current;
      setSaving(true);
      try {
        if (!await updateNoteGroupValue()) throw new Error('笔记的单选属性未能保存');
        if (!isCurrentSession(sequence)) return;
        updateLocalNoteGroupValue(recordNoteKey);
      } catch (error) {
        reportSaveFailure(sequence);
        if (isCurrentSession(sequence)) toast.error(error instanceof Error ? error.message : '移动笔记失败');
      } finally {
        if (isCurrentSession(sequence)) setSaving(false);
      }
      return;
    }

    const targetGroup = (targetIsUnassigned ? kanbanUnassignedRecords : kanbanGroups.get(targetGroupId) ?? []).filter((item) => item.id !== recordId);
    const recordsWithoutDragged = document.dataset.records.include.filter((item) => item.id !== recordId);
    let insertAt = beforeRecordId
      ? recordsWithoutDragged.findIndex((item) => item.id === beforeRecordId)
      : -1;
    if (insertAt < 0) {
      const lastTargetRecord = targetGroup[targetGroup.length - 1];
      const lastTargetIndex = lastTargetRecord
        ? recordsWithoutDragged.findIndex((item) => item.id === lastTargetRecord.id)
        : -1;
      insertAt = lastTargetIndex >= 0 ? lastTargetIndex + 1 : recordsWithoutDragged.length;
    }
    const records = [...recordsWithoutDragged.slice(0, insertAt), record, ...recordsWithoutDragged.slice(insertAt)];
    const orderChanged = records.some((item, index) => item.id !== document.dataset.records.include[index]?.id);
    if (!orderChanged && sourceGroupKey === targetGroupId) return;

    if (sourceGroupKey === targetGroupId) {
      await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } });
      return;
    }

    if (!propertyKey || !path) {
      toast.error('无法定位笔记文件，无法更新分组属性');
      return;
    }
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      if (!await updateNoteGroupValue()) {
        throw new Error('笔记的单选属性未能保存');
      }
      if (!isCurrentSession(sequence)) return;
      updateLocalNoteGroupValue(recordNoteKey);
      if (orderChanged) await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } }, true, sequence);
    } catch (error) {
      reportSaveFailure(sequence);
      if (isCurrentSession(sequence)) toast.error(error instanceof Error ? error.message : '移动笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [document, editable, groupField, isCurrentSession, kanbanGroups, kanbanUnassignedRecords, loadSequenceRef, noteForRecord, notebookPath, save, saving, setNotes, setSaving, visibleRecords, reportSaveFailure]);
  const calendarGroups = useMemo(() => document && calendarDateFieldId
    ? groupRecordsByValue(secondaryViewRecords, (record) => {
      if (calendarDateMetadata) {
        const note = noteForRecord(record);
        return calendarDateKey(calendarDateTimeForTimestamp(note?.[calendarDateMetadata.timestamp]));
      }
      return calendarField ? calendarDateKey(notePropertyEditorValue(noteForRecord(record), calendarField)) : null;
    })
    : new Map<string, TableRecord[]>(), [calendarDateFieldId, calendarDateMetadata, calendarField, document, noteForRecord, secondaryViewRecords]);
  if (loadError) {
    if (reportPresentation) return null;
    return <div className={`flex h-full min-h-0 flex-col items-center justify-center gap-3 p-8 text-center ${embeddedInEditor ? 'rounded-lg border border-[var(--border)] bg-[var(--editor-block-bg)]' : ''}`}>
      <Table2 className="h-8 w-8 text-[var(--muted-foreground)] opacity-70" aria-hidden="true" />
      <div className="text-sm">无法显示多维表格</div>
      {loadError !== '不支持的多维表格文件格式' && <div className="max-w-lg text-xs text-[var(--muted-foreground)]">{loadError}</div>}
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => void load()}>重新加载</Button>
        {embeddedInEditor
          ? onRemoveReference && <Button type="button" variant="outline" size="sm" className="rounded-lg" disabled={!editable} onClick={onRemoveReference}>移除</Button>
          : document?.collection.placement !== 'folder' && <Button type="button" variant="outline" size="sm" className="rounded-lg text-[var(--destructive)]" disabled={!editable} onClick={() => window.dispatchEvent(new CustomEvent('flowix:request-delete-external-file', { detail: { filePath: currentFilePath, notebookPath } }))}>删除多维表格</Button>}
      </div>
    </div>;
  }
  if (!document) return <MultidimensionalTableLoadingSkeleton showSpinner={!reportPresentation} />;
  if (expectedCollectionId && document.collection.id !== expectedCollectionId) {
    if (reportPresentation) return null;
    return <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-6 text-center">
      <Table2 className="h-7 w-7 text-[var(--muted-foreground)]" aria-hidden="true" />
      <div className="text-sm font-medium">引用的表格身份已变化</div>
      <div className="max-w-lg text-xs text-[var(--muted-foreground)]">当前路径对应的多维表格与引用节点保存的 table.id 不一致，请重新选择表格。</div>
    </div>;
  }

  const titleField = document.dataset.schema.fields.find((field) => field.id === document.dataset.schema.primary_field_id);
  const tableViewFields = activeView?.layout === 'table'
    ? document.dataset.schema.fields.filter((field) => field.id === document.dataset.schema.primary_field_id
      || (activeView.config.visible_fields as string[]).includes(field.id))
    : document.dataset.schema.fields;
  const visibleBuiltinFields = activeView?.layout === 'table'
    ? BUILTIN_TABLE_FIELDS.filter((field) => (activeView.config.visible_fields as string[]).includes(field.id))
    : [];
  const calendarTitleFieldId = activeView?.layout === 'calendar' ? activeView.config.title_field as string : document.dataset.schema.primary_field_id;
  const galleryFields = activeView?.layout === 'gallery'
    ? document.dataset.schema.fields.filter((field) => field.type !== 'primary'
      && (activeView.config.visible_fields as string[]).includes(field.id))
    : [];
  const statusField = findKanbanStatusField(document);
  const viewFieldChoices = pendingViewType === 'calendar'
    ? document.dataset.schema.fields.filter((field) => field.type === 'Date'
      && field.id !== NOTE_CALENDAR_DATE_FIELD_ID
      && canonicalizePropertyKey(field.property_key ?? '').toLocaleLowerCase() !== 'calendar_date')
    : pendingViewType === 'kanban'
      ? [
        ...(statusField?.type === 'Select' ? [statusField] : []),
        ...document.dataset.schema.fields.filter((field) => field.type === 'Select' && field.id !== statusField?.id),
      ]
      : [];
  const showAssociateNoteButton = canCreateRecords || showAssociateNoteAction;
  const tableDisplayName = collectionDisplayName(currentFilePath, document.collection.placement);
  const cellSaveStatuses = [...cellStatusesByRecord.values()].flatMap((statuses) => [...statuses.values()]);
  const isSaving = saving || renamingTable || cellSaveStatuses.some((status) => status.saving);
  const saveStatusText = saveFailed || cellSaveStatuses.some((status) => status.error) ? '未保存' : '已保存';
  const datasetTableViews = document.views.items.filter((view) => view.layout === 'table');
  const datasetFieldChecked = (fieldId: string) => datasetTableViews.length > 0
    && datasetTableViews.every((view) => (view.config.visible_fields as string[]).includes(fieldId));
  const datasetFieldMixed = (fieldId: string) => !datasetFieldChecked(fieldId)
    && datasetTableViews.some((view) => (view.config.visible_fields as string[]).includes(fieldId));
  const datasetFieldVisibilityButton = (fieldId: string, label: string, className = '') => {
    const checked = datasetFieldChecked(fieldId);
    const mixed = datasetFieldMixed(fieldId);
    const action = checked ? '隐藏' : '展示';
    const ariaLabel = mixed ? `部分表格视图中展示，点击后全部展示${label}` : `${action}${label}`;
    return <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      aria-pressed={checked ? true : mixed ? 'mixed' : false}
      disabled={!editable || saving || datasetTableViews.length === 0}
      onClick={() => void toggleTableFieldVisibility(fieldId)}
      className={`${className} inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40`}
    >{checked || mixed
      ? <EyeIcon size={16} weight="bold" className="text-[var(--brand)]" aria-hidden="true" />
      : <EyeSlashIcon size={16} weight="bold" className="text-[var(--muted-foreground)]" aria-hidden="true" />}</button>;
  };
  const presetAlreadyAdded = (preset: PropertyPreset) => {
    const propertyKey = canonicalizePropertyKey(preset.key).toLocaleLowerCase();
    if (document.dataset.schema.fields.some((field) => field.property_key
      && canonicalizePropertyKey(field.property_key).toLocaleLowerCase() === propertyKey)) return true;
    const builtin = BUILTIN_TABLE_FIELDS.find((field) => builtinPresetTableField(field.id)?.property_key === propertyKey);
    return Boolean(builtin && document.dataset.schema.preset_fields.includes(builtin.id));
  };
  const isSystemPresetField = (field: TableField) => tablePresets.system.some((preset) => preset.id === field.id);
  const fixedFolderPath = document.collection.placement === 'folder'
    ? resolveTableNoteParentRelativePath(currentFilePath, notebookPath) ?? ''
    : undefined;
  const storedAutoCollectConfig = tableAutoCollectConfig(document);
  const datasetMenuProps = {
    defaultFieldId: document.dataset.schema.primary_field_id,
    fields: document.dataset.schema.fields.map((item) => ({ id: item.id, label: fieldLabel(item, propertyFields, t) })),
    config: fixedFolderPath !== undefined
      ? { condition: { ...(storedAutoCollectConfig?.condition ?? {}), match: storedAutoCollectConfig?.condition.match ?? 'all', path: fixedFolderPath } }
      : storedAutoCollectConfig,
    notebookPath,
    fixedFolderPath,
    saving: saving || !editable,
    t,
    onSave: (condition: TableAutoCollectCondition) => saveAutoCollectCondition(document.dataset.schema.fields[0], condition),
    onSavePath: saveAutoCollectPath,
  };
  const openNewFieldEditor = (button: HTMLButtonElement, source: 'dataset' | 'table') => {
    setNewFieldType('Text');
    setNewFieldTypeMenuOpen(false);
    setNewFieldPresetMenuOpen(false);
    setDatasetPresetMenuOpen(false);
    setNewFieldPropertyKey('');
    setNewFieldOptions([]);
    // The dataset submenu grows upward; the table header editor grows downward.
    setNewFieldAnchor({ rect: button.getBoundingClientRect(), align: source === 'dataset' ? 'end' : 'start' });
    setNewFieldOpen(true);
  };
  const closeDatasetSubmenus = () => {
    setDatasetFilterOpen(false);
    setFieldPanelHeaderId(null);
    setDatasetPresetMenuOpen(false);
    setNewFieldTypeMenuOpen(false);
    setNewFieldPresetMenuOpen(false);
    if (newFieldOpen) {
      // Closing the parent menu should discard an unfinished new-field draft.
      skipNewFieldSaveOnCloseRef.current = true;
      setNewFieldOpen(false);
      setNewFieldAnchor(null);
    }
  };
  const openDatasetFieldManager = () => {
    setHeaderMenuFieldId(null);
    setFieldPanelHeaderId(null);
    setDatasetFilterOpen(false);
    setMatchingOpen(true);
  };
  const datasetFieldManagerMenu = () => <button
    type="button"
    onClick={openDatasetFieldManager}
    className="flex h-8 w-full items-center justify-between rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
  >
    <span>字段管理</span>
    <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
  </button>;
  const fieldOrder = document.dataset.schema.field_order;
  const saveFieldOrder = async (ids: string[]) => {
    if (!editable || saving) return;
    await save({ ...document, collection: reviseCollection(document.collection),
      dataset: { ...document.dataset, schema: { ...document.dataset.schema, field_order: ids } } });
  };
  const datasetAction = <div className="flex shrink-0 items-center gap-2">
    <span role="status" aria-label={isSaving ? '保存中' : saveStatusText} className="inline-flex items-center whitespace-nowrap text-xs text-[var(--muted-foreground)]">
      {isSaving ? <LoaderCircle className="h-3.5 w-3.5 flowix-spin" aria-hidden="true" /> : saveStatusText}
    </span>
    <TableDatasetMenu
      {...datasetMenuProps}
      open={matchingOpen}
      onOpenChange={(open) => {
        setMatchingOpen(open);
        if (!open) closeDatasetSubmenus();
      }}
      filterOpen={datasetFilterOpen}
      onFilterOpenChange={setDatasetFilterOpen}
      ignoreOutside={fieldPanelHeaderId !== null || newFieldOpen || datasetPresetMenuOpen}
      children={<div className="w-full min-w-0 max-w-full space-y-0.5 overflow-x-hidden">
        <p className="agent-thread-card__codex-settings-title truncate whitespace-nowrap px-2 py-1.5">展示字段</p>
        <TableFieldList ids={fieldOrder} primaryId={document.dataset.schema.primary_field_id} activeId={fieldPanelHeaderId} disabled={!editable || saving}
          label={(id) => {
            const field = document.dataset.schema.fields.find((item) => item.id === id);
            return field ? fieldLabel(field, propertyFields, t) : BUILTIN_TABLE_FIELDS.find((item) => item.id === id)?.label ?? id;
          }} onReorder={saveFieldOrder} renderField={(id) => {
            const field = document.dataset.schema.fields.find((item) => item.id === id);
            if (field) return <div key={field.id} className="flex h-full w-full min-w-0 items-center gap-2 overflow-hidden pl-[3px] pr-1.5">
            <div className="min-w-0 flex-1 overflow-hidden">
              <TableFieldHeader
                field={field}
                label={fieldLabel(field, propertyFields, t)}
                systemPreset={isSystemPresetField(field)}
                compact
                hideTypeIcon
                saving={saving || !editable}
                open={fieldPanelHeaderId === field.id}
                pendingOption={field.id === groupField?.id ? pendingKanbanOption : null}
                focusOptionId={field.id === groupField?.id ? pendingKanbanOption?.id : null}
                onOptionFocusHandled={(optionId) => setPendingKanbanOption((current) => current?.id === optionId ? null : current)}
                typeChoices={FIELD_TYPE_CHOICES}
                customPresets={tablePresets.custom}
                systemPresets={tablePresets.system}
                isPresetAdded={presetAlreadyAdded}
                onRemovePreset={removePreset}
                t={t}
                typeLabel={(type) => fieldTypeLabel(type, t)}
                typeIconKind={fieldTypeIconKind}
                onOpenChange={(open) => setFieldPanelHeaderId(open ? field.id : null)}
                onSaveEdits={queueHeaderFieldEdits}
                onChangeType={changeFieldType}
                onApplyPreset={applyFieldPreset}
                onHide={isSystemPresetField(field) ? () => hideTableField(field.id) : undefined}
                onDelete={isSystemPresetField(field) ? undefined : deleteField}
                onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
              />
            </div>
                {field.type !== 'primary' && datasetFieldVisibilityButton(field.id, fieldLabel(field, propertyFields, t), 'ml-auto')}
          </div>;
            const builtin = BUILTIN_TABLE_FIELDS.find((item) => item.id === id);
            if (!builtin) return null;
            const builtinField: TableField = builtinPresetTableField(builtin.id) ?? {
              id: builtin.id,
              type: builtin.iconKind === 'date' ? 'Date' : builtin.iconKind === 'number' ? 'Number' : 'Text',
              property_key: builtin.propertyKey ?? builtin.id,
            };
            return <div key={builtin.id} className="flex h-full w-full min-w-0 items-center gap-2 pl-[3px] pr-1.5 text-sm">
            <div className="min-w-0 flex-1 overflow-hidden">
              <TableFieldHeader
                field={builtinField}
                label={builtinTableFieldLabel(builtin, t)}
                trailingLabel={builtinPresetTableField(builtin.id) ? '预设' : '只读'}
                compact
                hideTypeIcon
                readOnly
                saving={saving || !editable}
                open={fieldPanelHeaderId === builtin.id}
                typeChoices={FIELD_TYPE_CHOICES}
                customPresets={tablePresets.custom}
                systemPresets={tablePresets.system}
                t={t}
                typeLabel={(type) => fieldTypeLabel(type, t)}
                typeIconKind={fieldTypeIconKind}
                onOpenChange={(open) => setFieldPanelHeaderId(open ? builtin.id : null)}
                onSaveEdits={queueHeaderFieldEdits}
                onChangeType={changeFieldType}
                onApplyPreset={applyFieldPreset}
                onDelete={deleteBuiltinField}
                onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
              />
            </div>
            {datasetFieldVisibilityButton(builtin.id, builtinTableFieldLabel(builtin, t))}
          </div>;
          }} />
        {canCreateFields && <>
          <div role="separator" aria-hidden="true" className="mx-2 h-px bg-[var(--border)]" />
          <TablePresetMenu
            triggerLabel="选择属性"
            triggerIcon={<MousePointerClick className="h-4 w-4" aria-hidden="true" />}
            triggerPadding="px-1.5"
            customGroupLabel={t('preferences.documentProperties.group.mine')}
            customPresets={tablePresets.custom}
            systemPresets={tablePresets.system}
            disabled={!editable || saving}
            open={datasetPresetMenuOpen}
            onOpenChange={setDatasetPresetMenuOpen}
            t={t}
            onSelect={(preset) => { setDatasetPresetMenuOpen(false); addField(preset); }}
            onRemove={removePreset}
            isAdded={presetAlreadyAdded}
            onManage={() => {
              setDatasetPresetMenuOpen(false);
              setMatchingOpen(false);
              void windows.openPreferences('noteSettings');
            }}
          />
          <button type="button" data-state={newFieldOpen ? 'open' : 'closed'} disabled={!editable || saving} className="flex h-8 w-full items-center gap-1.5 rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)] data-[state=open]:bg-[var(--hover-bg)] disabled:opacity-50" onClick={(event) => {
            openNewFieldEditor(event.currentTarget, 'dataset');
          }}><Plus className="h-4 w-4" />新增属性</button>
        </>}
      </div>}
    />
  </div>;
  const beginEditTableTitle = () => {
    if (!editable || saving || renamingTable || !notebookPath) return;
    setTableNameDraft(tableDisplayName);
    setEditingTableName(true);
  };
  const tableColumnCount = tableViewFields.length + visibleBuiltinFields.length + 1;
  const tableFieldWidths = tableViewFields.map((field) => ({
    fieldId: field.id,
    width: TABLE_FIELD_WIDTHS[field.type],
  }));
  tableFieldWidths.push(...visibleBuiltinFields.map((field) => ({
    fieldId: field.id,
    width: TABLE_FIELD_WIDTHS[field.type],
  })));
  for (const column of tableFieldWidths) {
    if (autoColumnWidths[column.fieldId] !== undefined) column.width = autoColumnWidths[column.fieldId];
  }
  const orderedTableWidths = sortFields(tableFieldWidths, (field) => field.fieldId, fieldOrder);
  const tableMinWidth = tableFieldWidths.reduce((total, { width }) => total + width, TABLE_ACTION_COLUMN_MIN_WIDTH);
  return <div className="multidimensional-table__surface flex h-full min-h-0 flex-col bg-transparent" aria-readonly={!editable}>
    <DeletePresetDialog
      preset={pendingDeleteTarget?.preset ?? null}
      tableCount={pendingDeleteTableCount}
      busy={deletingFieldBusy}
      onCancel={() => { if (!deletingFieldBusy) setPendingDeleteTarget(null); }}
      onConfirm={() => { void confirmDeleteField(); }}
    />
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <nav data-title-visible={showTableTitle} className="multidimensional-table__view-nav sticky top-0 z-10 flex min-w-0 shrink-0 items-center gap-1 px-4 py-1" aria-label="表格视图">
        <div
          className="multidimensional-table__view-title flex min-w-0 max-w-[40%] shrink-0 -translate-x-[2px] items-center gap-1.5"
          title={tableDisplayName}
        >
            <NotebookTreeResourceIcon path={currentFilePath} collectionType="table" className="h-5 w-5 shrink-0" />
            {editingTableName ? <input
              ref={tableNameInputRef}
              aria-label="多维表格名称"
              value={tableNameDraft}
              disabled={renamingTable || saving}
              onChange={(event) => setTableNameDraft(event.currentTarget.value)}
              onBlur={(event) => void commitTableTitle(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditingTableName(false);
                  setTableNameDraft(tableDisplayName);
                }
              }}
              className="box-border h-[22px] min-w-[2em] max-w-full flex-[0_1_auto] rounded px-0.5 py-1 [field-sizing:content] border-0 bg-[var(--muted)] text-sm font-medium leading-none text-[var(--foreground)] outline-none"
            /> : <button
              type="button"
              onDoubleClick={(event) => { event.preventDefault(); captureTableTitleCaret(event.currentTarget, event.clientX, event.clientY); beginEditTableTitle(); }}
              aria-label={`重命名多维表格：${tableDisplayName}`}
              title={`双击重命名：${tableDisplayName}`}
              disabled={!editable || saving || renamingTable || !notebookPath}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'F2') {
                  event.preventDefault();
                  beginEditTableTitle();
                }
              }}
              className="min-w-[2em] flex-[0_1_auto] truncate rounded px-0.5 py-1 text-left text-sm font-medium leading-none text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:opacity-100"
            >
              {tableDisplayName}
            </button>}
            {renamingTable && <span role="status" aria-label={t('memo.fileTree.renaming')} className="inline-flex shrink-0 items-center text-[var(--muted-foreground)]">
              <LoaderCircle className="h-3.5 w-3.5 flowix-spin" aria-hidden="true" />
            </span>}
        </div>
        <span role="separator" aria-orientation="vertical" className="multidimensional-table__view-nav-separator" />
        <div
          className="multidimensional-table__view-tabs-scroller relative h-7 min-w-0 flex-1 overflow-hidden"
          data-overflow-left={viewTabsOverflow.left ? 'true' : 'false'}
          data-overflow-right={viewTabsOverflow.right ? 'true' : 'false'}
        >
          <div ref={viewTabsScrollerRef} className="multidimensional-table__view-tabs-scroll-area scrollbar-hide flex h-full min-w-0 items-center overflow-x-auto">
          <div className="flex w-max min-w-max shrink-0 items-center gap-1.5 pr-2">
          {document.views.items.map((view) => (
            <ContextMenu key={view.id}>
              {editingViewId === view.id ? (
                <div className="relative inline-flex shrink-0">
                  <input
                    ref={editingViewInputRef}
                    aria-label={t('multidimensionalTable.view.name')}
                    value={editingViewName}
                    disabled={!editable || saving}
                    onChange={(event) => setEditingViewName(event.currentTarget.value)}
                    onBlur={(event) => void renameView(view, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    style={{ width: `${editingViewWidth}px` }}
                    className={`h-7 shrink-0 whitespace-nowrap rounded-md border border-[var(--primary)] bg-[var(--background)] px-2.5 text-sm text-[var(--foreground)] outline-none ${view.id === activeView?.id ? 'font-medium' : ''}`}
                  />
                  <span ref={editingViewMeasureRef} aria-hidden="true" className={`pointer-events-none invisible absolute left-0 top-0 -z-10 whitespace-pre px-2.5 text-sm ${view.id === activeView?.id ? 'font-medium' : ''}`}>
                    {editingViewName || ' '}
                  </span>
                </div>
              ) : (
                <ContextMenuTrigger asChild>
                  <button type="button" disabled={saving} onClick={() => { void selectView(view.id); }} onDoubleClick={() => beginRenameView(view)} className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-sm disabled:opacity-50 ${view.id === activeView?.id ? 'bg-[var(--muted)] font-medium text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]/60'}`}>
                    {view.name}
                  </button>
                </ContextMenuTrigger>
              )}
              <ContextMenuContent className="w-[160px] space-y-0.5 rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                <ContextMenuItem disabled={!editable || saving} onSelect={() => beginRenameView(view)}>{t('multidimensionalTable.view.rename')}</ContextMenuItem>
                <ContextMenuItem disabled={!editable || !canDeleteViews || saving || document.views.items.length <= 1} className="text-[var(--destructive)]" onSelect={() => requestDeleteView(view)}>{t('multidimensionalTable.view.delete')}</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
          <div className="shrink-0">
            <Popover open={viewAddOpen} anchorRect={viewFieldPickerAnchorRect} onOpenChange={(open) => {
              setViewAddOpen(open);
              if (!open) {
                if (managingViewId) {
                  const viewBeingRenamed = document?.views.items.find((view) => view.id === managingViewId);
                  if (viewBeingRenamed) {
                    manageRenameCancelledRef.current = true;
                    void renameView(viewBeingRenamed, managingViewName);
                  }
                } else {
                  manageRenameCancelledRef.current = false;
                }
                setViewAddStep('kind');
                setPendingViewType(null);
                setConfiguringViewId(null);
                setViewFieldPickerAnchorRect(null);
                setManagingViewId(null);
                setManagingViewName('');
              }
            }}>
              <PopoverTrigger asChild>
                <button type="button" disabled={!editable || saving} aria-label="更多视图" title="更多视图" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40">
                  <DotsThreeIcon size={16} weight="bold" aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent key={viewAddStep} align="start" side="bottom" sideOffset={5} fitViewport className={`${viewAddStep === 'manage' ? 'w-[220px]' : 'w-[190px]'} rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]`}>
                {viewAddStep === 'kind' ? <div className="space-y-0.5">
                  <div className="px-2 py-1 text-xs text-[var(--muted-foreground)]">添加笔记视图</div>
                  <button type="button" disabled={saving} onClick={() => void createDataTableView()} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">表格</button>
                  <button type="button" disabled={saving} onClick={() => { setConfiguringViewId(null); setPendingViewType('calendar'); setViewFieldPickerAnchorRect(null); setViewAddStep('field'); }} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    日历<ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
                  </button>
                  <button type="button" disabled={saving} onClick={() => { setConfiguringViewId(null); setPendingViewType('kanban'); setViewFieldPickerAnchorRect(null); setViewAddStep('field'); }} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    看板<ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
                  </button>
                  <button type="button" disabled={saving} onClick={() => void createGalleryView()} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    画廊
                  </button>
                  {document.collection.placement === 'folder' && <>
                    <button type="button" disabled={saving || !notebookPath || !notebookId} onClick={() => {
                      setViewAddOpen(false);
                      setFolderMediaSwitchConfirmOpen(true);
                    }} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                      <span>媒体库</span>
                      <span className="text-xs text-[var(--muted-foreground)]">图/视频</span>
                    </button>
                  </>}
                  <div role="separator" aria-hidden="true" className="mx-2 my-1 h-px bg-[var(--border)]" />
                  <button type="button" disabled={saving} onClick={() => setViewAddStep('manage')} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    <span>管理视图</span>
                    <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={showTableTitle ? '隐藏标题' : '显示标题'} aria-pressed={showTableTitle} onClick={toggleTableTitleVisibility} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)]">
                    <span>显示标题</span>
                    {showTableTitle
                      ? <EyeIcon size={16} weight="bold" className="text-[var(--brand)]" aria-hidden="true" />
                      : <EyeSlashIcon size={16} weight="bold" className="text-[var(--muted-foreground)]" aria-hidden="true" />}
                  </button>
                </div> : viewAddStep === 'manage' ? <div className="space-y-0.5">
                  <div className="flex min-w-0 items-center gap-0.5 px-1.5 py-[0.35rem]">
                    <button type="button" aria-label="返回视图类型" className="inline-flex min-h-4 shrink-0 items-center gap-0.5 rounded px-0 text-xs leading-[1.2] text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none" onClick={() => setViewAddStep('kind')}>
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="min-w-0 truncate text-xs leading-[1.2] text-[var(--muted-foreground)]">管理视图</span>
                    </button>
                  </div>
                  <div className="max-h-[min(60vh,420px)] space-y-0.5 overflow-y-auto">
                    {document.views.items.map((view) => <div key={view.id} className="flex h-8 w-full min-w-0 items-center gap-1 rounded-lg px-1">
                      {managingViewId === view.id ? <input
                        ref={manageViewRenameInputRef}
                        aria-label={`重命名视图：${view.name}`}
                        value={managingViewName}
                        disabled={!editable || saving}
                        onChange={(event) => setManagingViewName(event.currentTarget.value)}
                        onBlur={(event) => {
                          if (manageRenameCancelledRef.current) {
                            manageRenameCancelledRef.current = false;
                            return;
                          }
                          if (managingViewId === view.id) finishManageViewRename(view, event.currentTarget.value);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.currentTarget.blur();
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            manageRenameCancelledRef.current = true;
                            setManagingViewId(null);
                          }
                        }}
                        className="h-7 min-w-0 flex-1 rounded-md border border-[var(--primary)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none"
                      /> : <span className="min-w-0 flex-1 truncate px-1.5 text-sm text-[var(--foreground)]">{view.name}</span>}
                      {managingViewId === view.id ? <button
                        type="button"
                        disabled={!editable || saving}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => finishManageViewRename(view, managingViewName)}
                        className="inline-flex h-7 w-11 shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--background)] text-xs text-[var(--primary)] hover:bg-[var(--muted)] disabled:opacity-40"
                      >保存</button> : <button type="button" aria-label={`重命名视图：${view.name}`} title="重命名" disabled={!editable || saving || managingViewId !== null} onClick={() => beginManageViewRename(view)} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40">
                        <PencilSimpleIcon size={15} aria-hidden="true" />
                      </button>}
                      {managingViewId !== view.id && <button type="button" aria-label={`删除视图：${view.name}`} title={canDeleteViews ? '删除' : '此处不可删除视图'} disabled={!editable || !canDeleteViews || saving || document.views.items.length <= 1 || managingViewId !== null} onClick={() => requestDeleteView(view)} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)] disabled:opacity-40">
                        <TrashIcon size={15} aria-hidden="true" />
                      </button>}
                    </div>)}
                  </div>
                </div> : <div className="space-y-0.5">
                  <div className="flex min-w-0 items-center gap-0.5 px-1.5 py-[0.35rem]">
                    {configuringViewId ? <span className="min-w-0 truncate px-0.5 text-xs leading-[1.2] text-[var(--muted-foreground)]">{pendingViewType === 'calendar' ? '选择日期字段' : '选择单选字段'}</span> : <button type="button" aria-label="返回视图类型" className="inline-flex min-h-4 shrink-0 items-center gap-0.5 rounded px-0 text-xs leading-[1.2] text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none" onClick={() => { setViewAddStep('kind'); setPendingViewType(null); setViewFieldPickerAnchorRect(null); }}>
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="min-w-0 truncate text-xs leading-[1.2] text-[var(--muted-foreground)]">{pendingViewType === 'calendar' ? '选择日期字段' : '选择单选字段'}</span>
                    </button>}
                  </div>
                  {pendingViewType === 'kanban' && !statusField && <button type="button" disabled={saving} title={configuringViewId ? '创建状态字段并设置为当前看板分组' : '创建状态字段并建立看板视图'} onClick={() => void chooseKanbanStatusField()} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    状态
                  </button>}
                  {pendingViewType === 'kanban' && statusField && statusField.type !== 'Select' && <p className="px-2 py-2 text-xs leading-5 text-[var(--muted-foreground)]">状态字段不是单选类型，请先修改字段类型或选择其他单选属性</p>}
                  {viewFieldChoices.map((field) => <button type="button" key={field.id} disabled={saving} onClick={() => void (field.property_key === 'status' && !configuringViewId ? createKanbanViewForStatus() : selectViewField(field))} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    {fieldLabel(field, propertyFields, t)}
                  </button>)}
                  {pendingViewType === 'kanban' && viewFieldChoices.length === 0 && !statusField && <p className="px-2 py-2 text-xs leading-5 text-[var(--muted-foreground)]">可添加单选属性，作为看板分组</p>}
                  {pendingViewType === 'calendar' && <button type="button" disabled={saving} onClick={() => void selectViewField(NOTE_CALENDAR_DATE_FIELD_ID)} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    日期
                  </button>}
                  {pendingViewType === 'calendar' && NOTE_CALENDAR_DATE_FIELDS.map((field) => <button type="button" key={field.id} disabled={saving} onClick={() => void selectViewField(field.id)} className="flex h-8 w-full items-center gap-1 rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    <span>{field.label}</span>
                    <span title="创建时间和更新时间由系统维护，不能通过拖动修改" className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--muted)] px-1 py-px text-xs font-normal text-[var(--muted-foreground)]">只读</span>
                  </button>)}
                  <div role="separator" aria-hidden="true" className="mx-2 my-1 h-px bg-[var(--border)]" />
                  <button type="button" disabled={saving} onClick={() => {
                    setViewAddOpen(false);
                    setViewAddStep('kind');
                    setPendingViewType(null);
                    setConfiguringViewId(null);
                    setViewFieldPickerAnchorRect(null);
                    openDatasetFieldManager();
                  }} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    <span>字段管理</span>
                    <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
                  </button>
                </div>}
              </PopoverContent>
            </Popover>
          </div>
        </div>
        </div>
        </div>
        {!embeddedInEditor && datasetAction}
        {trailingActions ? trailingActions(datasetAction) : embeddedInEditor ? datasetAction : null}
      </nav>
      <OverlayScrollbar scrollerRef={recordsScrollerRef} horizontalScrollbar={activeView?.layout === 'table' || activeView?.layout === 'kanban'} className="multidimensional-table__scrollbar--bottom-clearance min-h-0 flex-1" scrollerClassName="min-h-0 flex h-full flex-col" onScroll={() => {
        window.dispatchEvent(new Event('flowix:multidimensional-table-scroll'));
        setHeaderMenuFieldId(null);
        setNewFieldOpen(false);
        setNewFieldAnchor(null);
        setNewFieldTypeMenuOpen(false);
        setNewFieldPresetMenuOpen(false);
        setDatasetPresetMenuOpen(false);
        setNotePickerOpen(false);
        setNotePickerAnchorRect(null);
        setNotePickerRecordId(null);
        setNotePickerCalendarDate(null);
        closeCalendarAddPopover();
      }}>
      {activeView?.layout === 'table' && <div ref={tableDropAreaRef} className={`relative min-w-0 w-full ${embeddedInEditor ? 'flex-1' : 'shrink-0'} pr-4 ${embeddedInEditor ? '' : 'pl-4'}`}>
        <table ref={tableElementRef} className="multidimensional-table table-fixed border-collapse text-sm" style={{ width: '100%', minWidth: tableMinWidth }}>
          <colgroup>
            {orderedTableWidths.map(({ fieldId, width }) => <col key={fieldId} style={{ width }} />)}
            {/* The unsized action column absorbs remaining space; tableMinWidth reserves the action column’s minimum width. */}
            <col />
          </colgroup>
          <thead className="sticky top-0 z-[1] bg-[var(--document-bg)] text-left text-sm text-[var(--muted-foreground)]">
            <tr>{sortFields([...tableViewFields.map((field) => <th key={field.id} aria-sort={tableSortDirection(activeView.sort, field.id) === 'asc' ? 'ascending' : tableSortDirection(activeView.sort, field.id) === 'desc' ? 'descending' : 'none'} className="group/table-column border-r border-[var(--border)] bg-[var(--document-bg)] p-0 text-left font-normal">
              <div data-state={headerMenuFieldId === field.id ? 'open' : 'closed'} className="multidimensional-table__column-header flex min-w-0 items-center transition-colors hover:bg-[var(--muted)] data-[state=open]:bg-[var(--muted)]">
                <div className="min-w-0 flex-1">
                  <TableFieldHeader
                    field={field}
                    label={fieldLabel(field, propertyFields, t)}
                    systemPreset={isSystemPresetField(field)}
                    saving={saving || !editable}
                    open={headerMenuFieldId === field.id}
                    typeChoices={FIELD_TYPE_CHOICES}
                    customPresets={tablePresets.custom}
                    systemPresets={tablePresets.system}
                    isPresetAdded={presetAlreadyAdded}
                    onRemovePreset={removePreset}
                    t={t}
                    typeLabel={(type) => fieldTypeLabel(type, t)}
                    typeIconKind={fieldTypeIconKind}
                    onOpenChange={(open) => setHeaderMenuFieldId(open ? field.id : null)}
                    onSaveEdits={queueHeaderFieldEdits}
                    onChangeType={changeFieldType}
                    onApplyPreset={applyFieldPreset}
                    onHide={field.type === 'primary' ? undefined : () => hideTableField(field.id)}
                    onDelete={isSystemPresetField(field) ? undefined : deleteField}
                    onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
                    datasetMenu={datasetFieldManagerMenu}
                  />
                </div>
                <TableSortButton label={fieldLabel(field, propertyFields, t)} direction={tableSortDirection(activeView.sort, field.id)} disabled={!editable || saving} onClick={() => void toggleColumnSort(field.id)} />
              </div>
            </th>),
            ...visibleBuiltinFields.map((field) => {
              const builtinSchemaField: TableField = builtinPresetTableField(field.id) ?? {
                id: field.id,
                type: field.type,
                property_key: field.propertyKey ?? field.id,
              };
              return <th key={field.id} aria-sort={tableSortDirection(activeView.sort, field.id) === 'asc' ? 'ascending' : tableSortDirection(activeView.sort, field.id) === 'desc' ? 'descending' : 'none'} className="group/table-column border-r border-[var(--border)] bg-[var(--document-bg)] p-0 text-left font-normal">
              <div data-state={headerMenuFieldId === field.id ? 'open' : 'closed'} className="multidimensional-table__column-header flex min-w-0 items-center transition-colors hover:bg-[var(--muted)] data-[state=open]:bg-[var(--muted)]">
                <div className="min-w-0 flex-1">
                  <TableFieldHeader
                    field={builtinSchemaField}
                    label={builtinTableFieldLabel(field, t)}
                    trailingLabel={builtinPresetTableField(field.id) ? '预设' : '只读'}
                    readOnly
                    saving={saving || !editable}
                    open={headerMenuFieldId === field.id}
                    typeChoices={FIELD_TYPE_CHOICES}
                    customPresets={tablePresets.custom}
                    systemPresets={tablePresets.system}
                    t={t}
                    typeLabel={(type) => fieldTypeLabel(type, t)}
                    typeIconKind={fieldTypeIconKind}
                    onOpenChange={(open) => setHeaderMenuFieldId(open ? field.id : null)}
                    onSaveEdits={queueHeaderFieldEdits}
                    onChangeType={changeFieldType}
                    onApplyPreset={applyFieldPreset}
                    onHide={() => hideTableField(field.id)}
                    onDelete={deleteBuiltinField}
                    onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
                    datasetMenu={datasetFieldManagerMenu}
                  />
                </div>
                <TableSortButton label={builtinTableFieldLabel(field, t)} direction={tableSortDirection(activeView.sort, field.id)} disabled={!editable || saving} onClick={() => void toggleColumnSort(field.id)} />
              </div>
            </th>;
            })], (cell) => String(cell.key), fieldOrder)}
            <th className="multidimensional-table__column-action-header border-r border-[var(--border)] bg-[var(--document-bg)] px-2 text-left" aria-label="表格操作">
              {canCreateFields && <button
                type="button"
                disabled={saving}
                aria-label="添加属性"
                title="添加属性"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40"
                onClick={(event) => {
                  openNewFieldEditor(event.currentTarget, 'table');
                }}
              ><Plus className="h-4 w-4" aria-hidden="true" /></button>}
            </th></tr>
          </thead>
          <tbody>{renderedTableRecords.map((record) => {
            const noteKey = noteKeyForRecord(record);
            const note = noteKey ? noteByKey.get(noteKey) : undefined;
            const noteStatus = !noteKey ? 'draft' : note ? 'linked' : notesLoadError ? 'unknown' : 'missing';
            const isDropPreview = tableDropPreview?.draggedPaths.includes(record.note_path.replace(/\\/g, '/')) ?? false;
            return <TableRecordRow
              key={record.id}
              record={record}
              isDropPreview={isDropPreview}
              showBottomBorder
              imagePaths={imagePaths}
              notePropertyEditorValue={notePropertyEditorValue}
              fields={tableViewFields}
              builtinFields={visibleBuiltinFields}
              fieldOrder={fieldOrder}
              allowSwitchNote={document.collection.placement !== 'folder'}
              titleField={titleField}
              note={note}
              isRuleLinked={conditionRecordIds.has(record.id)}
              notebookPath={notebookPath}
              getAvailableNotes={getAvailableNotes}
              subscribeAvailableNotes={subscribeAvailableNotes}
              noteStatus={noteStatus}
              autoOpenPrimaryEditor={autoOpenPrimaryRecordId === record.id}
              imageUrls={imageUrls}
              saving={saving}
              cellStatuses={cellStatusesByRecord.get(record.id) ?? EMPTY_CELL_STATUSES}
              rowActionOpen={rowActionRecordId === record.id}
              onRetryNoteLookup={retryNoteLookup}
              onReplaceNote={replaceLinkedNote}
              onCreateAndLinkRecordNote={createAndLinkRecordNote}
              onAutoOpenHandled={handleAutoOpenHandled}
              onRenameNote={renameLinkedNote}
              onOpenNote={openLinkedNote}
              onDeleteNote={requestDeleteLinkedNote}
              onSelectImage={selectImageForCell}
              onUpdateCell={updateCell}
              onDeleteRecord={handleDeleteRecord}
              onRowActionOpenChange={handleRowActionOpenChange}
            />;
          })}
          {renderedTableRecords.length === 0 && (
            <tr>
              <td colSpan={tableColumnCount} className="border-b border-[var(--border)] px-4 py-3 text-center text-sm text-[var(--muted-foreground)]">
                添加数据后查看
              </td>
            </tr>
          )}
          </tbody>
        </table>
      </div>}
      {activeView?.layout === 'table' && <TableNoteDropOverlay active={Boolean(tableDropPreview)} dropAreaRef={recordsScrollerRef} />}
      {activeView?.layout === 'kanban' && groupField?.type === 'Select' && <TableKanbanView
        embeddedInEditor={embeddedInEditor}
        groupField={groupField}
        titleField={titleField ?? document.dataset.schema.fields[0]}
        records={secondaryViewRecords}
        groups={kanbanGroups}
        renderValue={displayFieldValue}
        recordStatus={noteStatusForRecord}
        noteIconForRecord={noteIconForRecord}
        onDropRecord={dropKanbanRecord}
        dropNotebookId={resolvedNotebookId}
        canDropExternal={editable && !saving && Boolean(document && noteField && notebookPath && resolvedNotebookId)}
        onExternalNoteDrop={addExternalNotesToKanban}
        onReorderLane={reorderKanbanLane}
        onAddLane={editable ? addKanbanLane : undefined}
        onAddTask={addKanbanTask}
        onOpenRecord={openLinkedRecord}
        onRenameRecord={editable && !saving ? renameKanbanRecord : undefined}
        onDeleteRecord={editable && !saving ? handleDeleteRecord : undefined}
        canAddTask={editable && Boolean(noteField && resolvedNotebookId && notebookPath) && !saving}
        canAddLane={editable && !saving}
      />}
      {activeView?.layout === 'kanban' && groupField?.type !== 'Select' && <IncompatibleViewEmptyState
        title={t('multidimensionalTable.view.incompatibleTitle')}
        titleAction={editable && <button type="button" disabled={saving} onClick={(event) => {
          setConfiguringViewId(activeView.id);
          setPendingViewType('kanban');
          setViewAddStep('field');
          setViewFieldPickerAnchorRect(event.currentTarget.getBoundingClientRect());
          setViewAddOpen(true);
        }} className="inline-flex items-center gap-1 text-sm text-[var(--primary)] hover:underline disabled:opacity-50">
          选择分组<ChevronRight className="size-4" aria-hidden="true" />
        </button>}
        description={groupField
          ? t('multidimensionalTable.view.kanbanFieldTypeMismatch', {
            field: fieldLabel(groupField, propertyFields, t),
            type: groupField.type !== 'primary' ? t(getPropertyTypeDefinition(groupField.type).labelKey) : t('multidimensionalTable.view.missingField'),
          })
          : t('multidimensionalTable.view.kanbanMissingField')}
      />}
      {activeView?.layout === 'calendar' && calendarDateFieldId && (calendarDateMetadata || calendarField?.type === 'Date') && <TableCalendarView
        embeddedInEditor={embeddedInEditor}
        cursor={calendarCursor}
        onCursorChange={setCalendarCursor}
        days={calendarDays}
        groups={calendarGroups}
        dateFieldId={calendarDateFieldId}
        dateFieldLabel={calendarDateMetadata?.label ?? (calendarField ? fieldLabel(calendarField, propertyFields, t) : '')}
        dateFieldOptions={calendarDateFieldOptions}
        onDateFieldChange={calendarController.canChangeDateField ? updateCalendarDateField : undefined}
        onCustomDateField={calendarController.canChangeDateField ? () => setMatchingOpen(true) : undefined}
        titleField={document.dataset.schema.fields.find((field) => field.id === calendarTitleFieldId) ?? noteField ?? document.dataset.schema.fields[0]}
        renderValue={displayFieldValue}
        noteColorForRecord={calendarNoteColorForRecord}
        noteIconForRecord={noteIconForRecord}
        dateValueForRecord={(record) => calendarDateMetadata
          ? calendarDateTimeForTimestamp(noteForRecord(record)?.[calendarDateMetadata.timestamp])
          : calendarField ? notePropertyEditorValue(noteForRecord(record), calendarField) : null}
        canMoveRecords={calendarController.canEditDateValues && calendarField?.type === 'Date'}
        dateFieldReadOnly={calendarReadOnly}
        dateFieldReadOnlyReason={calendarDateMetadata ? `日历按${calendarDateMetadata.label}展示，为只读状态` : '当前多维表格为只读状态'}
        weekStart={calendarWeekStart}
        onWeekStartChange={calendarController.canChangeDateField ? updateCalendarWeekStart : undefined}
        onMoveRecord={updateRecordField}
        dropNotebookId={resolvedNotebookId}
        onExternalNoteDrop={addExternalNotesToCalendar}
        onOpenRecord={openLinkedRecord}
        onEditRecord={openCalendarEditPopover}
        addingNoteDate={calendarAddOpen ? calendarAddDate?.date : null}
        onDoubleClickDate={(date, anchorRect) => {
          if (!editable) {
            toast.warning('当前多维表格为只读状态');
            return;
          }
          if (calendarDateMetadata && date !== isoDate(new Date())) {
            toast.warning(`日历按${calendarDateMetadata.label}展示，仅支持在今天新建笔记`);
            return;
          }
          openCalendarNotePopover(date, anchorRect, calendarDateFieldId);
        }}
      />}
      {activeView?.layout === 'calendar' && (!calendarDateFieldId || (!calendarDateMetadata && calendarField?.type !== 'Date')) && <IncompatibleViewEmptyState
        title={t('multidimensionalTable.view.incompatibleTitle')}
        titleAction={editable && <button type="button" disabled={saving} onClick={(event) => {
          setConfiguringViewId(activeView.id);
          setPendingViewType('calendar');
          setViewAddStep('field');
          setViewFieldPickerAnchorRect(event.currentTarget.getBoundingClientRect());
          setViewAddOpen(true);
        }} className="inline-flex items-center gap-1 text-sm text-[var(--primary)] hover:underline disabled:opacity-50">
          选择日期<ChevronRight className="size-4" aria-hidden="true" />
        </button>}
        description={calendarField
          ? t('multidimensionalTable.view.calendarFieldTypeMismatch', {
            field: fieldLabel(calendarField, propertyFields, t),
            type: calendarField.type !== 'primary' ? t(getPropertyTypeDefinition(calendarField.type).labelKey) : t('multidimensionalTable.view.missingField'),
          })
          : t('multidimensionalTable.view.calendarMissingField')}
      />}
      {activeView?.layout === 'gallery' && <TableGalleryView
        dropAreaRef={recordsScrollerRef}
        records={visibleGalleryRecords}
        nextRecordId={secondaryViewRecords[(embeddedInEditor ? galleryCurrentPage * galleryPageSize : 0) + visibleGalleryRecords.length]?.id ?? null}
        titleField={titleField ?? document.dataset.schema.fields[0]}
        fields={galleryFields}
        renderValue={displayFieldValue}
        imageUrl={(record, field) => {
          const path = imagePaths(notePropertyEditorValue(noteForRecord(record), field))[0];
          return path ? imageUrls[`${record.id}:${field.id}:${path}`] ?? null : null;
        }}
        noteThumbnail={(record) => noteThumbnailUrl(noteForRecord(record)?.thumbnail)}
        onOpenRecord={(record, anchorRect) => {
          const note = noteForRecord(record);
          if (note) openLinkedNote(note);
          else if (notesLoadError) retryNoteLookup();
          else openNotePicker(anchorRect, record.id);
        }}
        onCreateBlankNote={createBlankGalleryNote}
        onChooseData={chooseGalleryData}
        recordStatus={noteStatusForRecord}
        noteIcon={(record) => noteForRecord(record)?.icon ?? null}
        canAddData={editable && Boolean(noteField && resolvedNotebookId) && !saving}
        dropNotebookId={resolvedNotebookId}
        canDropExternal={editable && Boolean(noteField && notebookPath && resolvedNotebookId) && !saving}
        previewExternalNoteDrop={previewExternalGalleryDrop}
        onExternalNoteDrop={addExternalNotesToGallery}
      />}
      {embeddedInEditor && activeView?.layout === 'gallery' && galleryPageCount > 1 && <footer className="flex flex-wrap items-center justify-end gap-3 px-0 py-1.5 text-sm text-[var(--muted-foreground)]" aria-label="画廊分页">
        <span>{secondaryViewRecords.length} 条</span>
        <button
          type="button"
          disabled={galleryCurrentPage === 0}
          onClick={() => setGalleryPage(galleryCurrentPage - 1)}
          className="p-0 text-inherit hover:text-[var(--foreground)] disabled:opacity-40"
        >
          上一页
        </button>
        <span>{galleryCurrentPage + 1} / {galleryPageCount}</span>
        <button
          type="button"
          disabled={galleryCurrentPage >= galleryPageCount - 1}
          onClick={() => setGalleryPage(galleryCurrentPage + 1)}
          className="p-0 text-inherit hover:text-[var(--foreground)] disabled:opacity-40"
        >
          下一页
        </button>
      </footer>}
      {!embeddedInEditor && ((activeView?.layout === 'table' && currentPage < pageCount - 1)
        || (activeView?.layout === 'gallery' && galleryCurrentPage < galleryPageCount - 1)) && (
        <div ref={loadMoreRecordsRef} className="h-8 shrink-0" aria-hidden="true" />
      )}
      </OverlayScrollbar>
      {activeView?.layout === 'table' && <div className={`flex w-full min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 py-1.5 pr-0 ${embeddedInEditor ? '' : 'pl-4'}`}>
        {showAssociateNoteButton && (
          <button
            type="button"
            disabled={!editable || saving || !noteField}
            onClick={() => void addDraftRecordAndOpenNoteSelector()}
            className="flex items-center gap-0.5 rounded py-1 text-sm text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            添加笔记
          </button>
        )}
        <footer className="flex flex-wrap items-center gap-3 text-sm text-[var(--muted-foreground)]" aria-label={embeddedInEditor && pageCount > 1 ? '表格分页' : '记录统计'}>
          <span>{visibleRecords.length} 条</span>
          {embeddedInEditor && pageCount > 1 && <>
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setTablePage(currentPage - 1)}
              className="p-0 text-inherit hover:text-[var(--foreground)] disabled:opacity-40"
            >
              上一页
            </button>
            <span>{currentPage + 1} / {pageCount}</span>
            <button
              type="button"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setTablePage(currentPage + 1)}
              className="p-0 text-inherit hover:text-[var(--foreground)] disabled:opacity-40"
            >
              下一页
            </button>
          </>}
        </footer>
      </div>}
    </div>
    <Popover open={newFieldOpen} onOpenChange={(open) => {
      setNewFieldOpen(open);
      if (!open) {
        setNewFieldAnchor(null);
        setNewFieldTypeMenuOpen(false);
        setNewFieldPresetMenuOpen(false);
        if (skipNewFieldSaveOnCloseRef.current) skipNewFieldSaveOnCloseRef.current = false;
        else addField();
      }
      }} anchorRect={newFieldAnchor?.rect ?? null}>
      <PopoverContent side="left" align={newFieldAnchor?.align ?? 'start'} sideOffset={0} ignorePopoverOutside={newFieldTypeMenuOpen || newFieldPresetMenuOpen} style={{ zIndex: 160 }} className="max-h-[min(70vh,420px)] w-[213px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <TableFieldEditorForm
          name={newFieldPropertyKey}
          onNameChange={setNewFieldPropertyKey}
          onNameSubmit={() => addField()}
          type={newFieldType}
          typeChoices={FIELD_TYPE_CHOICES}
          onTypeChange={(type) => {
            setNewFieldType(type);
            setNewFieldOptions((current) => type === 'Select' || type === 'MultiSelect'
              ? current.length > 0 ? current : [{ id: `opt_${createUuidV7()}`, label: '' }]
              : []);
          }}
          typeMenuOpen={newFieldTypeMenuOpen}
          onTypeMenuOpenChange={(open) => {
            setNewFieldTypeMenuOpen(open);
            if (open) setNewFieldPresetMenuOpen(false);
          }}
          options={newFieldOptions}
          onOptionsChange={setNewFieldOptions}
          customPresets={tablePresets.custom}
          systemPresets={tablePresets.system}
          presetMenuOpen={newFieldPresetMenuOpen}
          onPresetMenuOpenChange={(open) => {
            setNewFieldPresetMenuOpen(open);
            if (open) setNewFieldTypeMenuOpen(false);
          }}
          isPresetAdded={presetAlreadyAdded}
          onSelectPreset={(preset) => {
            setNewFieldPresetMenuOpen(false);
            skipNewFieldSaveOnCloseRef.current = true;
            setNewFieldPropertyKey('');
            setNewFieldOptions([]);
            setNewFieldOpen(false);
            void addField(preset);
          }}
          onRemovePreset={removePreset}
          onManagePresets={() => {
            setNewFieldPresetMenuOpen(false);
            skipNewFieldSaveOnCloseRef.current = true;
            setNewFieldOpen(false);
            void windows.openPreferences('noteSettings');
          }}
          afterFooter={<button
            type="button"
            disabled={!editable || saving || !newFieldPropertyKey.trim()}
            onClick={() => { void addField(); }}
            className="mt-1 flex h-8 w-full items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--muted)] px-2 text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
          >保存</button>}
          disabled={!editable || saving}
          t={t}
          typeLabel={(type) => fieldTypeLabel(type, t)}
          typeIconKind={fieldTypeIconKind}
        />
      </PopoverContent>
    </Popover>
    <Popover open={calendarAddOpen} onOpenChange={(open) => {
      setCalendarAddOpen(open);
      if (!open) {
        calendarPendingCreatedNoteRef.current = null;
        setCalendarEditingRecord(null);
      }
    }} anchorRect={calendarAddAnchorRect}>
      <PopoverContent side="right" align="start" sideOffset={8} fitViewport ignorePopoverOutside style={{ zIndex: 160 }} className="calendar-note-create-popover flex max-h-[min(424px,100vh)] w-[320px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl px-2 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <NoteCreatePicker
          value={calendarAddTitle} onChange={setCalendarAddTitle}
          mode={calendarEditingRecord ? 'edit' : 'create'} allowSelect={false}
          disabled={saving || !editable || (!calendarEditingRecord && !resolvedNotebookId)}
          onCreate={calendarEditingRecord ? saveCalendarNoteEdit : createCalendarNote} onCancel={closeCalendarNoteDialog}
          showCreateButton={false}
          actionsLayout="column"
          scrollTitleWithActions
          actions={calendarCreateFields.length > 0 ? <div className="calendar-note-create-fields border-t border-[var(--border)]">
            {calendarCreateFields.map((field) => {
              const value = calendarCreatePropertyValues[field.id];
              const inputClass = 'h-8 w-full rounded-md border-0 bg-transparent px-0 text-sm outline-none placeholder:text-[var(--muted-foreground)] placeholder:opacity-80 focus:border-0 focus:bg-transparent focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50';
              const setValue = (nextValue: unknown) => setCalendarCreatePropertyValues((current) => ({ ...current, [field.id]: nextValue }));
              const options = field.options?.map((option) => ({ value: option.id, label: option.label })) ?? [];
              const control = field.type === 'Boolean'
                ? <TableBooleanInput value={value} disabled={saving} ariaLabel={fieldLabel(field, propertyFields, t)} onChange={setValue} />
                : field.type === 'Select'
                  ? <SelectValueInput value={String(value ?? '')} options={options} disabled={saving} variant="table" onChange={setValue} />
                  : field.type === 'MultiSelect'
                    ? <MultiSelectValueInput value={Array.isArray(value) ? value.map(String).join(', ') : ''} options={options} disabled={saving} variant="table" onChange={(next) => setValue(next.split(',').map((item) => item.trim()).filter(Boolean))} />
                    : field.type === 'Date'
                      ? <DateValueInput value={String(value ?? '')} disabled={saving} variant="table" onChange={setValue} />
                      : field.type === 'Color'
                        ? <ColorValueInput value={Array.isArray(value) ? value.map(String).join(', ') : ''} disabled={saving} variant="table" onChange={(next) => setValue(next ? next.split(',').map((item) => item.trim()).filter(Boolean) : [])} />
                        : field.type === 'Icon'
                          ? <IconValueInput value={String(value ?? '')} disabled={saving} variant="table" onChange={setValue} />
                          : field.type === 'Tag'
                            ? <TableTagValueInput value={Array.isArray(value) ? value.map(String) : []} disabled={saving} isNoteTags={canonicalizePropertyKey(field.property_key ?? '') === 'tags'} onChange={setValue} />
                            : field.type === 'Text'
                              ? <TableTextValueInput value={String(value ?? '')} disabled={saving} onChange={(next) => setValue(next ?? '')} />
                              : field.type === 'Number'
                                ? <TableNumberInput value={value} disabled={saving} placeholder="" className={inputClass} onChange={setValue} />
                                : field.type === 'Image'
                                  ? <NotePropertyImageValue
                                    value={value}
                                    notebook={resolvedNotebookId && notebookPath ? { id: resolvedNotebookId, path: notebookPath } : undefined}
                                    disabled={saving}
                                    onChange={(path) => setValue(field.multiple ? [...(Array.isArray(value) ? value.map(String) : []), path] : path)}
                                  />
                                  : <input type="url" value={String(value ?? '')} disabled={saving} onChange={(event) => setValue(event.currentTarget.value)} className={inputClass} />;
              return <div key={field.id} className="flex min-w-0 items-center gap-2 border-b border-[var(--border)] last:border-b-0">
                <div className="w-fit min-w-[24%] max-w-[36%] shrink-0 truncate text-sm" title={fieldLabel(field, propertyFields, t)}>{fieldLabel(field, propertyFields, t)}</div>
                <div className="multidimensional-table__cell-content calendar-note-create-field-input min-w-0 flex-1 px-1.5">{control}</div>
              </div>;
            })}
          </div> : undefined}
          footer={<div className="flex w-full shrink-0 gap-2 pt-2">
            {!calendarEditingRecord && <Button type="button" variant="outline" size="lg" className="!h-8 flex-1 rounded-lg text-sm" disabled={saving} onClick={closeCalendarNoteDialog}>取消</Button>}
            <Button type="button" size="lg" className="!h-8 flex-1 rounded-lg text-sm" disabled={saving || !editable || (!calendarEditingRecord && !resolvedNotebookId) || !calendarAddTitle.trim()} onClick={() => void (calendarEditingRecord ? saveCalendarNoteEdit() : createCalendarNote())}>
              {saving && <LoaderCircle className="mr-1 h-3.5 w-3.5 flowix-spin" aria-hidden="true" />}
              保存
            </Button>
            {calendarEditingRecord && <Button type="button" variant="outline" size="lg" className="!h-8 flex-1 rounded-lg text-sm" disabled={!noteForRecord(calendarEditingRecord)} onClick={() => openLinkedRecord(calendarEditingRecord.id)}>打开</Button>}
          </div>}
        />
      </PopoverContent>
    </Popover>
    <Popover open={notePickerOpen} onOpenChange={(open) => {
      setNotePickerOpen(open);
      if (!open) {
        setNotePickerRecordId(null);
        setNotePickerCalendarDate(null);
      }
    }} anchorRect={notePickerAnchorRect}>
      <PopoverContent side="bottom" align="start" sideOffset={6} fitViewport className="w-[280px] max-w-[calc(100vw-16px)] rounded-xl px-2 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <NoteCreatePicker
          value={newNoteTitle} onChange={setNewNoteTitle}
          notes={availableNotes} allowSelect={document.collection.placement !== 'folder'}
          disabled={saving || !editable || !resolvedNotebookId} error={notesLoadError}
          onCreate={createAndLinkNote}
          onSelect={(selectedNote) => linkSelectedNote(selectedNote.relativePath.replace(/\\/g, '/'))}
          onCancel={() => setNotePickerOpen(false)}
        />
      </PopoverContent>
    </Popover>
    <Dialog open={viewPendingDelete !== null} onOpenChange={(open) => { if (!open) setViewPendingDelete(null); }}>
      <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <DialogHeader>
          <DialogTitle>{t('multidimensionalTable.view.delete')}</DialogTitle>
          <DialogDescription>
            {viewPendingDelete ? t('multidimensionalTable.view.deleteConfirm', { name: viewPendingDelete.name }) : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setViewPendingDelete(null)}>{t('dialog.cancel')}</Button>
          <Button type="button" variant="destructive" onClick={confirmDeleteView}>{t('dialog.delete')}</Button>
        </div>
      </DialogContent>
    </Dialog>
    <FolderCollectionSwitchConfirmDialog
      open={folderMediaSwitchConfirmOpen}
      onOpenChange={setFolderMediaSwitchConfirmOpen}
      confirmDisabled={saving}
      onConfirm={() => {
        setFolderMediaSwitchConfirmOpen(false);
        if (notebookPath && notebookId) {
          window.dispatchEvent(new CustomEvent('flowix:request-switch-folder-collection-type', {
            detail: { filePath: currentFilePath, notebookPath, notebookId, type: 'media_library' },
          }));
        }
      }}
    />
  </div>;
}
