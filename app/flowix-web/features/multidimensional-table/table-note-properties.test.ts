import { describe, expect, it } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import { PROPERTY_TYPES_KEY } from '@features/document/properties/property-type-metadata';
import type { TableField } from './model';
import { calendarCreatePropertyValue, notePropertyEditorValue, renameNoteProperty, valueMatchesFieldType } from './table-note-properties';

const select: TableField = { id: 'stage', property_key: 'Stage', type: 'MultiSelect', options: [{ id: 'a', label: 'Pending' }, { id: 'b', label: 'Done' }] };
describe('note property values used by table editors', () => {
  it('round-trips stored option labels through editor IDs without changing their order', () => {
    const note = { properties: { Stage: ['Done', 'Pending'] } } as unknown as NoteEntry;
    const value = notePropertyEditorValue(note, select);
    expect(value).toEqual(['b', 'a']);
    expect(calendarCreatePropertyValue(select, value)).toEqual({ include: true, value: ['Done', 'Pending'] });
  });
  it('renames a property together with its type declaration and preserves unrelated data', () => {
    const note = { properties: { Old: 'hello', Keep: 7, [PROPERTY_TYPES_KEY]: { Old: 'Text', Keep: 'Number' } } } as unknown as NoteEntry;
    const next = renameNoteProperty(note, 'Old', 'New', { id: 'text', type: 'Text', property_key: 'Old' }, undefined, []);
    expect(next.properties).toEqual({ New: 'hello', Keep: 7, [PROPERTY_TYPES_KEY]: { New: 'Text', Keep: 'Number' } });
    expect(note.properties.Old).toBe('hello');
  });
  it('retains zero-valued numbers and rejects non-finite numeric input', () => {
    const field: TableField = { id: 'number', type: 'Number', property_key: 'Count' };
    expect(calendarCreatePropertyValue(field, '0')).toEqual({ include: true, value: 0 });
    expect(calendarCreatePropertyValue(field, ' ' ).include).toBe(false);
    expect(valueMatchesFieldType(Infinity, 'Number')).toBe(false);
  });
});
