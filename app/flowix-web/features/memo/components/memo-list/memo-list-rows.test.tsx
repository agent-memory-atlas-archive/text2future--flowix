import { act, useCallback, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteListItem } from '@/types/note-item';
import { MemoListRows, type MemoRowKeepAliveChange } from './memo-list-rows';

const notes: NoteListItem[] = Array.from({ length: 5000 }, (_, i) => ({
  kind: 'path-note', notebookId: 'book', relativePath: `${i}.md`, filename: `${i}.md`,
  title: String(i), preview: '', thumbnail: null, tags: [], todos: [], agents: [],
  createdAt: 0, updatedAt: 0, favorited: false, icon: null, colors: [], properties: {},
}));

function Row({ item, onKeepAliveChange }: { item: NoteListItem; onKeepAliveChange: MemoRowKeepAliveChange }) {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) return;
    onKeepAliveChange(item, true);
    return () => onKeepAliveChange(item, false);
  }, [item, editing, onKeepAliveChange]);
  return <button data-path={item.relativePath} onClick={() => setEditing((value) => !value)}>{editing ? 'editing' : item.title}</button>;
}

function Harness({ items = notes, measurable = true }: { items?: NoteListItem[]; measurable?: boolean }) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const setScroller = useCallback((element: HTMLDivElement | null) => {
    setScrollElement(element);
    if (!element) return;
    element.scrollTo = ((options: ScrollToOptions) => {
      element.scrollTop = options.top ?? element.scrollTop;
      element.dispatchEvent(new Event('scroll'));
    }) as typeof element.scrollTo;
    Object.defineProperties(element, {
      clientWidth: { configurable: true, value: measurable ? 320 : 0 },
      clientHeight: { configurable: true, value: measurable ? 336 : 0 },
      scrollHeight: { configurable: true, get: () => Number.parseFloat((element.firstElementChild as HTMLElement)?.style.height || '0') },
    });
  }, [measurable]);
  return <div ref={setScroller}><MemoListRows items={items} scrollElement={scrollElement} queryKey="book:all"
    renderRow={(item, onKeepAliveChange) => <Row item={item} onKeepAliveChange={onKeepAliveChange} />} /></div>;
}

let root: Root;
let container: HTMLDivElement;
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 320, this.hasAttribute('data-index') ? 112 : 336);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  container.remove();
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});

async function scrollTo(top: number) {
  const scroller = container.firstElementChild as HTMLDivElement;
  await act(async () => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event('scroll'));
  });
  return scroller;
}

describe('memo list mounted rows', () => {
  it('bounds mounting for 5000 notes before the hidden viewport can be measured', async () => {
    await act(async () => root.render(<Harness measurable={false} />));
    expect(container.querySelectorAll('[data-path]').length).toBe(16);
  });

  it('mounts the scrolled range while keeping the DOM bounded', async () => {
    await act(async () => root.render(<Harness />));
    expect(container.querySelectorAll('[data-path]').length).toBeLessThan(40);
    await scrollTo(112 * 100);
    expect(container.querySelector('[data-path="100.md"]')).not.toBeNull();
    expect(container.querySelector('[data-path="0.md"]')).toBeNull();
    expect(container.querySelectorAll('[data-path]').length).toBeLessThan(40);
  });

  it('retains an interactive row outside the viewport and releases it when closed', async () => {
    await act(async () => root.render(<Harness />));
    const row = container.querySelector<HTMLButtonElement>('[data-path="0.md"]')!;
    await act(async () => row.click());
    await scrollTo(112 * 100);
    expect(container.querySelector('[data-path="0.md"]')?.textContent).toBe('editing');
    await act(async () => row.click());
    expect(container.querySelector('[data-path="0.md"]')).toBeNull();
  });

  it('keeps the viewport and selected row mounted when the next page arrives', async () => {
    await act(async () => root.render(<Harness items={notes.slice(0, 50)} />));
    const scroller = await scrollTo(112 * 40);
    const row = container.querySelector<HTMLButtonElement>('[data-path="41.md"]')!;
    await act(async () => row.click());
    await act(async () => root.render(<Harness items={notes.slice(0, 100)} />));
    expect(scroller.scrollTop).toBe(112 * 40);
    expect(container.querySelector('[data-path="41.md"]')?.textContent).toBe('editing');
  });
  it('keeps visible notes at the same offset when a row above is inserted or removed', async () => {
    await act(async () => root.render(<Harness />));
    const scroller = await scrollTo(112 * 100);
    const inserted = { ...notes[0], relativePath: 'inserted.md' };
    await act(async () => root.render(<Harness items={[inserted, ...notes]} />));
    expect(scroller.scrollTop).toBe(112 * 101);
    expect(container.querySelector('[data-path="100.md"]')).not.toBeNull();
    await act(async () => root.render(<Harness items={notes} />));
    expect(scroller.scrollTop).toBe(112 * 100);
  });

});
