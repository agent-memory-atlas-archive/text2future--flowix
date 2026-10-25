import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import { NoteCreatePicker } from './note-create-picker';

const notes = [
  { title: '项目计划', relativePath: '项目/计划.md' },
  { title: '读书记录', relativePath: '读书.md' },
] as NoteEntry[];
let root: Root | null = null;
let mountedContainer: HTMLDivElement | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; mountedContainer?.remove(); mountedContainer = null; vi.restoreAllMocks(); });

function render(value = '', allowSelect = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  mountedContainer = container;
  root = createRoot(container);
  const onCreate = vi.fn();
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  act(() => root?.render(<NoteCreatePicker value={value} onChange={vi.fn()} notes={notes}
    allowSelect={allowSelect} onCreate={onCreate} onSelect={onSelect} onCancel={onCancel} />));
  return { container, textarea: container.querySelector('textarea')!, onCreate, onSelect, onCancel };
}

describe('shared note creation and selection', () => {
  it('uses the same placeholder for creation-only and searchable entry points', () => {
    const view = render('', false);
    // 占位文案改成了「笔记名称」（创建/搜索两个入口共用同一个）。
    expect(view.textarea.placeholder).toBe('笔记名称');
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('filters existing notes by the creation input, including their paths', () => {
    const view = render('项目/');
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(view.container.querySelector('[role="option"]')?.textContent).toBe('项目计划');
    expect(view.container.querySelector('input[type="search"]')).toBeNull();
  });

  it('selects a filtered note with arrow keys and Enter without creating a duplicate', () => {
    const view = render('项目');
    const option = view.container.querySelector<HTMLElement>('[role="option"]')!;
    option.scrollIntoView = vi.fn();
    act(() => view.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    expect(option.getAttribute('aria-selected')).toBe('true');
    act(() => view.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(view.onSelect).toHaveBeenCalledWith(notes[0]);
    expect(view.onCreate).not.toHaveBeenCalled();
  });

  it('creates explicitly with Enter, leaves Shift+Enter for newlines, and cancels without creating', () => {
    const view = render('新名称');
    const newline = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    act(() => view.textarea.dispatchEvent(newline));
    expect(newline.defaultPrevented).toBe(false);
    expect(view.onCreate).not.toHaveBeenCalled();
    act(() => view.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(view.onCreate).toHaveBeenCalledOnce();
    act(() => view.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(view.onCancel).toHaveBeenCalledOnce();
    expect(view.onCreate).toHaveBeenCalledOnce();
  });

  it('keeps arrows, wrapping and Enter working after Tab transfers focus into a candidate', () => {
    const view = render();
    const options = [...view.container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    options.forEach((option) => { option.scrollIntoView = vi.fn(); });
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => view.textarea.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);
    // jsdom does not perform the browser's default Tab focus transfer.
    act(() => options[0].focus());
    expect(options[0].getAttribute('aria-selected')).toBe('true');

    const press = (key: string) => act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    press('ArrowDown');
    expect(document.activeElement).toBe(options[1]);
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    expect(options[1].scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    press('ArrowDown');
    expect(document.activeElement).toBe(options[0]);
    press('ArrowUp');
    expect(document.activeElement).toBe(options[1]);
    press('Enter');
    expect(view.onSelect).toHaveBeenCalledExactlyOnceWith(notes[1]);
    expect(view.onCreate).not.toHaveBeenCalled();
    press('Escape');
    expect(view.onCancel).toHaveBeenCalledOnce();
  });
});
