import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotebookTreeCustomizeList } from './notebook-tree-customize-list';
import type { NotebookTreeHiddenSection, NotebookTreeSection } from './use-notebook-tree-sections';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

describe('NotebookTreeCustomizeList', () => {
  const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
  let host: HTMLDivElement;
  let root: Root;
  const save = vi.fn();

  beforeEach(async () => {
    save.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    function Harness() {
      const [order, setOrder] = useState<NotebookTreeSection[]>(['agents', 'pinned', 'files']);
      const [hidden, setHidden] = useState<NotebookTreeHiddenSection[]>(['files']);
      return <NotebookTreeCustomizeList sectionOrder={order} hiddenSections={hidden} onChange={(nextOrder, nextHidden) => {
        save(nextOrder, nextHidden);
        setOrder(nextOrder);
        setHidden(nextHidden);
      }} itemClassName="pl-1" />;
    }
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    if (originalElementFromPoint) Object.defineProperty(document, 'elementFromPoint', originalElementFromPoint);
    else Reflect.deleteProperty(document, 'elementFromPoint');
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('toggles visibility and reorders by keyboard without losing either preference', async () => {
    const checkbox = host.querySelector<HTMLButtonElement>('[data-customize-section="files"] [role="checkbox"]')!;
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    await act(async () => checkbox.click());
    expect(save).toHaveBeenLastCalledWith(['agents', 'pinned', 'files'], []);
    const handle = host.querySelector<HTMLButtonElement>('[data-customize-section="files"] button')!;
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
    expect(save).toHaveBeenLastCalledWith(['agents', 'files', 'pinned'], []);
    expect(Array.from(host.querySelectorAll('[data-customize-section]'), (row) => row.getAttribute('data-customize-section'))).toEqual(['agents', 'files', 'pinned']);
  });

  it('keeps the drag handle functional and preserves hidden modules when reordering', async () => {
    const handle = host.querySelector<HTMLButtonElement>('[data-customize-section="agents"] button')!;
    const target = host.querySelector<HTMLElement>('[data-customize-section="pinned"]')!;
    handle.setPointerCapture = vi.fn();
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
    const dispatch = async (type: string) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientY: 10 });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      await act(async () => handle.dispatchEvent(event));
    };
    await dispatch('pointerdown');
    await dispatch('pointermove');
    await dispatch('pointerup');
    expect(save).toHaveBeenLastCalledWith(['pinned', 'agents', 'files'], ['files']);
  });
});
