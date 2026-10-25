import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoListViewTab } from '@features/memo/components/memo-list-view-tabs';
import { ListColumnGuideCard } from './list-column-guide-card';

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@features/memo/components/notebook-tree-visibility-list', () => ({
  NotebookTreeVisibilityList: () => <div data-module-visibility-list />,
}));

describe('ListColumnGuideCard', () => {
  let host: HTMLDivElement;
  let root: Root;
  let initialView: MemoListViewTab;

  beforeEach(() => {
    localStorage.clear();
    initialView = 'cards';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = false;
  });

  it.each(['close', 'done'])('remembers dismissal after %s and stays hidden after remount', async (action) => {
    await act(async () => root.render(<ListColumnGuideCard activeView="cards" onViewChange={vi.fn()} />));
    const button = action === 'close'
      ? host.querySelector<HTMLButtonElement>('[aria-label="memo.guide.close"]')
      : Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent?.includes('memo.guide.done'));
    expect(button).toBeTruthy();
    await act(async () => button!.click());
    expect(localStorage.getItem('flowix:list-column-guide:dismissed:v1')).toBe('true');
    await act(async () => root.render(<ListColumnGuideCard key="remount" activeView="cards" onViewChange={vi.fn()} />));
    expect(host.querySelector('[aria-label="memo.guide.ariaLabel"]')).toBeNull();
  });

  it('still opens and closes when local storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    await act(async () => root.render(<ListColumnGuideCard activeView="folders" onViewChange={vi.fn()} />));
    const close = host.querySelector<HTMLButtonElement>('[aria-label="memo.guide.close"]');
    expect(close).not.toBeNull();
    await act(async () => close!.click());
    expect(host.querySelector('[aria-label="memo.guide.ariaLabel"]')).toBeNull();
  });

  it('shows Get Started only on the last page, including after navigating backwards', async () => {
    function Harness() {
      const [activeView, setActiveView] = useState(initialView);
      return <ListColumnGuideCard activeView={activeView} onViewChange={setActiveView} />;
    }

    await act(async () => root.render(<Harness />));
    expect(host.textContent).toContain('memo.guide.notes.title');
    expect(host.textContent).toContain('memo.guide.notes.description');
    expect(host.textContent).toContain('memo.guide.done');

    const activate = async (label: string) => {
      const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .find((candidate) => candidate.textContent?.includes(label));
      expect(button).not.toBeNull();
      await act(async () => {
        button!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
        button!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }));
      });
    };

    await activate('memo.guide.previous');
    expect(host.textContent).toContain('memo.guide.modules.title');
    expect(host.querySelector('[data-module-visibility-list]')).not.toBeNull();
    expect(host.textContent).not.toContain('memo.guide.done');
    expect(host.textContent).toContain('memo.guide.next');

    await activate('memo.guide.previous');
    expect(host.textContent).toContain('memo.guide.fileTree.title');
    expect(host.textContent).not.toContain('memo.guide.done');

    await activate('memo.guide.next');
    expect(host.textContent).toContain('memo.guide.modules.title');
    expect(host.querySelector('[data-module-visibility-list]')).not.toBeNull();
    expect(host.textContent).not.toContain('memo.guide.done');

    await activate('memo.guide.next');
    expect(host.textContent).toContain('memo.guide.notes.title');
    expect(host.textContent).toContain('memo.guide.done');

    await activate('memo.guide.done');
    expect(host.querySelector('[aria-label="memo.guide.ariaLabel"]')).toBeNull();
  });
});
