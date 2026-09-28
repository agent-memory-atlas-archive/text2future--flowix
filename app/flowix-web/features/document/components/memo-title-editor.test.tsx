import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const titleSession = vi.hoisted(() => ({
  snapshot: {
    filename: 'Original.md',
    draft: 'Original',
    saving: false,
    error: null as string | null,
  },
  setDraft: vi.fn(),
  commit: vi.fn(() => Promise.resolve()),
  cancel: vi.fn(),
}));
const renameTitle = vi.fn(() => Promise.resolve('Original.md'));

vi.mock('./memo-title-session', () => ({
  useMemoTitleSession: () => titleSession,
}));

import { MemoTitleEditor, type MemoTitleBodyNavigation, type MemoTitleEditorHandle } from './memo-title-editor';

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(element, value);
}

function dispatchKey(
  element: HTMLTextAreaElement,
  key: string,
  keyCode?: number,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
  element.dispatchEvent(event);
  return event;
}

function dispatchPaste(element: HTMLTextAreaElement, text: string, html = ''): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  const values: Record<string, string> = {
    'text/plain': text,
    'text/html': html,
  };
  Object.defineProperty(event, 'clipboardData', {
    value: {
      types: Object.keys(values),
      files: [],
      getData(type: string) {
        return values[type] ?? '';
      },
    },
  });
  element.dispatchEvent(event);
  return event;
}

describe('MemoTitleEditor IME handling', () => {
  let container: HTMLDivElement;
  let root: Root;
  let textarea: HTMLTextAreaElement;
  let onMoveToBody: ReturnType<typeof vi.fn<(request: MemoTitleBodyNavigation) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    titleSession.commit.mockImplementation(() => Promise.resolve());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onMoveToBody = vi.fn();
    act(() => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: true,
        onMoveToBody,
      }));
    });
    textarea = container.querySelector('textarea')!;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps intermediate composition text local until compositionend', () => {
    act(() => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      setTextareaValue(textarea, 'ni');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'ni' }));
    });

    expect(textarea.value).toBe('ni');
    expect(titleSession.setDraft).not.toHaveBeenCalled();

    act(() => {
      setTextareaValue(textarea, '你');
      textarea.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true,
        data: '你',
      }));
    });

    expect(titleSession.setDraft).toHaveBeenCalledTimes(1);
    expect(titleSession.setDraft).toHaveBeenCalledWith('你');

    act(() => {
      setTextareaValue(textarea, '你');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: '你' }));
    });

    expect(titleSession.setDraft).toHaveBeenCalledTimes(1);
  });

  it('does not move to the body when Enter confirms an active composition', () => {
    act(() => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      dispatchKey(textarea, 'Enter', 13);
    });

    expect(titleSession.commit).not.toHaveBeenCalled();
    expect(onMoveToBody).not.toHaveBeenCalled();
  });

  it('does not move to the body for WebKit process-key 229', () => {
    act(() => {
      dispatchKey(textarea, 'Enter', 229);
    });

    expect(titleSession.commit).not.toHaveBeenCalled();
    expect(onMoveToBody).not.toHaveBeenCalled();
  });

  it('moves to the body for an ordinary Enter after composition', async () => {
    setTextareaValue(textarea, 'Title tail');
    textarea.setSelectionRange(5, 5);

    await act(async () => {
      const event = dispatchKey(textarea, 'Enter', 13);
      expect(event.defaultPrevented).toBe(true);
      await Promise.resolve();
    });

    expect(titleSession.setDraft).toHaveBeenCalledWith('Title');
    expect(titleSession.commit).toHaveBeenCalledTimes(1);
    expect(onMoveToBody).toHaveBeenCalledWith({
      trailingContent: ' tail',
      insertEmptyLine: true,
    });
  });

  it('moves to the body before the title rename finishes', () => {
    titleSession.commit.mockImplementation(() => new Promise(() => {}));
    setTextareaValue(textarea, 'Title tail');
    textarea.setSelectionRange(5, 5);

    act(() => dispatchKey(textarea, 'Enter', 13));

    expect(titleSession.commit).toHaveBeenCalledTimes(1);
    expect(onMoveToBody).toHaveBeenCalledWith({
      trailingContent: ' tail',
      insertEmptyLine: true,
    });
  });

  it('accepts a body-to-title merge before the title rename finishes', () => {
    titleSession.commit.mockImplementation(() => new Promise(() => {}));
    const editorRef = createRef<MemoTitleEditorHandle>();
    act(() => {
      root.render(createElement(MemoTitleEditor, {
        ref: editorRef,
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: true,
        onMoveToBody,
      }));
    });

    let accepted = false;
    act(() => { accepted = editorRef.current?.appendBodyLine('First line') ?? false; });

    expect(accepted).toBe(true);
    expect(titleSession.setDraft).toHaveBeenCalledWith('OriginalFirst line');
    expect(titleSession.commit).toHaveBeenCalledTimes(1);
  });

  it('keeps title-to-body navigation available when read-only', async () => {
    await act(async () => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: false,
        allowReadOnlyBoundaryNavigation: true,
        onMoveToBody,
      }));
    });

    const readOnlyTextarea = container.querySelector('textarea')!;
    readOnlyTextarea.setSelectionRange(readOnlyTextarea.value.length, readOnlyTextarea.value.length);
    const event = dispatchKey(readOnlyTextarea, 'ArrowDown');

    expect(event.defaultPrevented).toBe(true);
    expect(titleSession.commit).not.toHaveBeenCalled();
    expect(onMoveToBody).toHaveBeenCalledWith({ insertEmptyLine: false });
  });

  it('does not enable read-only boundary navigation without the mode opt-in', async () => {
    await act(async () => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: false,
        onMoveToBody,
      }));
    });

    const readOnlyTextarea = container.querySelector('textarea')!;
    readOnlyTextarea.setSelectionRange(readOnlyTextarea.value.length, readOnlyTextarea.value.length);
    const event = dispatchKey(readOnlyTextarea, 'ArrowDown');

    expect(event.defaultPrevented).toBe(false);
    expect(onMoveToBody).not.toHaveBeenCalled();
  });

  it('does not cancel title editing when Escape belongs to the IME', () => {
    act(() => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      dispatchKey(textarea, 'Escape', 229);
    });

    expect(titleSession.cancel).not.toHaveBeenCalled();
  });

  it('uses a document-selection surface in source mode', async () => {
    await act(async () => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: true,
        useDocumentSelection: true,
        onMoveToBody,
      }));
    });

    const title = container.querySelector<HTMLElement>('.memo-title-editor--document-selection');
    expect(title?.tagName).toBe('DIV');
    expect(title?.getAttribute('contenteditable')).toBe('plaintext-only');
    expect(container.querySelector('textarea')).toBeNull();
  });
});

describe('MemoTitleEditor title paste splitting', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('uses the first line as the title and routes the rest to the body', () => {
    const onPasteToBody = vi.fn();
    act(() => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: true,
        onMoveToBody: vi.fn(),
        onPasteToBody,
      }));
    });

    const textarea = container.querySelector('textarea')!;
    textarea.select();
    const event = dispatchPaste(textarea, 'Pasted title\nFirst body line\nSecond body line');

    expect(event.defaultPrevented).toBe(true);
    expect(titleSession.setDraft).toHaveBeenCalledWith('Pasted title');
    expect(onPasteToBody).toHaveBeenCalledWith(expect.objectContaining({
      text: 'First body line\nSecond body line',
    }));
  });
});
