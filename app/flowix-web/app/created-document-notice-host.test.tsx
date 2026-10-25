import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreatedDocumentNoticeHost } from './created-document-notice-host';
import { notifyCreatedDocument, useCreatedDocumentNotices, moveCreatedDocumentNotices, removeCreatedDocumentNotices } from './created-document-notices';
import { openCreatedDocumentFromNotice } from '@features/workspace/public/app-api';
vi.mock('@features/workspace/public/app-api', () => ({ openCreatedDocumentFromNotice: vi.fn() }));
vi.mock('@/lib/i18n', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/i18n')>(), useI18n: () => ({ t: (key: string) => key }) }));

describe('persistent created document cards', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.resetAllMocks();
    useCreatedDocumentNotices.setState({ notices: [] });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });
  afterEach(async () => { vi.useRealTimers(); await act(async () => root.unmount()); vi.unstubAllGlobals(); host.remove(); });
  const add = (name: string) => notifyCreatedDocument(`/notes/${name}.md`, '/notes', 'nb');
  const button = (text: string) => Array.from(host.querySelectorAll('button')).find((el) => el.textContent?.includes(text))!;
  it('deduplicates events, stacks to one, expands and dismisses without navigating', async () => {
    await act(async () => {
      for (let i = 0; i < 6; i++) add(String(i));
      add('5');
      root.render(<CreatedDocumentNoticeHost />);
    });
    expect(host.querySelectorAll('section:not([aria-hidden="true"])')).toHaveLength(1);
    expect(useCreatedDocumentNotices.getState().notices).toHaveLength(6);
    expect(openCreatedDocumentFromNotice).not.toHaveBeenCalled();
    await act(async () => host.querySelector('aside')!.focus());
    expect(host.querySelectorAll('section:not([aria-hidden="true"])')).toHaveLength(6);
    await act(async () => host.querySelector<HTMLButtonElement>('section button')!.click());
    expect(host.querySelectorAll('section:not([aria-hidden="true"])')).toHaveLength(5);
    expect(openCreatedDocumentFromNotice).not.toHaveBeenCalled();
  });
  it('expands on mouse hover and delays collapse across card gaps', async () => {
    vi.useFakeTimers();
    await act(async () => { add('First'); add('Second'); root.render(<CreatedDocumentNoticeHost />); });
    const region = host.querySelector('aside')!;
    const pointer = (type: string) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      region.dispatchEvent(event);
    };
    expect(host.querySelector('.created-document-notice-toolbar')?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => pointer('pointerover'));
    expect(host.querySelector('.created-document-notice-toolbar')?.getAttribute('aria-hidden')).toBe('false');
    expect(host.querySelectorAll('section:not([aria-hidden="true"])')).toHaveLength(2);
    await act(async () => { pointer('pointerout'); vi.advanceTimersByTime(100); });
    expect(host.querySelectorAll('section:not([aria-hidden="true"])')).toHaveLength(2);
    await act(async () => { pointer('pointerover'); vi.advanceTimersByTime(200); });
    expect(host.querySelectorAll('section:not([aria-hidden="true"])')).toHaveLength(2);
    await act(async () => { pointer('pointerout'); vi.advanceTimersByTime(180); });
    expect(host.querySelectorAll('section:not([aria-hidden="true"])')).toHaveLength(1);
  });
  it('collapses after a mouse click retains focus and opening is cancelled', async () => {
    vi.useFakeTimers();
    vi.mocked(openCreatedDocumentFromNotice).mockResolvedValue(false);
    await act(async () => { add('First'); add('Second'); root.render(<CreatedDocumentNoticeHost />); });
    const region = host.querySelector('aside')!;
    const pointer = (target: Element, type: string) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      target.dispatchEvent(event);
    };
    await act(async () => pointer(region, 'pointerover'));
    const open = button('createdDocuments.open');
    await act(async () => { pointer(open, 'pointerdown'); open.focus(); open.click(); });
    await act(async () => { pointer(region, 'pointerout'); vi.advanceTimersByTime(180); });
    expect(region.dataset.expanded).toBe('false');
  });
  it('restores keyboard expansion when Tab originates outside after pointer interaction', async () => {
    await act(async () => { add('Draft'); root.render(<CreatedDocumentNoticeHost />); });
    const region = host.querySelector('aside')!;
    await act(async () => region.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      region.focus();
    });
    expect(region.dataset.expanded).toBe('true');
  });
  it('hides the toolbar until keyboard focus expands the stack', async () => {
    vi.useFakeTimers();
    await act(async () => { add('First'); add('Second'); root.render(<CreatedDocumentNoticeHost />); });
    expect(host.querySelector('.created-document-notice-toolbar')?.getAttribute('aria-hidden')).toBe('true');
    expect(button('createdDocuments.clear').closest('[inert]')).not.toBeNull();
    await act(async () => host.querySelector('aside')!.focus());
    expect(host.querySelectorAll('section:not([aria-hidden="true"])')).toHaveLength(2);
    expect(host.querySelector('.created-document-notice-toolbar')?.getAttribute('aria-hidden')).toBe('false');
    await act(async () => {
      host.querySelector('aside')!.dispatchEvent(new Event('pointerout', { bubbles: true }));
      vi.advanceTimersByTime(180);
    });
    expect(host.querySelector('aside')?.dataset.expanded).toBe('true');
    await act(async () => host.querySelector('aside')!.blur());
    expect(host.querySelectorAll('section:not([aria-hidden="true"])')).toHaveLength(1);
    await act(async () => host.querySelector('aside')!.focus());
    expect(host.querySelectorAll('section:not([aria-hidden="true"])')).toHaveLength(2);
    await act(async () => host.querySelector('aside')!.blur());
    expect(host.querySelectorAll('section:not([aria-hidden="true"])')).toHaveLength(1);
  });
  it('limits the initial card DOM while preserving every notification for older pages', async () => {
    await act(async () => {
      for (let i = 0; i < 100; i++) add(String(i));
      root.render(<CreatedDocumentNoticeHost />);
    });
    expect(host.querySelectorAll('section')).toHaveLength(20);
    expect(useCreatedDocumentNotices.getState().notices).toHaveLength(100);
    await act(async () => host.querySelector('aside')!.focus());
    expect(host.querySelector('section')?.textContent).toContain('99');
    await act(async () => button('createdDocuments.showOlder').click());
    expect(host.querySelectorAll('section')).toHaveLength(40);
    expect(useCreatedDocumentNotices.getState().notices).toHaveLength(100);
    await act(async () => button('createdDocuments.clear').click());
    await act(async () => add('New batch'));
    expect(host.querySelectorAll('section')).toHaveLength(1);
    expect(host.querySelector('aside')?.dataset.expanded).toBe('false');
  });
  it('retains card size observers through opening and retry state changes', async () => {
    const disconnect = vi.fn();
    const observer = vi.fn(function () { return { observe: vi.fn(), disconnect }; });
    vi.stubGlobal('ResizeObserver', observer);
    vi.mocked(openCreatedDocumentFromNotice).mockRejectedValueOnce(new Error('offline'));
    await act(async () => { add('Draft'); root.render(<CreatedDocumentNoticeHost />); });
    expect(observer).toHaveBeenCalledTimes(1);
    const card = host.querySelector('section');
    await act(async () => button('createdDocuments.open').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('offline');
    expect(host.querySelector('section')).toBe(card);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });
  it('keeps errors for retry and removes the card only after successful navigation', async () => {
    vi.mocked(openCreatedDocumentFromNotice).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(true);
    await act(async () => { add('Draft'); root.render(<CreatedDocumentNoticeHost />); });
    await act(async () => button('createdDocuments.open').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('offline');
    await act(async () => button('createdDocuments.open').click());
    expect(openCreatedDocumentFromNotice).toHaveBeenLastCalledWith('/notes/Draft.md', '/notes', 'nb');
    expect(host.querySelector('aside')).toBeNull();
  });
  it('disables repeat opens and retains cards when navigation is cancelled', async () => {
    let finish!: (value: boolean) => void;
    vi.mocked(openCreatedDocumentFromNotice).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { add('Draft'); root.render(<CreatedDocumentNoticeHost />); });
    await act(async () => button('createdDocuments.open').click());
    expect(button('createdDocuments.opening').disabled).toBe(true);
    await act(async () => finish(false));
    expect(host.querySelectorAll('section:not([aria-hidden="true"])')).toHaveLength(1);
    expect(button('createdDocuments.open').disabled).toBe(false);
  });
  it('rebases pending cards on folder moves and clears deleted files', async () => {
    await act(async () => {
      add('folder/Draft');
      moveCreatedDocumentNotices('/notes/folder', '/notes/renamed', true);
      root.render(<CreatedDocumentNoticeHost />);
    });
    expect(host.textContent).toContain('renamed');
    expect(host.textContent).toContain('Draft');
    await act(async () => removeCreatedDocumentNotices('/notes/renamed'));
    expect(host.querySelector('aside')).toBeNull();
  });
});
