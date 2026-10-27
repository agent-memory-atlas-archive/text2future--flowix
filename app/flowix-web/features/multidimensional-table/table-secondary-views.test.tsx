import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TableField, TableRecord } from './model';
import { TableKanbanView } from './table-secondary-views';
import { endDragSession, registerDropTarget } from '@shared/drag-drop/drag-drop-coordinator';

const groupField: TableField = {
  id: 'status',
  type: 'Select',
  property_key: 'status',
  options: [{ id: 'todo', label: '待办' }, { id: 'done', label: '完成' }],
};
const titleField: TableField = { id: 'note', type: 'primary', property_key: 'note' };
const first: TableRecord = { id: 'first', note_path: 'first.md', updated_at: '' };
const second: TableRecord = { id: 'second', note_path: 'second.md', updated_at: '' };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/**
 * 用真实的 PointerEvent 而不是手工挂属性的 Event：拖拽协调器会读 `buttons`
 * 判断“是否仍按着”，手工 Event 缺这个字段会让 pointermove 直接被忽略。
 * jsdom 已实现 PointerEvent，无需再打补丁。
 */
function pointer(source: HTMLElement, type: string, x: number, y: number) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: x,
    clientY: y,
  });
  act(() => source.dispatchEvent(event));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
  Reflect.deleteProperty(document, 'elementFromPoint');
});

describe('TableKanbanView pointer movement', () => {
  it('cancels its drag session and clears another target preview when unmounted', () => {
    container = document.createElement('div');
    root = createRoot(container);
    const onPreview = vi.fn();
    const unregister = registerDropTarget({
      id: 'unmount-probe',
      priority: 200,
      hitTest: () => 'probe',
      locationKey: (location: string) => location,
      evaluate: () => ({ accepted: true as const }),
      onPreview,
      onDrop: vi.fn(),
      onError: vi.fn(),
    });
    try {
      act(() => root?.render(<TableKanbanView
        groupField={groupField}
        titleField={titleField}
        groups={new Map([['todo', [first]]])}
        renderValue={(record) => record.note_path}
        onDropRecord={vi.fn()}
        onReorderLane={vi.fn()}
      />));
      const card = container.querySelector<HTMLElement>('[data-kanban-record="first"]')!;
      pointer(card, 'pointerdown', 10, 10);
      pointer(card, 'pointermove', 30, 30);
      const sessionId = onPreview.mock.calls[0][0].payload.sessionId;
      act(() => root?.unmount());
      root = null;
      expect(onPreview).toHaveBeenLastCalledWith(null);
      expect(endDragSession(sessionId, { x: 30, y: 30 })).toBe(false);
    } finally {
      unregister();
    }
  });

  it('opens a linked note when a card is clicked without dragging', () => {
    container = document.createElement('div');
    root = createRoot(container);
    const onOpenRecord = vi.fn();
    act(() => root?.render(<TableKanbanView
      groupField={groupField}
      titleField={titleField}
      groups={new Map([['todo', [first]], ['done', []]])}
      renderValue={(record) => record.note_path}
      recordStatus={() => 'linked'}
      onDropRecord={vi.fn()}
      onReorderLane={vi.fn()}
      onOpenRecord={onOpenRecord}
    />));
    const card = container.querySelector<HTMLElement>('[data-kanban-record="first"]')!;
    pointer(card, 'pointerdown', 10, 10);
    pointer(card, 'pointerup', 10, 10);
    expect(onOpenRecord).toHaveBeenCalledWith('first');
  });

  it('resolves another lane and passes its select option to the move handler', async () => {
    container = document.createElement('div');
    root = createRoot(container);
    const onDropRecord = vi.fn();
    act(() => root?.render(<TableKanbanView
      groupField={groupField}
      titleField={titleField}
      groups={new Map([['todo', [first]], ['done', [second]]])}
      renderValue={(record) => record.note_path}
      onDropRecord={onDropRecord}
      onReorderLane={vi.fn()}
    />));

    const source = container.querySelector<HTMLElement>('[data-kanban-record="first"]')!;
    Object.defineProperty(source, 'setPointerCapture', { configurable: true, value: vi.fn() });
    // 重渲染会替换泳道节点，命中测试必须按选择器实时取，不能缓存引用。
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => container!.querySelector<HTMLElement>('[data-kanban-lane="done"]'),
    });

    pointer(source, 'pointerdown', 10, 10);
    pointer(source, 'pointermove', 30, 30);
    const destination = container.querySelector<HTMLElement>('[data-kanban-lane="done"]')!;
    const preview = destination.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(preview?.textContent).toContain('first.md');
    expect(preview?.classList.contains('opacity-50')).toBe(true);
    expect(destination.hasAttribute('data-drag-over')).toBe(false);
    const floating = document.querySelector<HTMLElement>('[data-kanban-floating-preview]');
    expect(floating?.textContent).toContain('first.md');
    expect(floating?.classList.contains('opacity-50')).toBe(false);
    expect(floating?.style.left).toBe('44px');
    expect(floating?.style.top).toBe('44px');
    pointer(container.querySelector<HTMLElement>('[data-kanban-record="first"]')!, 'pointerup', 30, 30);
    // endDragSession 用 Promise.resolve().then() 派发 onDrop，必须让微任务跑完。
    await act(async () => {});

    expect(onDropRecord).toHaveBeenCalledWith('first', 'done', null);
    expect(document.querySelector('[data-kanban-floating-preview]')).toBeNull();
  });

  it('keeps a single half-transparent card when returning to the original position', () => {
    container = document.createElement('div');
    root = createRoot(container);
    act(() => root?.render(<TableKanbanView
      groupField={groupField}
      titleField={titleField}
      groups={new Map([['todo', [first, second]], ['done', []]])}
      renderValue={(record) => record.note_path}
      onDropRecord={vi.fn()}
      onReorderLane={vi.fn()}
    />));

    const source = container.querySelector<HTMLElement>('[data-kanban-record="first"]')!;
    const nextCard = container.querySelector<HTMLElement>('[data-kanban-record="second"]')!;
    const destination = container.querySelector<HTMLElement>('[data-kanban-lane="done"]')!;
    const emptyHint = destination.querySelector<HTMLElement>('.multidimensional-table__kanban-empty')!;
    expect(emptyHint.classList.contains('select-none')).toBe(true);
    expect(emptyHint.classList.contains('pointer-events-none')).toBe(true);
    Object.defineProperty(source, 'setPointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(nextCard, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 50, height: 20 }),
    });
    // 拖拽触发重渲染会把泳道整棵子树换成新节点，测试持有的引用会脱离文档
    // （isConnected === false）。命中测试与断言都必须按选择器实时查询，
    // 否则会对着一个已经不在页面上的节点断言“没有占位卡”。
    let hitSelector = '[data-kanban-lane="done"]';
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => container!.querySelector<HTMLElement>(hitSelector),
    });

    pointer(source, 'pointerdown', 10, 10);
    pointer(source, 'pointermove', 30, 30);
    const destinationLane = container.querySelector<HTMLElement>('[data-kanban-lane="done"]')!;
    expect(
      destinationLane.querySelector('.multidimensional-table__kanban-card[aria-hidden="true"]'),
    ).not.toBeNull();

    hitSelector = '[data-kanban-record="first"]';
    pointer(source, 'pointermove', 31, 30);
    const liveSource = container.querySelector<HTMLElement>('[data-kanban-record="first"]')!;
    const sourceLane = container.querySelector<HTMLElement>('[data-kanban-lane="todo"]')!;
    expect(liveSource.classList.contains('opacity-50')).toBe(true);
    expect(sourceLane.querySelector('.multidimensional-table__kanban-card[aria-hidden="true"]')).toBeNull();
    expect(sourceLane.querySelector('.multidimensional-table__kanban-empty')).toBeNull();
  });

  it('passes the insertion card when reordering within a lane', async () => {
    container = document.createElement('div');
    root = createRoot(container);
    const onDropRecord = vi.fn();
    act(() => root?.render(<TableKanbanView
      groupField={groupField}
      titleField={titleField}
      groups={new Map([['todo', [first, second]]])}
      renderValue={(record) => record.note_path}
      onDropRecord={onDropRecord}
      onReorderLane={vi.fn()}
    />));

    const source = container.querySelector<HTMLElement>('[data-kanban-record="second"]')!;
    const beforeCard = container.querySelector<HTMLElement>('[data-kanban-record="first"]')!;
    Object.defineProperty(source, 'setPointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(beforeCard, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 20, height: 20 }),
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => container!.querySelector<HTMLElement>('[data-kanban-lane="todo"]'),
    });

    pointer(source, 'pointerdown', 10, 10);
    pointer(source, 'pointermove', 30, 25);
    pointer(container.querySelector<HTMLElement>('[data-kanban-record="second"]')!, 'pointerup', 30, 25);
    await act(async () => {});

    expect(onDropRecord).toHaveBeenCalledWith('second', 'todo', 'first');
  });
});
