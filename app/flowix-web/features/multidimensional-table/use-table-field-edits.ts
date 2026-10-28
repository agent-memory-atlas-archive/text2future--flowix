import { useCallback, useRef, useState } from 'react';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { canonicalizePropertyKey, isSystemPropertyKey } from '@features/properties/property-key';
import { compareAndPatchDocumentProperties } from '@features/document/public/path-properties';
import {
  countPresetTableReferences,
  deletePresetEverywhere,
  ensureTableFieldPreset,
  migrateNotePropertyKey,
  updatePresetFromTable,
} from '@features/properties/property-preset-service';
import { usePropertyPresetStore } from '@features/properties/property-preset-store';
import type { PropertyFieldConfig } from '@/lib/constants';
import {
  resolvePropertyPreset,
  type PropertyPreset,
} from '@features/document/properties/presets';
import { useI18n } from '@/lib/i18n';
import {
  createUuidV7,
  type MultidimensionalTableDocument,
  type TableField,
  type TableFieldOption,
  type TableFieldType,
  type TableRecord,
} from './model';
import { notePropertyEditorValue, renameNoteProperty, valueMatchesFieldType } from './table-note-properties';
import { applyFieldMigrations, migratedOptionValue, planFieldMigrations, type FieldValueMigration } from './table-field-migration';
import { bindTableField, presetFromTableField, retireTablePreset, tableFieldFromPreset } from './table-preset-bindings';
import {
  addPresetField,
  addTableField,
  changeFieldType as changeFieldTypeInDocument,
  removeBuiltinField as removeBuiltinTableField,
  removeField,
  removePresetField,
  viewsRequiringField,
} from './table-commands';
import type { useTableSession } from './use-table-session';
import type { NoteEntry } from '@platform/tauri/client';
import type { usePropertyPresets } from '@features/properties/public-api';
import { PROPERTY_TYPES_KEY, readPropertyTypes } from '@features/document/properties/property-type-metadata';
import { collectionFilterUsesField, type DatasetFilter } from '@features/collection/rule-filter';
import { reviseCollection } from '@features/collection/model';

type TableSession = ReturnType<typeof useTableSession>;

export interface UseTableFieldEditsInput {
  session: Pick<TableSession,
    | 'document' | 'saving' | 'setSaving' | 'save' | 'loadSequenceRef' | 'isCurrentSession'
    | 'resolvedNotebookId' | 'setNotes' | 'reportSaveFailure' | 'pendingNotePropertiesRef'>;
  notebookPath: string | null;
  propertyFields: ReturnType<typeof usePropertyPresets>['fields'];
  datasetRecords: TableRecord[];
  notesLoadError: string | null;
  noteForRecord: (record: TableRecord) => NoteEntry | undefined;
}

/**
 * Field lifecycle for the dataset: adding (blank / from preset), renaming
 * (with note property migration), type changes, apply-preset, deletion
 * (including the global preset retirement dialog) and the new-field editor
 * popover state. Callback bodies are moved verbatim from
 * `table-document-view.tsx`.
 */
export function useTableFieldEdits(input: UseTableFieldEditsInput) {
  const {
    session, notebookPath, propertyFields, datasetRecords, notesLoadError, noteForRecord,
  } = input;
  const { document, saving, setSaving, save, loadSequenceRef, isCurrentSession, setNotes, reportSaveFailure, pendingNotePropertiesRef } = session;
  const { t } = useI18n();

  const [newFieldOpen, setNewFieldOpen] = useState(false);
  const [newFieldAnchor, setNewFieldAnchor] = useState<{ rect: DOMRect; align: 'start' | 'end'; source: 'dataset' | 'table' } | null>(null);
  const [newFieldPropertyKey, setNewFieldPropertyKey] = useState('');
  const [newFieldType, setNewFieldType] = useState<TableFieldType>('Text');
  const [newFieldTypeMenuOpen, setNewFieldTypeMenuOpen] = useState(false);
  const [newFieldPresetMenuOpen, setNewFieldPresetMenuOpen] = useState(false);
  const skipNewFieldSaveOnCloseRef = useRef(false);
  const [datasetPresetMenuOpen, setDatasetPresetMenuOpen] = useState(false);
  const [newFieldOptions, setNewFieldOptions] = useState<TableFieldOption[]>([]);
  const [pendingDeleteTarget, setPendingDeleteTarget] = useState<{ field: TableField; preset: PropertyFieldConfig } | null>(null);
  const [pendingDeleteTableCount, setPendingDeleteTableCount] = useState(0);
  const [deletingFieldBusy, setDeletingFieldBusy] = useState(false);

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
        catch (error) { console.warn('Preset sync failed after saving table', error); toast.error(t('errors.friendly.presetSync')); }
      }
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.propertySave'));
      return;
    }
    setNewFieldOpen(false);
    setNewFieldPropertyKey('');
    setNewFieldOptions([]);
  }, [document, newFieldOptions, newFieldPropertyKey, newFieldType, propertyFields, save, saving, t]);

  const removePreset = useCallback((preset: PropertyPreset) => {
    if (!document || saving) return;
    try {
      void save(removePresetField(document, preset));
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.propertyDelete'));
    }
  }, [document, save, saving, t]);

  const deleteBuiltinField = useCallback(async (field: TableField): Promise<boolean> => {
    if (!document || saving) return false;
    try {
      return await save(removeBuiltinTableField(document, field.id));
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.propertyDelete'));
      return false;
    }
  }, [document, save, saving, t]);

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
          console.warn('Preset sync failed after saving table', error); toast.error(t('errors.friendly.presetSync'));
          return true;
        }
        const transform = optionsChanged && nextOptions
          ? (value: unknown) => migratedOptionValue(field, nextOptions, value) ?? { value, remove: false }
          : undefined;
        let keyResult: { moved: number; failed: number } = { moved: 0, failed: 0 };
        try { keyResult = await migrateNotePropertyKey(propertyKey, nextKey, transform); }
        catch (error) { toast.error(friendlyErrorMessage(error, t, 'errors.friendly.propertySave')); }
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
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.propertySave'));
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
        catch (error) { toast.error(friendlyErrorMessage(error, t, 'errors.friendly.propertySave')); }
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
  }, [datasetRecords, document, isCurrentSession, loadSequenceRef, noteForRecord, notebookPath, notesLoadError, pendingNotePropertiesRef, propertyFields, reportSaveFailure, save, saving, setNotes, setSaving, t]);

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
    catch (error) { console.warn('Preset sync failed after saving table', error); toast.error(t('errors.friendly.presetSync')); }
    return true;
  }, [save, t]);

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
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.propertyDelete'));
    } finally {
      setDeletingFieldBusy(false);
    }
  }, [document, pendingDeleteTarget, save, t]);

  const openNewFieldEditor = useCallback((button: HTMLButtonElement, source: 'dataset' | 'table') => {
    setNewFieldType('Text');
    setNewFieldTypeMenuOpen(false);
    setNewFieldPresetMenuOpen(false);
    setDatasetPresetMenuOpen(false);
    setNewFieldPropertyKey('');
    setNewFieldOptions([]);
    // The dataset submenu grows upward; the table header editor grows downward.
    setNewFieldAnchor({ rect: button.getBoundingClientRect(), align: source === 'dataset' ? 'end' : 'start', source });
    setNewFieldOpen(true);
  }, []);

  return {
    newFieldOpen, setNewFieldOpen,
    newFieldAnchor, setNewFieldAnchor,
    newFieldPropertyKey, setNewFieldPropertyKey,
    newFieldType, setNewFieldType,
    newFieldTypeMenuOpen, setNewFieldTypeMenuOpen,
    newFieldPresetMenuOpen, setNewFieldPresetMenuOpen,
    datasetPresetMenuOpen, setDatasetPresetMenuOpen,
    newFieldOptions, setNewFieldOptions,
    skipNewFieldSaveOnCloseRef,
    pendingDeleteTarget, setPendingDeleteTarget,
    pendingDeleteTableCount,
    deletingFieldBusy,
    addField,
    removePreset,
    deleteBuiltinField,
    queueHeaderFieldEdits,
    changeFieldType,
    applyFieldPreset,
    deleteField,
    confirmDeleteField,
    openNewFieldEditor,
  };
}
