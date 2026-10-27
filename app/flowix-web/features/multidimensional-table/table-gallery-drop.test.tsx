import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import { beginDragSession, cancelDragSession, endDragSession } from '@shared/drag-drop/drag-drop-coordinator';
import { createTableDocument, type TableRecord } from './model';
import { planTableNoteDrop } from './table-note-drop';
import { TableGalleryView } from './table-secondary-views';
import { installLayoutStub } from '../../test-support/layout-stub';

it('shows a same-size translucent card at the sorted destination even when the pointer is over another position', async () => {
  const documentModel = createTableDocument('gallery');
  const incoming: NoteEntry = {
    relativePath: 'incoming.md', title: 'incoming.md', preview: '', thumbnail: null,
    tags: [], todos: [], agents: [], createdAt: 0, updatedAt: 20,
    favorited: false, icon: null, colors: [], properties: {},
  };
  const records: TableRecord[] = [
    { id: 'automatic', note_path: 'automatic.md', updated_at: '' },
    { id: 'old', note_path: 'old.md', updated_at: '' },
  ];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const layout = installLayoutStub();
  const onDrop = vi.fn();
  try {
    act(() => root.render(<TableGalleryView
      records={records}
      titleField={documentModel.dataset.schema.fields[0]}
      fields={documentModel.dataset.schema.fields}
      renderValue={(record) => record.note_path}
      imageUrl={() => null}
      onOpenRecord={vi.fn()}
      dropNotebookId="book"
      canDropExternal
      previewExternalNoteDrop={(_notes, beforeRecordId) => planTableNoteDrop({
        explicitRecords: [records[1]], automaticRecords: [records[0]], draggedNotes: [incoming],
        beforeRecordId, view: documentModel.views.items[0], fields: documentModel.dataset.schema.fields,
        primaryFieldId: documentModel.dataset.schema.primary_field_id,
        noteForRecord: (record) => ({ ...incoming, relativePath: record.note_path, updatedAt: record.id === 'automatic' ? 30 : 10 }),
        isInSource: () => true,
      })}
      onExternalNoteDrop={onDrop}
    />));
    const firstCard = container.querySelector<HTMLElement>('[data-gallery-record="automatic"]')!;
    // jsdom 下 rect 全 0，而 dropPositionAt 会用容器矩形做边界裁剪，
    // 任何非 0 坐标都会被判成“在容器外”，命中测试直接返回 null。
    layout.setBox(container.firstElementChild as HTMLElement, { left: 0, top: 0, width: 320, height: 800 });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => firstCard });
    Object.defineProperty(firstCard, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 0, top: 0, width: 160, height: 210 }) });
    act(() => beginDragSession({
      sourceId: 'sidebar', sessionId: 'gallery-sorted-drop',
      items: [{ kind: 'note', notebookId: 'book', relativePath: 'incoming.md', title: 'incoming.md' }],
    }, { x: 5, y: 5 }));
    const cards = [...container.querySelectorAll<HTMLElement>('[data-gallery-record], [data-gallery-preview]')];
    expect(cards.map((card) => card.textContent?.split('更新')[0])).toEqual(['automatic.md', 'incoming.md', 'old.md']);
    expect(cards[1].classList.contains('opacity-50')).toBe(true);
    expect(cards.every((card) => card.classList.contains('h-[210px]'))).toBe(true);
    await act(async () => { endDragSession('gallery-sorted-drop', { x: 5, y: 5 }); });
    expect(onDrop).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-gallery-preview]')).toBeNull();
  } finally {
    act(() => { cancelDragSession(); root.unmount(); });
    layout.restore();
    container.remove();
    Reflect.deleteProperty(document, 'elementFromPoint');
  }
});
