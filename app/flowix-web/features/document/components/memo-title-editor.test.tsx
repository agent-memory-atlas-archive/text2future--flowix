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
  commit: vi.fn(() => Promise.resolve(true)),
  cancel: vi.fn(),
}));
const renameTitle = vi.fn(() => Promise.resolve('Original.md'));

vi.mock('./memo-title-session', () => ({
  useMemoTitleSession: () => titleSession,
}));

import { useSettingsStore } from '@/lib/store/settings-store';

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

/** Minimal DOMRect stand-in for stubbing layout in jsdom. */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function dispatchPaste(element: HTMLTextAreaElement, text: string, html = ''): ClipboardEvent {  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
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
    titleSession.commit.mockImplementation(() => Promise.resolve(true));
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

  it.each([true, false])('waits for the rename result (%s) before accepting a body-to-title merge', async (saved) => {
    let finish!: (saved: boolean) => void;
    titleSession.commit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
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

    let accepted: boolean | undefined;
    let merging!: Promise<boolean>;
    act(() => {
      merging = editorRef.current!.appendBodyLine('First line');
      void merging.then(value => { accepted = value; });
    });
    expect(accepted).toBeUndefined();
    expect(titleSession.setDraft).toHaveBeenCalledWith('OriginalFirst line');
    expect(titleSession.commit).toHaveBeenCalledTimes(1);
    await act(async () => { finish(saved); await merging; });
    expect(accepted).toBe(saved);
  });

  it('coalesces repeated body-to-title merges while the rename is pending', async () => {
    let finish!: (saved: boolean) => void;
    titleSession.commit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
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

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = editorRef.current!.appendBodyLine('First line');
      second = editorRef.current!.appendBodyLine('First line');
    });

    expect(titleSession.setDraft).toHaveBeenCalledTimes(1);
    expect(titleSession.setDraft).toHaveBeenCalledWith('OriginalFirst line');
    expect(titleSession.commit).toHaveBeenCalledTimes(1);
    await act(async () => { finish(true); await Promise.all([first, second]); });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
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

describe('MemoTitleEditor autofocus', () => {
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
    window.getSelection()?.removeAllRanges();
  });

  it('places a collapsed caret at the end of the title instead of selecting it', () => {
    act(() => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: true,
        autoFocus: true,
        onMoveToBody: vi.fn(),
      }));
    });

    const textarea = container.querySelector('textarea')!;
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });

  it('collapses the document selection surface caret at the title end', () => {
    act(() => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: true,
        autoFocus: true,
        useDocumentSelection: true,
        onMoveToBody: vi.fn(),
      }));
    });

    const title = container.querySelector<HTMLElement>('.memo-title-editor--document-selection')!;
    const selection = window.getSelection();
    expect(selection?.rangeCount).toBe(1);
    const range = selection!.getRangeAt(0);
    expect(range.collapsed).toBe(true);
    expect(title.contains(range.startContainer)).toBe(true);
    const prefix = document.createRange();
    prefix.selectNodeContents(title);
    prefix.setEnd(range.startContainer, range.startOffset);
    expect(prefix.toString()).toBe(title.textContent);
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

describe('MemoTitleEditor property controls', () => {
  let container: HTMLDivElement;
  let root: Root;
  let initialPropertiesVisible: boolean;

  const renderTitle = (editable = true) => {
    act(() => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable,
        onMoveToBody: vi.fn(),
      }));
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    initialPropertiesVisible = useSettingsStore.getState().propertiesVisible;
    useSettingsStore.setState({ propertiesVisible: false });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    renderTitle();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useSettingsStore.setState({ propertiesVisible: initialPropertiesVisible });
  });

  const openPopup = (
    eventName: 'flowix:open-property-picker' | 'flowix:open-add-property',
    propertyTargetId = 'file:display:title-test',
  ) => {
    act(() => {
      window.dispatchEvent(new CustomEvent(eventName, {
        detail: { propertyTargetId, anchorRect: rect(104, 128, 172, 28) },
      }));
    });
  };

  const picker = () => document.body.querySelector<HTMLElement>('.property-preset-menu-content');
  const preset = (label: string) =>
    Array.from(picker()!.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'))
      .find((button) => button.querySelector('span')?.textContent === label)!;

  const withRequests = (eventName: string, run: (requests: unknown[]) => void) => {
    const requests: unknown[] = [];
    const listener = (event: Event) => requests.push((event as CustomEvent).detail);
    window.addEventListener(eventName, listener);
    try {
      run(requests);
    } finally {
      window.removeEventListener(eventName, listener);
    }
  };

  const withOccupiedKeys = (keys: string[], run: () => void) => {
    const responder = (event: Event) => {
      const detail = (event as CustomEvent<{ propertyTargetId: string; keys: string[] }>).detail;
      if (detail.propertyTargetId === 'file:display:title-test') detail.keys.push(...keys);
    };
    window.addEventListener('flowix:query-occupied-property-keys', responder);
    try {
      run();
    } finally {
      window.removeEventListener('flowix:query-occupied-property-keys', responder);
    }
  };

  it('toggles property visibility without opening the preset picker', () => {
    const button = container.querySelector<HTMLButtonElement>('.memo-title-properties-toggle')!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    act(() => button.click());
    expect(useSettingsStore.getState().propertiesVisible).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.dataset.state).toBe('visible');
    expect(picker()).toBeNull();
    act(() => button.click());
    expect(useSettingsStore.getState().propertiesVisible).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('opens the preset picker for the requested document', () => {
    openPopup('flowix:open-property-picker');
    expect(picker()).not.toBeNull();
    expect(preset('标签').getAttribute('aria-pressed')).toBe('false');
    expect(preset('标签').disabled).toBe(false);
  });

  it('ignores popup requests for other documents', () => {
    openPopup('flowix:open-property-picker', 'file:another-note');
    openPopup('flowix:open-add-property', 'file:another-note');
    expect(picker()).toBeNull();
    expect(document.body.querySelector('.memo-title-add-property')).toBeNull();
  });

  it('does not open property editing popups for a read-only document', () => {
    renderTitle(false);
    openPopup('flowix:open-property-picker');
    openPopup('flowix:open-add-property');
    expect(picker()).toBeNull();
    expect(document.body.querySelector('.memo-title-add-property')).toBeNull();
  });

  it('adds the selected preset to the requested document and closes the picker', () => {
    withRequests('flowix:add-property', (requests) => {
      openPopup('flowix:open-property-picker');
      act(() => preset('标签').click());
      expect(requests).toEqual([{ propertyTargetId: 'file:display:title-test', presetKey: 'tags' }]);
      // The popover stays mounted until its exit animation completes.
      expect(picker()?.dataset.motionState).toBe('closing');
    });
  });

  it('marks existing presets as selected while keeping them actionable', () => {
    withOccupiedKeys(['tags', 'flowix_colors'], () => openPopup('flowix:open-property-picker'));
    expect(preset('标签').getAttribute('aria-pressed')).toBe('true');
    expect(preset('颜色').getAttribute('aria-pressed')).toBe('true');
    expect(preset('标签').disabled).toBe(false);
    expect(preset('描述').getAttribute('aria-pressed')).toBe('false');
  });

  it('removes an existing preset instead of adding a duplicate', () => {
    withRequests('flowix:add-property', (adds) => {
      withRequests('flowix:remove-property', (removals) => {
        withOccupiedKeys(['tags'], () => openPopup('flowix:open-property-picker'));
        act(() => preset('标签').click());
        expect(adds).toEqual([]);
        expect(removals).toEqual([{ propertyTargetId: 'file:display:title-test', propertyKey: 'tags' }]);
        expect(picker()?.dataset.motionState).toBe('closing');
      });
    });
  });

  it('opens the add-property form through its dedicated entry point', () => {
    openPopup('flowix:open-add-property');
    expect(document.body.querySelector('.memo-title-add-property')).not.toBeNull();
    expect(picker()).toBeNull();
  });
});
